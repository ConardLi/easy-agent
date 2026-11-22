import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimeScope, runInRuntimeScope, disposeRuntimeScope } from "../state/runtimeScope.js";
import {
  installConfigurationEnvironment,
  configurationEnvironment,
  getEnvironmentLoadReport,
} from "../config/environment.js";
import { loadProfiles, resolveProfile, resolveProfileConfiguration } from "../services/api/providers/profile.js";
import { loadEnv } from "../utils/loadEnv.js";
import { setFlagSettings, resetSettingsCache } from "../config/sources.js";
import { trustProjectForSession } from "../config/globalState.js";
import { resolveHarnessFromInputs } from "../harness/resolve.js";
import { withHarness } from "../harness/active.js";
import { prepareRequest } from "../services/api/providers/providerStream.js";
import { buildDefaultThinkingConfig } from "../utils/thinking.js";
import { createAgentRuntime } from "../sdk/runtime.js";
import { updateUserSettings } from "../utils/settings.js";

async function fixture(fn: (root: string, workspace: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagent-config-lifecycle-"));
  const before = { ...process.env };
  for (const name of Object.keys(process.env)) if (name.startsWith("EASY_AGENT_")) delete process.env[name];
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(root, ".easy-agent"), { recursive: true });
  await mkdir(path.join(workspace, ".easy-agent"), { recursive: true });
  setFlagSettings(null);
  try {
    await fn(root, workspace);
  } finally {
    setFlagSettings(null);
    for (const name of Object.keys(process.env)) if (!(name in before)) delete process.env[name];
    Object.assign(process.env, before);
    await rm(root, { recursive: true, force: true });
  }
}
const write = (file: string, value: unknown) => writeFile(file, JSON.stringify(value, null, 2));
const localProfile = { protocol: "openai-chat", model: "fixture", authentication: { type: "none" } };
const options = { services: false as const, hardenPrivateData: false, logger: { warn() {}, error() {} } };

for (const kind of ["settings", "default-harness", "implicit-protocol"] as const)
  test(`${kind} can be inspected but cannot execute a credential helper before repair`, async () =>
    fixture(async (root, cwd) => {
      const file = path.join(root, ".easy-agent", "settings.json");
      const marker = path.join(root, "helper-ran");
      const helper = `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync(process.argv[1], 'ran')" ${JSON.stringify(marker)}`;
      await write(file, {
        model: "main",
        models: {
          main: { protocol: kind === "implicit-protocol" ? undefined : "anthropic", model: "m", apiKey: { helper } },
        },
        ...(kind === "settings" ? { unknownOption: "private-value" } : {}),
        ...(kind === "default-harness" ? { harnesses: { default: { features: { unknownOption: true } } } } : {}),
      });
      const original = await readFile(file, "utf8");
      const runtime = await createAgentRuntime({ ...options, cwd });
      try {
        const config = await runtime.readConfig();
        assert.equal(JSON.stringify(config).includes("private-value"), false);
        await assert.rejects(runtime.hasModelCredentials("main"), /unknown|Unrecognized|protocol/i);
        await assert.rejects(resolveProfile("main", cwd), /unknown|Unrecognized|protocol/i);
        await assert.rejects(readFile(marker), { code: "ENOENT" });
        if (kind === "settings") await assert.rejects(updateUserSettings({ language: "zh" }, cwd), /unknown setting/i);
        assert.equal(await readFile(file, "utf8"), original);
        assert.deepEqual(await readdir(path.dirname(file)), ["settings.json"]);
      } finally {
        await runtime.dispose();
      }
    }));

test("invalid selected and inline Harness specs fail startup", async () =>
  fixture(async (root, cwd) => {
    const spec = { features: { unknownOption: true } };
    await write(path.join(root, ".easy-agent", "settings.json"), { harnesses: { custom: spec } });
    for (const harness of [{ name: "custom" }, { spec }])
      await assert.rejects(createAgentRuntime({ ...options, cwd, harness }), /Unrecognized/i);
  }));

test("invalid live edits retain the entire last valid source and visible diagnostics", async () =>
  fixture(async (root, cwd) => {
    const file = path.join(root, ".easy-agent", "settings.json");
    const current = { model: "main", models: { main: localProfile }, language: "en" };
    await write(file, current);
    const runtime = await createAgentRuntime({ ...options, cwd });
    try {
      assert.equal(await runtime.hasModelCredentials(), true);
      await write(file, { ...current, language: "zh", unknownOption: false });
      resetSettingsCache();
      assert.equal(await runtime.hasModelCredentials(), true);
      const source = (await runtime.readConfig()).sources.find((source) => source.source === "user")!;
      assert.equal(source.values.language, "en");
      assert.match(source.validationErrors?.join(" ") ?? "", /unknown setting.*last valid source/);
      await assert.rejects(updateUserSettings({ language: "fr" }, cwd), /unknown setting/);
      await updateUserSettings({ unknownOption: undefined }, cwd);
      assert.equal(
        (await runtime.readConfig()).sources.find((source) => source.source === "user")?.values.language,
        "zh",
      );
    } finally {
      await runtime.dispose();
    }
  }));

