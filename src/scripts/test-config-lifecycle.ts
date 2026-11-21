import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
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
import { previewConfigMigration, applyConfigMigration } from "../config/migrationFiles.js";
import {
  migrateLegacyEnvironment,
  migrateSettings,
  migrateSessionModelSelection,
  legacyProfileId,
} from "../config/migration.js";
import { resolveHarnessFromInputs } from "../harness/resolve.js";
import { withHarness } from "../harness/active.js";
import { prepareRequest } from "../services/api/providers/providerStream.js";
import { buildDefaultThinkingConfig } from "../utils/thinking.js";

async function fixture(fn: (root: string, workspace: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagent-config-lifecycle-"));
  const before = { ...process.env };
  for (const name of Object.keys(process.env)) {
    if (/^(EASY_AGENT_|ANTHROPIC_|CLAUDE_CODE_|MAX_THINKING|DISABLE_INTERLEAVED|ENABLE_TOOL_SEARCH)/.test(name))
      delete process.env[name];
  }
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

test("sequential runtimes restore injected variables and recapture the changed parent", async () =>
  fixture(async (root, cwd) => {
    const { createAgentRuntime } = await import("../sdk/runtime.js");
    const options = { services: false as const, hardenPrivateData: false, logger: { warn() {}, error() {} } };
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
      models: {
        main: { protocol: "gemini", model: "custom", apiKey: "${NONSTANDARD_NAME}" },
      },
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
        assert.equal(profile.protocolOptions, undefined);
        assert.equal(profile.authentication, undefined);
        assert.equal(profile.headers, undefined);
        assert.equal(profile.baseURL, undefined);
      });
    } finally {
      await disposeRuntimeScope(scope);
    }
  }));

test("migration preview redacts secrets, apply backs up exactly, repeats are inert and stale approval fails", async () =>
  fixture(async (root, cwd) => {
    const scope = createRuntimeScope();
    const file = path.join(root, ".easy-agent", "settings.json");
    const raw = {
      model: "old-model",
      env: { ANTHROPIC_AUTH_TOKEN: "never-print-me" },
      claudeMdExcludes: ["old"],
      agentMdExcludes: ["new"],
    };
    await write(file, raw);
    const bytes = await readFile(file, "utf8");
    try {
      await runInRuntimeScope(scope, async () => {
        installConfigurationEnvironment({});
        const preview = await previewConfigMigration(cwd, "user");
        assert.equal(JSON.stringify(preview).includes("never-print-me"), false);
        assert.equal(await readFile(file, "utf8"), bytes);
        const applied = await applyConfigMigration(cwd, "user", preview.revision);
        assert.equal(applied.changed, true);
        assert.equal(await readFile(applied.backup!, "utf8"), bytes);
        if (process.platform !== "win32") assert.equal((await stat(applied.backup!)).mode & 0o777, 0o600);
        const canonical = JSON.parse(await readFile(file, "utf8"));
        assert.equal(canonical.model, legacyProfileId("old-model"));
        assert.deepEqual(canonical.agentMdExcludes, ["new", "old"]);
        assert.equal(canonical.env.ANTHROPIC_AUTH_TOKEN, undefined);
        const repeated = await previewConfigMigration(cwd, "user");
        assert.equal(repeated.changed, false);
        assert.equal((await applyConfigMigration(cwd, "user", repeated.revision)).backup, null);
        await write(file, { ...canonical, language: "new" });
        await assert.rejects(applyConfigMigration(cwd, "user", repeated.revision), /changed after preview/);
        await write(file, { env: { ANTHROPIC_API_KEY: "first", ANTHROPIC_AUTH_TOKEN: "second" } });
        const conflict = await previewConfigMigration(cwd, "user");
        assert.equal(
          conflict.notices.some((item) => item.level === "error"),
          true,
        );
        assert.equal(JSON.stringify(conflict).includes("first"), false);
        await assert.rejects(applyConfigMigration(cwd, "user", conflict.revision), /disagree/);
      });
    } finally {
      await disposeRuntimeScope(scope);
    }
  }));

