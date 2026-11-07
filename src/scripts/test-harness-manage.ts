/**
 * Agent management (`eagent/sdk/experimental`): listing, reading, writing,
 * renaming, and deleting the Agents in `harnesses`, `default` stored as its
 * changes and restored by deleting them, `extends` that is missing or forms a
 * cycle refused, concurrent writers, a failed write leaving the file as it
 * was, export and import round trips, the workspace's default Agent in the
 * local settings file (trust, startup selection, fallbacks), and which
 * runtime reloads after a change. Also `eagent harness list` and
 * `/harness list|use`.
 *
 * Run: node --import tsx src/scripts/test-harness-manage.ts
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "easy-agent-harness-manage-")));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
await Promise.all([
  mkdir(path.join(home, ".easy-agent", "prompts"), { recursive: true }),
  mkdir(path.join(cwd, ".easy-agent"), { recursive: true }),
]);
for (const key of Object.keys(process.env)) {
  if (/^(?:ANTHROPIC_|EASY_AGENT_|CLAUDE_CODE_)/.test(key) || /TOOL_SEARCH|THINKING/.test(key)) delete process.env[key];
}
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.EASY_AGENT_DISABLE_HOOKS = "1";
process.env.ANTHROPIC_MODEL = "claude-test-model";
process.chdir(cwd);

const sdk = await import("../sdk/index.js");
const experimental = await import("../sdk/experimental.js");
const entry = await import("../sdk/experimentalEntry.js");
const bundle = await import("../sdk/sdkEntry.js");
const { resolveHarness } = await import("../harness/resolve.js");
const { activeHarness } = await import("../harness/active.js");
const { resetSettingsCache } = await import("../config/sources.js");
const { trustProject, untrustProject } = await import("../config/globalState.js");
const { runHarnessCommand } = await import("../entrypoint/harnessCommand.js");
const { writeConfig } = await import("../sdk/config.js");
const { AgentSdkError } = sdk;

const userSettings = path.join(home, ".easy-agent", "settings.json");
const projectSettings = path.join(cwd, ".easy-agent", "settings.json");
const localSettings = path.join(cwd, ".easy-agent", "settings.local.json");
const writeJson = (file: string, value: unknown) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const readJson = async (file: string) => JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
const harnessesOf = async () => ((await readJson(userSettings)).harnesses ?? {}) as Record<string, unknown>;

/** User settings with a credential and other keys the Agent writes must leave alone. */
const BASE_SETTINGS = {
  outputStyle: "Explanatory",
  models: { work: { protocol: "openai", model: "gpt-test", apiKey: "sk-inline-secret-value" } },
  deny: ["WebFetch"],
};

async function reset(harnesses?: Record<string, unknown>, local?: Record<string, unknown>): Promise<void> {
  await writeJson(userSettings, { ...BASE_SETTINGS, ...(harnesses ? { harnesses } : {}) });
  await writeJson(projectSettings, {});
  await rm(localSettings, { force: true });
  if (local) await writeJson(localSettings, local);
  resetSettingsCache();
}

