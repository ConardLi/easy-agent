/** Resource selection reaches execution, survives reordering, and only narrows trust. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "easy-agent-resources-")));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
await mkdir(path.join(home, ".easy-agent"), { recursive: true });
await mkdir(path.join(cwd, ".easy-agent"), { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.EASY_AGENT_DISABLE_HOOKS;

const { withHarness } = await import("../harness/active.js");
const { resolveHarnessFromInputs } = await import("../harness/resolve.js");
const { hookSelectionKey, pluginOffByAgent } = await import("../harness/resources.js");
const { loadHooksSettings } = await import("../hooks/settings.js");
const { setUserCommands, findUserCommand, getAllUserCommands } = await import("../commands/userCommands/registry.js");
const { collectDynamicSections, getRuntimeEnvironmentContext } = await import("../context/systemPrompt.js");
const { resetSettingsCache } = await import("../config/sources.js");
const { refreshActivePlugins, getActivePluginHooks, _resetPluginRuntimeForTesting } = await import(
  "../plugins/runtime.js"
);
const { findSkill, getRegisteredSkills } = await import("../services/skills/registry.js");
const { getActiveOutputStyleConfig, setActiveOutputStyle } = await import("../styles/registry.js");
const resolve = (spec: Record<string, unknown>) =>
  resolveHarnessFromInputs({
    name: "chosen",
    layers: [{ source: "user", path: null, raw: { harnesses: { chosen: spec } } }],
    env: {},
    workspaceTrusted: false,
  });
const hook = { type: "command" as const, command: "echo selected", timeout: 60 };
const key = hookSelectionKey("user", "Stop", undefined, hook);
try {
  assert.equal(key, hookSelectionKey("user", "Stop", undefined, { ...hook, timeout: 10 }));
  assert.notEqual(key, hookSelectionKey("project", "Stop", undefined, hook));
  const user = path.join(home, ".easy-agent", "settings.json");
  await writeFile(user, JSON.stringify({ hooks: { Stop: [{ hooks: [hook, { ...hook, command: "echo kept" }] }] } }));
  await writeFile(
    path.join(cwd, ".easy-agent", "settings.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ ...hook, command: "echo untrusted" }] }] } }),
  );
  const selected = resolve({ hooks: { exclude: [key] }, plugins: { exclude: ["kit@market"] } });
  await withHarness(selected, async () => {
    assert.match(pluginOffByAgent("kit@market") ?? "", /plugins.exclude/);
    assert.equal(pluginOffByAgent(undefined), undefined);
    const hooks = await loadHooksSettings(cwd);
    assert.deepEqual(
      hooks.Stop?.flatMap((group) => group.hooks.map((h) => h.command)),
      ["echo kept"],
    );
    // Reordering does not move the exclusion to a different command.
    await writeFile(user, JSON.stringify({ hooks: { Stop: [{ hooks: [{ ...hook, command: "echo kept" }, hook] }] } }));
    resetSettingsCache();
    assert.deepEqual(
      (await loadHooksSettings(cwd)).Stop?.flatMap((group) => group.hooks.map((h) => h.command)),
      ["echo kept"],
    );
  });
  const disabled = resolve({ hooks: { enabled: false } });
  await withHarness(disabled, async () => assert.deepEqual(await loadHooksSettings(cwd), {}));
  setUserCommands([
    {
      name: "kit:notes",
      description: "Notes",
      body: "Write notes",
      source: "plugin",
      filePath: "/plugin/notes.md",
      pluginId: "kit@market",
      allowedTools: [],
    },
  ]);
  withHarness(selected, () => {
    assert.equal(findUserCommand("kit:notes"), undefined);
    assert.deepEqual(getAllUserCommands(), []);
  });
  withHarness(resolve({}), () => assert.ok(findUserCommand("kit:notes"), "default behavior stays available"));
  const rules = path.join(cwd, "AGENTS.md");
  await writeFile(rules, "RESOURCE_RULE_MARKER");
  const environment = await getRuntimeEnvironmentContext(cwd);
  const sections = await withHarness(resolve({ rules: { exclude: [rules] } }), () =>
    collectDynamicSections({ cwd, environment }),
  );
  assert.ok(!JSON.stringify(sections).includes("RESOURCE_RULE_MARKER"));
  const defaults = await withHarness(resolve({}), () => collectDynamicSections({ cwd, environment }));
  assert.ok(JSON.stringify(defaults).includes("RESOURCE_RULE_MARKER"));
  const kit = path.join(root, "kit");
  const put = async (relative: string, text: string) => {
    const file = path.join(kit, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  };
  await put(".easy-agent-plugin/plugin.json", JSON.stringify({ name: "kit", version: "1.0.0" }));
  await put("skills/notes/SKILL.md", "---\nname: notes\ndescription: Write notes\n---\nPLUGIN_SKILL_MARKER\n");
  await put("commands/ship.md", "PLUGIN_COMMAND_MARKER\n");
  await put("output-styles/brief.md", "---\nname: brief\ndescription: Brief replies\n---\nPLUGIN_STYLE_MARKER\n");
  await put("hooks/hooks.json", JSON.stringify({ hooks: { Stop: [{ hooks: [hook] }] } }));
  await withHarness(resolve({}), async () => {
    await refreshActivePlugins(cwd, { pluginDirs: [kit], applyMcp: false });
    assert.ok(findSkill("kit:notes"));
    assert.ok(findUserCommand("kit:ship"));
    assert.ok(getActivePluginHooks().Stop?.length);
    assert.ok(setActiveOutputStyle("kit:brief"));
    assert.ok(getActiveOutputStyleConfig());
  });
  withHarness(resolve({ plugins: { include: [] } }), () => {
    assert.equal(findSkill("kit:notes"), undefined);
    assert.ok(
      getRegisteredSkills().some((skill) => skill.name === "kit:notes"),
      "the library still lists excluded resources",
    );
    assert.equal(findUserCommand("kit:ship"), undefined);
    assert.deepEqual(getActivePluginHooks(), {});
    assert.equal(getActiveOutputStyleConfig(), null);
  });
  withHarness(resolve({ hooks: { exclude: [hookSelectionKey("plugin:kit@dev", "Stop", undefined, hook)] } }), () => {
    assert.deepEqual(getActivePluginHooks(), {});
    assert.ok(findSkill("kit:notes"), "removing one hook does not disable its plugin's skills");
  });
  console.log("✓ Resource selection, hook identity, plugin execution, rule prompts, and trust boundary");
} finally {
  _resetPluginRuntimeForTesting();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