test("sequential runtimes restore injected variables and recapture the changed parent", async () =>
  fixture(async (root, cwd) => {
    const user = path.join(root, ".easy-agent", "settings.json");
    await write(user, { models: { first: localProfile }, env: { ONLY_RUNTIME_A: "a" } });
    let runtime = await createAgentRuntime({ ...options, cwd });
    try {
      assert.equal(await runtime.resolveModel(), "first");
      assert.equal(process.env.ONLY_RUNTIME_A, "a");
      assert.equal(await runtime.hasModelCredentials(), true);
      process.env.EXTERNAL_EDIT = "kept";
    } finally {
      await runtime.dispose();
    }
    assert.equal(process.env.ONLY_RUNTIME_A, undefined);
    await write(user, { models: { second: { ...localProfile, model: "next" } } });
    process.env.EASY_AGENT_PROFILE = "second";
    runtime = await createAgentRuntime({ ...options, cwd });
    try {
      assert.equal(await runtime.resolveModel(), "second");
      assert.equal(configurationEnvironment().ONLY_RUNTIME_A, undefined);
      assert.equal(configurationEnvironment().EXTERNAL_EDIT, "kept");
    } finally {
      await runtime.dispose();
    }
  }));

test("trusted project cannot replace a parent credential with an arbitrary referenced name", async () =>
  fixture(async (root, cwd) => {
    const scope = createRuntimeScope();
    process.env.NONSTANDARD_NAME = "parent";
    await write(path.join(root, ".easy-agent", "settings.json"), {
      models: { main: { protocol: "gemini", model: "custom", apiKey: "${NONSTANDARD_NAME}" } },
    });
    await write(path.join(cwd, ".easy-agent", "settings.json"), { env: { NONSTANDARD_NAME: "project" } });
    await writeFile(path.join(cwd, ".env"), "NONSTANDARD_NAME=dotenv\n");
    try {
      await runInRuntimeScope(scope, async () => {
        await loadEnv(cwd, { allowProject: true });
        assert.equal((await resolveProfile("main", cwd)).apiKey, "parent");
        assert.equal(getEnvironmentLoadReport()?.protectedCredentialOverrides.project, 1);
        assert.equal(getEnvironmentLoadReport()?.protectedCredentialOverrides.dotenv, 1);
      });
    } finally {
      await disposeRuntimeScope(scope);
    }
  }));

test("higher connection layer is complete and partial profile overrides keep their protocol", async () =>
  fixture(async (root, cwd) => {
    await write(path.join(root, ".easy-agent", "settings.json"), {
      env: { EASY_AGENT_PROTOCOL: "anthropic", EASY_AGENT_MODEL: "old", EASY_AGENT_API_KEY: "old-secret" },
      models: {
        main: {
          protocol: "openai-responses",
          model: "upstream",
          apiKey: "${CUSTOM}",
          authentication: { type: "header", name: "X-Custom" },
          headers: { "x-route": "old" },
          protocolOptions: { "openai-responses": { promptCacheKey: true } },
        },
      },
    });
    process.env.EASY_AGENT_PROTOCOL = "gemini";
    process.env.EASY_AGENT_MODEL = "new";
    const scope = createRuntimeScope();
    try {
      await runInRuntimeScope(scope, async () => {
        await loadEnv(cwd);
        assert.equal(configurationEnvironment().EASY_AGENT_API_KEY, undefined);
        assert.equal((await loadProfiles(cwd)).profiles["@environment"]?.protocol, "gemini");
        installConfigurationEnvironment({ CUSTOM: "original", NEW: "new-key" });
        await trustProjectForSession(cwd);
        const file = path.join(cwd, ".easy-agent", "settings.json");
        await write(file, { models: { main: { model: "next", maxTokens: 8000 } } });
        resetSettingsCache();
        assert.equal((await resolveProfile("main", cwd)).protocol, "openai-responses");
        await write(file, { models: { main: { protocol: "gemini", apiKey: "${NEW}" } } });
        resetSettingsCache();
        const profile = await resolveProfile("main", cwd);
        assert.equal(profile.apiKey, "new-key");
        for (const key of ["protocolOptions", "authentication", "headers", "baseURL"] as const)
          assert.equal(profile[key], undefined);
      });
    } finally {
      await disposeRuntimeScope(scope);
    }
  }));