async function rejectsWith(promise: Promise<unknown>, code: string, pattern?: RegExp): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AgentSdkError, `expected AgentSdkError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    if (pattern) assert.match(error.message, pattern);
    return error;
  }
  assert.fail(`expected a ${code} error`);
}

/** The settings file is byte-for-byte what it was before `fn` failed. */
async function unchangedAfter(fn: () => Promise<unknown>, code: string, pattern?: RegExp): Promise<void> {
  const before = await readFile(userSettings, "utf8");
  await rejectsWith(fn(), code, pattern);
  assert.equal(await readFile(userSettings, "utf8"), before, "the failed write left the file as it was");
}

const warnings: string[] = [];
const startRuntime = (harness?: { name: string }) =>
  sdk.createAgentRuntime({
    cwd,
    services: false,
    logger: { warn: (message) => warnings.push(message), error() {} },
    ...(harness ? { harness } : {}),
  });

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("Agent management");

try {
  await check("without a harness key, resolution and a runtime use default as before", async () => {
    await reset({ reviewer: { outputStyle: "Concise" } });
    const resolved = await resolveHarness({ cwd });
    assert.equal(resolved.name, "default");
    assert.equal(resolved.selectedBy, undefined);
    const runtime = await startRuntime();
    try {
      assert.equal((await runtime.getHarness()).name, "default");
    } finally {
      await runtime.dispose();
    }
  });

  await check("the experimental entry and the SDK bundle share one module", () => {
    const names = Object.keys(experimental).filter(
      (key) => typeof (experimental as Record<string, unknown>)[key] === "function",
    );
    assert.deepEqual(Object.keys(entry).sort(), names.sort(), "the entry re-exports every experimental function");
    for (const name of names) {
      assert.equal(
        (entry as Record<string, unknown>)[name],
        (bundle.__experimental as Record<string, unknown>)[name],
        `${name} is the bundle's own function`,
      );
    }
  });

  await check("list shows default first, the defined Agents, their extends, dependents, and errors", async () => {
    await reset({
      reviewer: { description: "Reviews code", tools: { exclude: ["Write"] } },
      strict: { extends: "reviewer", permissions: { deny: ["Bash"] } },
      broken: { extends: "nowhere" },
    });
    const listing = await experimental.listHarnesses({ cwd });
    assert.equal(listing.path, userSettings);
    assert.deepEqual(
      listing.harnesses.map((agent) => agent.name),
      ["default", "broken", "reviewer", "strict"],
    );
    const [first, broken, reviewer, strict] = listing.harnesses;
    assert.deepEqual(
      {
        builtIn: first!.builtIn,
        defined: first!.defined,
        extends: first!.extends,
        projectDefault: first!.projectDefault,
      },
      { builtIn: true, defined: false, extends: undefined, projectDefault: true },
    );
    assert.deepEqual(first!.dependents, ["broken", "reviewer", "strict"]);
    assert.match(broken!.errors.join(), /no Agent named "nowhere"/);
    assert.equal(reviewer!.description, "Reviews code");
    assert.deepEqual(reviewer!.dependents, ["strict"]);
    assert.equal(strict!.extends, "reviewer");
    assert.equal(listing.projectDefault, null);

    const read = await experimental.readHarness("strict");
    assert.deepEqual(read.spec, { extends: "reviewer", permissions: { deny: ["Bash"] } });
    assert.deepEqual((await experimental.readHarness("default")).spec, {}, "an unchanged built-in reads as {}");
    await rejectsWith(experimental.readHarness("ghost"), "not_found");
  });

  await check("write creates and replaces an Agent and keeps every other key of the file", async () => {
    await reset({ reviewer: { outputStyle: "Concise" } });
    const created = await experimental.writeHarness("writer", {
      extends: "reviewer",
      description: "  Writes docs",
      model: { main: " sonnet " },
    });
    assert.equal(created.created, true);
    assert.deepEqual(created.spec, { extends: "reviewer", description: "  Writes docs", model: { main: "sonnet" } });
    assert.deepEqual(created.affected, ["writer"]);
    assert.equal(created.reloaded, false, "no runtime runs in this process");
    const stored = await readJson(userSettings);
    assert.deepEqual(stored.models, BASE_SETTINGS.models, "the credential stays as it was");
    assert.deepEqual(stored.deny, ["WebFetch"]);
    assert.deepEqual((stored.harnesses as Record<string, unknown>).reviewer, { outputStyle: "Concise" });

    const replaced = await experimental.writeHarness("reviewer", { outputStyle: "Learning" });
    assert.equal(replaced.created, false);
    assert.deepEqual(replaced.affected, ["reviewer", "writer"], "an Agent that extends it is affected too");
    const resolved = await resolveHarness({ cwd, name: "writer" });
    assert.equal(resolved.values.outputStyle?.value, "Learning");
    assert.deepEqual(resolved.chain, ["reviewer", "writer"]);
  });

  await check(
    "an invalid spec, a missing extends, a cycle, or a bad name is refused and nothing is written",
    async () => {
      await reset({ a: {}, b: { extends: "a" } });
      await unchangedAfter(() => experimental.writeHarness("c", { tools: { exlude: ["Write"] } }), "harness", /exlude/);
      await unchangedAfter(
        () => experimental.writeHarness("c", { extends: "nowhere" }),
        "harness",
        /Agent "c".*no Agent named "nowhere"/,
      );
      await unchangedAfter(() => experimental.writeHarness("a", { extends: "b" }), "harness", /extends cycle/);
      await unchangedAfter(() => experimental.writeHarness("a", { extends: "a" }), "harness", /extends cycle/);
      await unchangedAfter(
        () => experimental.writeHarness("c", { prompt: { identity: { file: "prompts/missing.md" } } }),
        "harness",
        /cannot read/,
      );
      await unchangedAfter(() => experimental.writeHarness("has space", {}), "invalid_argument");
      await unchangedAfter(() => experimental.writeHarness("default", { extends: "a" }), "harness", /built-in default/);
    },
  );

  await check("an Agent that was already broken does not block writes to the others", async () => {
    await reset({ broken: { extends: "nowhere" } });
    await experimental.writeHarness("fine", { outputStyle: "Concise" });
    assert.deepEqual(Object.keys(await harnessesOf()).sort(), ["broken", "fine"]);
  });

  await check("a failed read of the settings file leaves it as it was", async () => {
    await writeFile(userSettings, '{ "harnesses": { "a": {} }, oops');
    const before = await readFile(userSettings, "utf8");
    await rejectsWith(experimental.writeHarness("b", {}), "harness", /Invalid JSON|JSON/);
    await rejectsWith(experimental.deleteHarness("a"), "harness");
    assert.equal(await readFile(userSettings, "utf8"), before);
  });

  await check(
    "default stores only its changes, overrides the built-in by name, and deleting it restores it",
    async () => {
      await reset({ reviewer: {} });
      const written = await experimental.writeHarness("default", {
        extends: "default",
        outputStyle: "Explanatory", // the top-level user setting already gives this
        features: { thinking: true, maxTurns: 30 }, // thinking is on by default
        permissions: { deny: ["WebFetch"], ask: ["Bash"] }, // WebFetch is denied at the top level already
      });
      assert.deepEqual(written.spec, { features: { maxTurns: 30 }, permissions: { ask: ["Bash"] } });
      assert.deepEqual(written.affected, ["default", "reviewer"], "every Agent extends default");
      const resolved = await resolveHarness({ cwd });
      assert.equal(resolved.name, "default");
      assert.equal(resolved.values["features.maxTurns"]?.source, "harness");
      assert.equal(resolved.values["features.maxTurns"]?.detail, "default", "harnesses.default overrides the built-in");
      assert.equal((await resolveHarness({ cwd, name: "reviewer" })).values["features.maxTurns"]?.value, 30);

      const unchanged = await experimental.writeHarness("default", { outputStyle: "Explanatory" });
      assert.equal(unchanged.spec, null, "a default without changes is removed");
      assert.equal(Object.hasOwn(await harnessesOf(), "default"), false);

      await experimental.writeHarness("default", { features: { maxTurns: 30 } });
      const restored = await experimental.deleteHarness("default");
      assert.equal(restored.deleted, true);
      assert.equal(Object.hasOwn(await harnessesOf(), "default"), false);
      assert.equal((await resolveHarness({ cwd })).values["features.maxTurns"]?.value, undefined);
      const again = await experimental.deleteHarness("default");
      assert.deepEqual([again.deleted, again.affected], [false, []], "restoring an unchanged default changes nothing");
    },
  );

  await check("delete refuses an Agent others extend and reports unknown names", async () => {
    await reset({ base: {}, child: { extends: "base" }, grandchild: { extends: "child" } });
    await unchangedAfter(() => experimental.deleteHarness("base"), "harness", /extended by "child"/);
    const removed = await experimental.deleteHarness("grandchild");
    assert.deepEqual([removed.deleted, removed.affected], [true, ["grandchild"]]);
    await rejectsWith(experimental.deleteHarness("ghost"), "not_found");
    await experimental.deleteHarness("child");
    await experimental.deleteHarness("base");
    assert.equal((await readJson(userSettings)).harnesses, undefined, "the last Agent removes the key");
  });

  await check("rename moves the spec and the Agents and workspace default that named it", async () => {
    await reset({ base: { outputStyle: "Concise" }, child: { extends: "base" } }, { harness: "base" });
    await trustProject(cwd);
    try {
      const renamed = await experimental.renameHarness("base", "core", { cwd });
      assert.deepEqual(
        {
          name: renamed.name,
          from: renamed.from,
          updatedExtends: renamed.updatedExtends,
          project: renamed.updatedProjectDefault,
        },
        { name: "core", from: "base", updatedExtends: ["child"], project: true },
      );
      assert.deepEqual(renamed.affected.sort(), ["base", "child", "core"]);
      assert.deepEqual(await harnessesOf(), { core: { outputStyle: "Concise" }, child: { extends: "core" } });
      assert.equal((await readJson(localSettings)).harness, "core");
      await rejectsWith(experimental.renameHarness("core", "child", { cwd }), "invalid_argument", /already exists/);
      await rejectsWith(experimental.renameHarness("default", "x", { cwd }), "invalid_argument");
      await rejectsWith(experimental.renameHarness("ghost", "x", { cwd }), "not_found");
    } finally {
      await untrustProject(cwd);
    }
  });

  await check("concurrent writers keep each other's Agents", async () => {
    await reset({ keep: { outputStyle: "Concise" } });
    const names = Array.from({ length: 8 }, (_, i) => `agent-${i}`);
    await Promise.all(names.map((name, i) => experimental.writeHarness(name, { features: { maxTurns: i + 1 } })));
    const stored = await harnessesOf();
    assert.deepEqual(Object.keys(stored).sort(), ["keep", ...names].sort());
    for (const [i, name] of names.entries()) assert.deepEqual(stored[name], { features: { maxTurns: i + 1 } });
  });

  await check("export inlines the extends chain and its files; import round-trips after the preview", async () => {
    await writeFile(path.join(home, ".easy-agent", "prompts", "reviewer.md"), "You review code.\n");
    await reset({
      default: { features: { maxTurns: 40 } },
      reviewer: {
        description: "Reviews code",
        prompt: {
          identity: { file: "prompts/reviewer.md" },
          sections: { rules: { file: "prompts/reviewer.md", after: "agent_md" }, memory: false },
        },
        tools: { exclude: ["Write", "Edit"] },
        mcpServers: { exclude: ["noisy"] },
      },
      strict: { extends: "reviewer", permissions: { mode: "auto", allow: ["Read"], deny: ["Bash"] } },
    });
    await writeJson(projectSettings, { mcpServers: { docs: { command: "docs-server" }, noisy: { command: "noisy" } } });
    await trustProject(cwd);
    try {
      const exported = await experimental.exportHarness("strict");
      assert.deepEqual(exported, {
        format: "easy-agent-harness",
        version: 1,
        name: "strict",
        spec: {
          description: "Reviews code",
          prompt: {
            identity: { text: "You review code.\n" },
            sections: { rules: { after: "agent_md", text: "You review code.\n" }, memory: false },
          },
          tools: { exclude: ["Write", "Edit"] },
          mcpServers: { exclude: ["noisy"] },
          permissions: { mode: "auto", allow: ["Read"], deny: ["Bash"] },
          features: { maxTurns: 40 },
        },
      });
      const json = JSON.parse(JSON.stringify(exported));

      const preview = await experimental.previewHarnessImport(json, { cwd });
      assert.equal(preview.exists, true);
      assert.equal(preview.tools.includes("Read"), true);
      assert.equal(preview.tools.includes("Write") || preview.tools.includes("Edit"), false);
      assert.deepEqual(preview.mcpServers, ["docs"]);
      assert.deepEqual(preview.permissions, { mode: "auto", allow: ["Read"], ask: [], deny: ["Bash"] });
      assert.ok(preview.sets.includes("permissions.mode") && preview.sets.includes("prompt.identity"));
      assert.deepEqual(preview.errors, []);

      await rejectsWith(
        experimental.importHarness(json, { fingerprint: preview.fingerprint }),
        "invalid_argument",
        /already exists/,
      );
      await rejectsWith(experimental.importHarness(json, { fingerprint: "0000", name: "copy" }), "invalid_argument");
      const tampered = { ...json, spec: { ...json.spec, permissions: { mode: "auto", allow: ["Bash"] } } };
      await rejectsWith(
        experimental.importHarness(tampered, { fingerprint: preview.fingerprint, name: "copy" }),
        "invalid_argument",
        /differs from the preview/,
      );

      const imported = await experimental.importHarness(json, { fingerprint: preview.fingerprint, name: "copy" });
      assert.equal(imported.created, true);
      const [original, copy] = await Promise.all([
        resolveHarness({ cwd, name: "strict" }),
        resolveHarness({ cwd, name: "copy" }),
      ]);
      const withoutFiles = (value: unknown) =>
        value === undefined
          ? undefined
          : JSON.parse(JSON.stringify(value, (key, v) => (key === "file" ? undefined : v)));
      for (const [key, value] of Object.entries(original.values)) {
        assert.deepEqual(
          withoutFiles(copy.values[key]?.value),
          withoutFiles(value.value),
          `${key} resolves the same after the round trip`,
        );
      }
      assert.deepEqual(
        await experimental.exportHarness("copy"),
        { ...exported, name: "copy" },
        "exporting it again is the same",
      );

      const replaced = await experimental.importHarness(json, { fingerprint: preview.fingerprint, replace: true });
      assert.equal(replaced.created, false);
    } finally {
      await untrustProject(cwd);
    }
  });

  await check("an import that reads files or is not an export is refused", async () => {
    await reset();
    const withFile = {
      format: "easy-agent-harness",
      version: 1,
      name: "x",
      spec: { prompt: { identity: { file: "~/.ssh/id_rsa" } } },
    };
    await rejectsWith(
      experimental.previewHarnessImport(withFile, { cwd }),
      "invalid_argument",
      /prompt\.identity reads a file/,
    );
    await rejectsWith(experimental.previewHarnessImport({ name: "x", spec: {} }, { cwd }), "invalid_argument");
    const unresolved = await experimental.previewHarnessImport(
      { format: "easy-agent-harness", version: 1, name: "x", spec: { extends: "missing" } },
      { cwd },
    );
    assert.match(unresolved.errors.join(), /no Agent named "missing"/);
    await rejectsWith(
      experimental.importHarness(
        { format: "easy-agent-harness", version: 1, name: "x", spec: { extends: "missing" } },
        { fingerprint: unresolved.fingerprint },
      ),
      "harness",
    );
  });

  await check("the workspace default needs trust, a known Agent, and lives in the local settings file", async () => {
    await reset({ reviewer: { outputStyle: "Concise" }, broken: { extends: "nowhere" } });
    await rejectsWith(experimental.setProjectHarness("reviewer", { cwd }), "untrusted");
    await trustProject(cwd);
    try {
      await rejectsWith(experimental.setProjectHarness("ghost", { cwd }), "not_found");
      await rejectsWith(experimental.setProjectHarness("broken", { cwd }), "harness");
      const set = await experimental.setProjectHarness("reviewer", { cwd });
      assert.deepEqual(set, { name: "reviewer", path: localSettings });
      assert.equal((await readJson(localSettings)).harness, "reviewer");
      assert.match(await readFile(path.join(cwd, ".easy-agent", ".gitignore"), "utf8"), /settings\.local\.json/);
      const listing = await experimental.listHarnesses({ cwd });
      assert.deepEqual(listing.projectDefault, { name: "reviewer", path: localSettings, applied: true });
      assert.deepEqual(
        listing.harnesses.filter((agent) => agent.projectDefault).map((agent) => agent.name),
        ["reviewer"],
      );
      const resolved = await resolveHarness({ cwd });
      assert.equal(resolved.name, "reviewer");
      assert.deepEqual(resolved.selectedBy, { source: "local", path: localSettings });
      assert.deepEqual(await experimental.setProjectHarness(null, { cwd }), { name: "default", path: localSettings });
      assert.equal(Object.hasOwn(await readJson(localSettings), "harness"), false);
      await rejectsWith(writeConfig(cwd, "project", "harness", "reviewer"), "invalid_argument", /local settings file/);
      await rejectsWith(writeConfig(cwd, "user", "harness", "reviewer"), "invalid_argument");
    } finally {
      await untrustProject(cwd);
    }
  });

  await check(
    "a runtime starts with the workspace default; a selection, trust, and broken Agents decide as stated",
    async () => {
      await reset({ reviewer: { outputStyle: "Concise" }, broken: { extends: "nowhere" } }, { harness: "reviewer" });
      const untrusted = await resolveHarness({ cwd });
      assert.equal(untrusted.name, "default", "an untrusted workspace ignores the key");
      assert.match(
        untrusted.issues.map((issue) => issue.message).join(),
        /harness in local settings .* is ignored: workspace is not trusted/,
      );

      await trustProject(cwd);
      try {
        const runtime = await startRuntime();
        try {
          const harness = await runtime.getHarness();
          assert.equal(harness.name, "reviewer");
          assert.deepEqual(harness.selectedBy, { source: "local", path: localSettings });
          // The runtime keeps its Agent when the default changes; the next one uses the new default.
          await writeJson(localSettings, { harness: "default" });
          resetSettingsCache();
          assert.equal((await runtime.getHarness()).name, "reviewer");
        } finally {
          await runtime.dispose();
        }

        await writeJson(localSettings, { harness: "reviewer" });
        const selected = await startRuntime({ name: "default" });
        try {
          assert.equal((await selected.getHarness()).name, "default", "an explicit selection wins");
        } finally {
          await selected.dispose();
        }

        warnings.length = 0;
        await writeJson(localSettings, { harness: "deleted-agent" });
        const fallback = await startRuntime();
        try {
          assert.equal((await fallback.getHarness()).name, "default");
          assert.match(warnings.join("\n"), /default Agent "deleted-agent".*does not exist; using default/);
        } finally {
          await fallback.dispose();
        }

        await writeJson(localSettings, { harness: "broken" });
        await rejectsWith(startRuntime(), "harness", /workspace's default Agent "broken".*does not resolve/);

        await writeJson(localSettings, {});
        await writeJson(projectSettings, { harness: "reviewer" });
        const shared = await resolveHarness({ cwd });
        assert.equal(shared.name, "default", "the shared project file cannot pick the Agent");
        assert.match(shared.issues.map((issue) => issue.message).join(), /harness in project settings .* is ignored/);
      } finally {
        await untrustProject(cwd);
      }
    },
  );

  await check("only a runtime that uses a changed Agent reloads", async () => {
    await reset({ base: { outputStyle: "Concise" }, reviewer: { extends: "base" }, other: {} });
    const runtime = await startRuntime({ name: "reviewer" });
    try {
      const session = await runtime.createSession({ persist: false });
      const unrelated = await experimental.writeHarness("other", { outputStyle: "Learning" });
      assert.equal(unrelated.reloaded, false);
      assert.equal(activeHarness().values.outputStyle?.value, "Concise");

      const parent = await experimental.writeHarness("base", { outputStyle: "Learning" });
      assert.equal(parent.reloaded, true, "the runtime's Agent extends the changed one");
      assert.equal(activeHarness().values.outputStyle?.value, "Learning", "installed without waiting for a request");

      const own = await experimental.writeHarness("reviewer", { extends: "base", permissions: { deny: ["Bash"] } });
      assert.equal(own.reloaded, true);
      assert.deepEqual(activeHarness().values["permissions.deny"]?.value, ["WebFetch", "Bash"]);
      await session.close();
    } finally {
      await runtime.dispose();
    }
  });

  await check("eagent harness list and /harness list|use show and set the same data", async () => {
    await reset({ reviewer: { description: "Reviews code" } });
    let out = "";
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      out += chunk;
      return true;
    }) as typeof process.stdout.write;
    try {
      assert.equal(await runHarnessCommand(["list"], cwd), 0);
      const text = out;
      out = "";
      assert.equal(await runHarnessCommand(["list", "--json"], cwd), 0);
      process.stdout.write = write;
      assert.match(text, /default\s+built-in, this workspace's default/);
      assert.match(text, /reviewer\s+extends default\n\s+Reviews code/);
      const json = JSON.parse(out) as { harnesses: { name: string }[] };
      assert.deepEqual(
        json.harnesses.map((agent) => agent.name),
        ["default", "reviewer"],
      );
    } finally {
      process.stdout.write = write;
    }

    await trustProject(cwd);
    const runtime = await startRuntime();
    try {
      const session = await runtime.createSession({ persist: false });
      const outputs: string[] = [];
      session.subscribe((event) => {
        if (event.type === "command_output") outputs.push(event.message);
      });
      await session.runCommand("harness", ["use", "reviewer"]);
      assert.match(outputs.at(-1) ?? "", /default Agent is now reviewer.*this one keeps default until you restart/);
      assert.equal((await readJson(localSettings)).harness, "reviewer");
      await session.runCommand("harness", ["list"]);
      assert.match(outputs.at(-1) ?? "", /reviewer\s+extends default, this workspace's default/);
      await session.runCommand("harness", ["use", "ghost"]);
      assert.match(outputs.at(-1) ?? "", /No Agent named "ghost"/);
      await session.runCommand("harness", ["show", "reviewer"]);
      assert.match(outputs.at(-1) ?? "", /^Agent: reviewer/);
      await session.runCommand("harness", ["use", "default"]);
      assert.equal(Object.hasOwn(await readJson(localSettings), "harness"), false);
      await session.close();
    } finally {
      await runtime.dispose();
      await untrustProject(cwd);
    }
  });
} finally {
  // Windows cannot remove the process's current directory.
  process.chdir(os.tmpdir());
  await rm(root, { recursive: true, force: true });
}

console.log(`\n${passed} Agent management checks passed.`);