test("no-profile startup supports configuration, conflicting selection fails, preview never runs helpers", async () =>
  fixture(async (root, cwd) => {
    const { createAgentRuntime } = await import("../sdk/runtime.js");
    const runtime = await createAgentRuntime({
      cwd,
      services: false,
      hardenPrivateData: false,
      logger: { warn() {}, error() {} },
    });
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
      const harness = resolveHarnessFromInputs({
        workspaceTrusted: true,
        layers: [],
        env: { EASY_AGENT_PROFILE: "selected", EASY_AGENT_MODEL: "other" },
      });
      assert.equal(harness.values["model.main"]?.value, "@environment");
      await assert.rejects(resolveProfile("@environment", cwd), /choose EASY_AGENT_PROFILE/);
    } finally {
      await runtime.dispose();
    }
  }));

test("a complete saved connection ignores unrelated conflicting legacy credentials", async () =>
  fixture(async (root, cwd) => {
    const { createAgentRuntime } = await import("../sdk/runtime.js");
    await write(path.join(root, ".easy-agent", "settings.json"), {
      model: "canonical",
      models: { canonical: { protocol: "openai-chat", model: "upstream", apiKey: "canonical-key" } },
    });
    process.env.ANTHROPIC_API_KEY = "irrelevant-old-key";
    process.env.ANTHROPIC_AUTH_TOKEN = "irrelevant-old-token";
    const runtime = await createAgentRuntime({
      cwd,
      harness: { name: "default" },
      services: false,
      hardenPrivateData: false,
      logger: { warn() {}, error() {} },
    });
    try {
      assert.equal(await runtime.resolveModel(), "canonical");
      assert.equal((await runtime.readConfig()).models.defaultModel, "canonical");
      assert.equal((await resolveProfile("canonical", cwd)).apiKey, "canonical-key");
    } finally {
      await runtime.dispose();
    }
  }));

for (const mode of [
  "reference",
  "missing-reference",
  "vendor-reference",
  "single-profile",
  "flag",
  "agent",
  "inline",
] as const) {
  test(`saved connection ownership preserves ${mode} with conflicting legacy credentials`, async () =>
    fixture(async (root, cwd) => {
      const { createAgentRuntime } = await import("../sdk/runtime.js");
      process.env.ANTHROPIC_API_KEY = "old-key";
      process.env.ANTHROPIC_AUTH_TOKEN = "old-token";
      const profile = {
        protocol: "openai-chat",
        model: "upstream",
        apiKey:
          mode === "vendor-reference"
            ? "${ANTHROPIC_API_KEY}"
            : mode === "missing-reference"
              ? "${MISSING_KEY}"
              : "${EASY_AGENT_API_KEY}",
      };
      const byAgent = mode === "agent" || mode === "inline";
      await write(path.join(root, ".easy-agent", "settings.json"), {
        ...(mode === "single-profile" || byAgent || mode === "flag" ? {} : { model: "canonical" }),
        models: { canonical: profile, ...(byAgent ? { second: localProfile } : {}) },
        env: { EASY_AGENT_API_KEY: "saved-key" },
        ...(mode === "agent"
          ? { harnesses: { custom: { model: { main: "canonical", roles: { compaction: "second" } } } } }
          : {}),
      });
      const runtime = await createAgentRuntime({
        cwd,
        services: false,
        hardenPrivateData: false,
        ...(mode === "flag" ? { flagSettings: { model: "canonical" } } : {}),
        harness:
          mode === "agent"
            ? { name: "custom" }
            : mode === "inline"
              ? { spec: { model: { main: "canonical" } } }
              : { name: "default" },
        logger: { warn() {}, error() {} },
      });
      try {
        assert.equal(await runtime.resolveModel(), "canonical");
        assert.equal(configurationEnvironment().EASY_AGENT_API_KEY, "saved-key");
        assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, "old-token");
        assert.equal((await loadProfiles(cwd)).errors?.["@environment"], undefined);
        if (mode === "missing-reference")
          await assert.rejects(resolveProfile("canonical", cwd), /MISSING_KEY is unset/);
        else
          assert.equal(
            (await resolveProfile("canonical", cwd)).apiKey,
            mode === "vendor-reference" ? "old-key" : "saved-key",
          );
      } finally {
        await runtime.dispose();
      }
    }));
}