test("no-profile startup supports configuration and inspection never executes helpers", async () =>
  fixture(async (root, cwd) => {
    const runtime = await createAgentRuntime({ ...options, cwd });
    try {
      assert.equal(await runtime.resolveModel(), "");
      assert.deepEqual((await runtime.readConfig()).models.profiles, {});
      assert.equal(await runtime.hasModelCredentials(), false);
      await assert.rejects(runtime.hasModelCredentials("missing-profile"), /does not exist/);
      await assert.rejects(resolveProfile("", cwd), /no model profile/);
      await write(path.join(root, ".easy-agent", "settings.json"), {
        models: {
          selected: { protocol: "anthropic", model: "custom", apiKey: { helper: "this-command-must-never-run" } },
        },
      });
      resetSettingsCache();
      assert.equal((await resolveProfileConfiguration("selected", cwd)).apiKeyHelper, "this-command-must-never-run");
      installConfigurationEnvironment({
        EASY_AGENT_PROFILE: "selected",
        EASY_AGENT_PROTOCOL: "gemini",
        EASY_AGENT_MODEL: "other",
      });
      await assert.rejects(resolveProfile("@environment", cwd), /choose EASY_AGENT_PROFILE/);
    } finally {
      await runtime.dispose();
    }
  }));

test("ambient vendor credentials are ignored unless the profile explicitly references them", async () =>
  fixture(async (root, cwd) => {
    process.env.ANTHROPIC_API_KEY = "ambient-key";
    process.env.ANTHROPIC_AUTH_TOKEN = "ambient-token";
    const file = path.join(root, ".easy-agent", "settings.json");
    await write(file, {
      model: "main",
      models: { main: { protocol: "anthropic", model: "upstream", apiKey: "selected-key" } },
    });
    const runtime = await createAgentRuntime({ ...options, cwd });
    try {
      assert.equal((await resolveProfile("main", cwd)).apiKey, "selected-key");
      await updateUserSettings(
        { models: { main: { protocol: "anthropic", model: "upstream", apiKey: "${ANTHROPIC_API_KEY}" } } },
        cwd,
      );
      assert.equal((await resolveProfile("main", cwd)).apiKey, "ambient-key");
      assert.equal(await runtime.hasModelCredentials(), true);
      assert.deepEqual(await readdir(path.dirname(file)), ["settings.json"]);
    } finally {
      await runtime.dispose();
    }
  }));

test("invalid active environment and unknown Agent selections fail startup", async () =>
  fixture(async (_root, cwd) => {
    process.env.EASY_AGENT_MAX_RETRIES = "12oops";
    await assert.rejects(createAgentRuntime({ ...options, cwd }), /expected an integer/);
    delete process.env.EASY_AGENT_MAX_RETRIES;
    await assert.rejects(createAgentRuntime({ ...options, cwd, harness: { name: "missing-agent" } }), /no Agent named/);
  }));

test("managed selection remains above flags", () => {
  const resolved = resolveHarnessFromInputs({
    workspaceTrusted: false,
    env: {},
    layers: [
      { source: "user", path: null, raw: { models: { canonical: localProfile } } },
      { source: "flag", path: null, raw: { model: "other" } },
      { source: "policy", path: null, raw: { model: "canonical" } },
    ],
  });
  assert.equal(resolved.values["model.main"]?.value, "canonical");
  assert.equal(resolved.values["model.main"]?.source, "policy");
  assert.deepEqual(resolved.issues, []);
});

test("reasoning auto stays auto, supported off disables reasoning, unsupported off explains why", () => {
  withHarness(resolveHarnessFromInputs({ workspaceTrusted: false, layers: [], env: {} }), () => {
    const unknown = { id: "gateway", protocol: "openai-chat" as const, model: "unknown", apiKey: "key" };
    assert.equal(buildDefaultThinkingConfig().type, "auto");
    assert.equal(
      prepareRequest(unknown, { messages: [], thinking: buildDefaultThinkingConfig() }).body.reasoning_effort,
      undefined,
    );
    assert.throws(
      () => prepareRequest(unknown, { messages: [], thinking: { type: "disabled" } }),
      /cannot be confirmed/,
    );
    assert.equal(
      prepareRequest({ ...unknown, model: "gpt-5.1" }, { messages: [], thinking: { type: "disabled" } }).body
        .reasoning_effort,
      "none",
    );
    const gemini = prepareRequest(
      { ...unknown, protocol: "gemini", model: "gemini-2.5-flash" },
      { messages: [], thinking: { type: "disabled" } },
    );
    assert.deepEqual((gemini.body.generationConfig as Record<string, unknown>).thinkingConfig, {
      thinkingBudget: 0,
      includeThoughts: false,
    });
    assert.throws(
      () => prepareRequest({ ...unknown, model: "o3" }, { messages: [], thinking: { type: "disabled" } }),
      /cannot be confirmed/,
    );
  });
});

test("historical session raw models require an explicit saved profile selection", async () =>
  fixture(async (root, cwd) => {
    await write(path.join(root, ".easy-agent", "settings.json"), {
      models: { saved: { ...localProfile, model: "raw-historical-model" } },
    });
    const runtime = await createAgentRuntime({ ...options, cwd });
    try {
      const old = await runtime.createSession({ model: "raw-historical-model" });
      await old.close();
      await assert.rejects(runtime.resumeSession(old.id), /Raw historical model names are not resolved automatically/);
      const resumed = await runtime.resumeSession(old.id, { model: "saved" });
      assert.equal(resumed.getState().model, "saved");
      await resumed.close();
    } finally {
      await runtime.dispose();
    }
  }));