test("same-file unused legacy conflicts can migrate without modifying the saved connection", async () =>
  fixture(async (root, cwd) => {
    const file = path.join(root, ".easy-agent", "settings.json");
    const profile = { protocol: "gemini", model: "saved", apiKey: "${EASY_AGENT_API_KEY}" };
    await write(file, {
      model: "canonical",
      models: { canonical: profile },
      env: { EASY_AGENT_API_KEY: "saved-key", ANTHROPIC_API_KEY: "old-key", ANTHROPIC_AUTH_TOKEN: "old-token" },
    });
    const scope = createRuntimeScope();
    try {
      await runInRuntimeScope(scope, async () => {
        await loadEnv(cwd);
        assert.equal((await resolveProfile("canonical", cwd)).apiKey, "saved-key");
        const preview = await previewConfigMigration(cwd, "user");
        assert.equal(
          preview.notices.some((notice) => notice.level === "error"),
          false,
        );
        await applyConfigMigration(cwd, "user", preview.revision);
        const saved = JSON.parse(await readFile(file, "utf8"));
        assert.deepEqual(saved.models.canonical, profile);
        assert.deepEqual(saved.env, { EASY_AGENT_API_KEY: "saved-key" });
        assert.equal((await previewConfigMigration(cwd, "user")).changed, false);
      });
    } finally {
      await disposeRuntimeScope(scope);
    }
  }));

test("saved targets cannot hide invalid canonical inputs or conflicts in a needed legacy connection", async () =>
  fixture(async (root, cwd) => {
    const { createAgentRuntime } = await import("../sdk/runtime.js");
    const options = {
      cwd,
      harness: { name: "default" },
      services: false as const,
      hardenPrivateData: false,
      logger: { warn() {}, error() {} },
    };
    process.env.ANTHROPIC_API_KEY = "old-key";
    process.env.ANTHROPIC_AUTH_TOKEN = "old-token";
    await assert.rejects(createAgentRuntime(options), /disagree/);
    await write(path.join(root, ".easy-agent", "settings.json"), { model: "raw-legacy-model" });
    await assert.rejects(createAgentRuntime(options), /disagree/);
    await write(path.join(root, ".easy-agent", "settings.json"), {
      model: "canonical",
      models: { canonical: localProfile },
    });
    process.env.EASY_AGENT_MAX_RETRIES = "12oops";
    await assert.rejects(createAgentRuntime(options), /expected an integer/);
    delete process.env.EASY_AGENT_MAX_RETRIES;
    await assert.rejects(createAgentRuntime({ ...options, harness: { name: "missing-agent" } }), /no Agent named/);
  }));

test("managed selection owns its connection above flags and legacy environment", () => {
  const resolved = resolveHarnessFromInputs({
    workspaceTrusted: false,
    env: { ANTHROPIC_API_KEY: "old-key", ANTHROPIC_AUTH_TOKEN: "old-token" },
    layers: [
      { source: "user", path: null, raw: { models: { canonical: localProfile } } },
      { source: "flag", path: null, raw: { model: "other" } },
      { source: "policy", path: null, raw: { model: "canonical" } },
    ],
  });
  assert.equal(resolved.values["model.main"]?.value, "canonical");
  assert.equal(resolved.values["model.main"]?.source, "policy");
  assert.equal(
    resolved.issues.some((issue) => issue.level === "error"),
    false,
  );
});

test("a newly generated legacy profile still receives its migrated credential", async () =>
  fixture(async (root, cwd) => {
    const { createAgentRuntime } = await import("../sdk/runtime.js");
    process.env.ANTHROPIC_API_KEY = "original-key";
    await write(path.join(root, ".easy-agent", "settings.json"), { model: "raw-legacy-model" });
    const runtime = await createAgentRuntime({
      cwd,
      harness: { name: "default" },
      services: false,
      hardenPrivateData: false,
      logger: { warn() {}, error() {} },
    });
    try {
      const id = legacyProfileId("raw-legacy-model");
      assert.equal(await runtime.resolveModel(), id);
      assert.equal((await resolveProfile(id, cwd)).apiKey, "original-key");
    } finally {
      await runtime.dispose();
    }
  }));

test("reasoning auto stays auto, supported off sends disabling parameters, unsupported off reports why", () => {
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

test("historical selections require a confirmed connection and session ambiguity never guesses", () => {
  const legacy = migrateLegacyEnvironment({ ANTHROPIC_API_KEY: "key", ANTHROPIC_MODEL: "old" });
  const migrated = migrateSettings({ model: "original" }, { legacyEnvironment: legacy });
  assert.equal(migrated.value.model, legacyProfileId("original"));
  assert.equal(migrateSettings({ model: "typo" }).value.model, "typo");
  assert.equal(migrateSessionModelSelection("raw", { saved: { model: "raw" } }), "saved");
  assert.equal(migrateSessionModelSelection("raw", { a: { model: "raw" }, b: { model: "raw" } }), undefined);
  assert.equal(migrateSessionModelSelection("missing", { saved: { model: "raw" } }), undefined);
  const roles = migrateSettings(
    {
      model: "original",
      modelRoles: { background: "original", compaction: "small" },
      harnesses: { custom: { model: { main: "special", roles: { classifier: "small" } } } },
    },
    { legacyEnvironment: legacy },
  );
  assert.deepEqual(roles.value.modelRoles, {
    background: legacyProfileId("original"),
    compaction: legacyProfileId("small"),
  });
  assert.deepEqual((roles.value.harnesses as Record<string, unknown>).custom, {
    model: { main: legacyProfileId("special"), roles: { classifier: legacyProfileId("small") } },
  });
  assert.equal(Object.keys(roles.value.models as object).length, 3);
  assert.equal(
    roles.notices.some((notice) => notice.level === "error"),
    false,
  );
  assert.equal(migrateSettings(roles.value).changed, false);
});

test("a migration approval cannot survive a runtime or connection snapshot change", async () =>
  fixture(async (root, cwd) => {
    await write(path.join(root, ".easy-agent", "settings.json"), {
      defaultModel: "saved",
      models: { saved: localProfile },
    });
    const first = createRuntimeScope();
    let revision = "";
    try {
      await runInRuntimeScope(first, async () => {
        installConfigurationEnvironment({});
        revision = (await previewConfigMigration(cwd, "user")).revision;
      });
    } finally {
      await disposeRuntimeScope(first);
    }
    const second = createRuntimeScope();
    try {
      await runInRuntimeScope(second, async () => {
        installConfigurationEnvironment({});
        await assert.rejects(applyConfigMigration(cwd, "user", revision), /changed after preview/);
        const current = await previewConfigMigration(cwd, "user");
        assert.equal((await applyConfigMigration(cwd, "user", current.revision)).changed, true);
      });
    } finally {
      await disposeRuntimeScope(second);
    }
  }));

test("shared project migration does not save an inline authentication secret", async () =>
  fixture(async (root, cwd) => {
    const scope = createRuntimeScope();
    const file = path.join(cwd, ".easy-agent", "settings.json");
    await write(file, { models: { old: { model: "old-model", apiKey: "must-stay-private" } } });
    const bytes = await readFile(file, "utf8");
    try {
      await runInRuntimeScope(scope, async () => {
        installConfigurationEnvironment({});
        const preview = await previewConfigMigration(cwd, "project");
        assert.ok(preview.notices.some((item) => item.level === "error" && item.field === "models.old.apiKey"));
        assert.equal(JSON.stringify(preview).includes("must-stay-private"), false);
        await assert.rejects(applyConfigMigration(cwd, "project", preview.revision), /environment reference/);
        assert.equal(await readFile(file, "utf8"), bytes);
      });
    } finally {
      await disposeRuntimeScope(scope);
    }
  }));

test("migrating a higher legacy default preserves the model an older version actually selected", async () =>
  fixture(async (root, cwd) => {
    const scope = createRuntimeScope();
    const user = path.join(root, ".easy-agent", "settings.json");
    const local = path.join(cwd, ".easy-agent", "settings.local.json");
    await write(user, {
      model: "selected",
      models: {
        selected: localProfile,
        fallback: { ...localProfile, model: "other" },
      },
    });
    await write(local, { defaultModel: "fallback" });
    try {
      await runInRuntimeScope(scope, async () => {
        installConfigurationEnvironment({});
        await trustProjectForSession(cwd);
        assert.equal((await loadProfiles(cwd)).defaultModel, "selected");
        const preview = await previewConfigMigration(cwd, "local");
        assert.ok(preview.notices.some((notice) => notice.message.includes("shadowed")));
        await applyConfigMigration(cwd, "local", preview.revision);
        assert.equal((await loadProfiles(cwd)).defaultModel, "selected");
        assert.deepEqual(JSON.parse(await readFile(local, "utf8")), {});
        await write(local, { defaultModel: "fallback" });
        resetSettingsCache();
        const { updateLocalSettings } = await import("../utils/settings.js");
        await updateLocalSettings(cwd, { language: "English" });
        assert.equal((await loadProfiles(cwd)).defaultModel, "selected");
        assert.deepEqual(JSON.parse(await readFile(local, "utf8")), { language: "English" });
      });
    } finally {
      await disposeRuntimeScope(scope);
    }
  }));
