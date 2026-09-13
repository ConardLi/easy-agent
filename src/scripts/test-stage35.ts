/**
 * Stage 35 test — Plugin System & Static Marketplace.
 *
 * Exercises the whole plugin pipeline against on-disk fixtures WITHOUT hitting
 * the network (a local marketplace) or the user's real home (HOME is pointed at
 * a temp dir first, so os.homedir() — and therefore every ~/.easy-agent path —
 * resolves under the sandbox for the life of this process).
 *
 * Coverage (per plan §35.8):
 *   [1] manifest + marketplace schema validation (incl. `..` rejection)
 *   [2] unified namespace helpers
 *   [3] component-path containment (symlink / escape rejection)
 *   [4] loader: namespacing + provenance + ${VAR} substitution
 *   [5] marketplace add/list/resolve
 *   [6] install + atomic ROLLBACK on a bad plugin
 *   [7] per-scope enable + live reload into the registries
 *   [8] trust gating of executable (hooks/MCP) components
 *   [9] MCP diff purity + cleanup on teardown
 *   [10] uninstall + delete-safety (managed cache only)
 *
 * Run: npx tsx src/scripts/test-stage35.ts
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CommandContext } from "../core/queryEngine/commands/context.js";

// ── Point HOME at a sandbox BEFORE importing anything that resolves paths. ──
const SANDBOX_HOME = await fs.mkdtemp(path.join(os.tmpdir(), "ea-stage35-home-"));
process.env.HOME = SANDBOX_HOME;

const { PluginManifestSchema, MarketplaceManifestSchema } = await import("../plugins/schemas.js");
const { applyNamespace, splitNamespace, mcpServerNamespace } = await import("../plugins/namespace.js");
const { resolveInsidePlugin } = await import("../plugins/pathSafety.js");
const { loadPlugin } = await import("../plugins/loader.js");
const {
  substitutePluginVars,
  getPluginDataDir,
  getPluginCacheDir,
  getPluginCacheRoot,
  safePathSegment,
} = await import("../plugins/paths.js");
const marketplace = await import("../plugins/marketplace.js");
const {
  installPlugin,
  inspectPlugin,
  uninstallPlugin,
  isManagedPluginPath,
} = await import("../plugins/install.js");
const { setPluginEnabled, getEnabledPluginIds } = await import("../plugins/enable.js");
const { readInstalledPlugins } = await import("../plugins/state.js");
const runtime = await import("../plugins/runtime.js");
const { diffMcpServers, applyPluginMcpDiff } = await import("../plugins/mcpApply.js");
const { findSkill } = await import("../services/skills/registry.js");
const { skillTool } = await import("../tools/skillTool.js");
const { matchesPermissionRule } = await import("../permissions/permissions.js");
const { findAgent } = await import("../agents/registry.js");
const { getAllUserCommands } = await import("../commands/userCommands/registry.js");
const {
  resolveOutputStyle,
  setActiveOutputStyle,
  getActiveOutputStyleName,
} = await import("../styles/registry.js");
const { setMcpRegistryEntry, getMcpRegistryEntry } = await import("../services/mcp/registry.js");
const { trustProject, resetGlobalStateCache } = await import("../config/globalState.js");
const { detectRisks } = await import("../ui/trustGate.js");
const { gitClone, gitUpdate, gitHeadCommit } = await import("../plugins/git.js");
const { handlePluginCommand } = await import("../core/queryEngine/commands/plugin.js");
const execFileAsync = promisify(execFile);

// ─── tiny assert harness ──────────────────────────────────────────────
let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    passed++;
    process.stdout.write(`  \u001b[32m✓\u001b[0m ${label}\n`);
  } else {
    failed++;
    process.stdout.write(`  \u001b[31m✗ ${label}\u001b[0m\n`);
  }
}
async function assertThrows(fn: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await fn();
    assert(false, `${label} (expected throw)`);
  } catch {
    assert(true, label);
  }
}
function section(title: string): void {
  process.stdout.write(`\n\u001b[1m${title}\u001b[0m\n`);
}

// ─── fixture builder ──────────────────────────────────────────────────
async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf-8");
}

interface Fixtures {
  marketplaceRoot: string;
  demoRoot: string;
  escapeRoot: string;
  /** A marketplace + plugin authored against the `.claude-plugin/` convention. */
  claudeMarketplaceRoot: string;
  claudeDemoRoot: string;
  /**
   * A marketplace whose entry describes a MANIFEST-LESS plugin inline
   * (`strict: false` + `skills: ["./"]`, the shape published catalogs use to
   * ship a bare skill folder).
   */
  bareMarketplaceRoot: string;
}

async function buildFixtures(root: string): Promise<Fixtures> {
  const marketplaceRoot = path.join(root, "market");
  const demoRoot = path.join(marketplaceRoot, "plugins", "demo");
  const badRoot = path.join(marketplaceRoot, "plugins", "bad");
  const escapeRoot = path.join(marketplaceRoot, "plugins", "escape");

  // marketplace.json
  await write(
    path.join(marketplaceRoot, ".easy-agent-plugin", "marketplace.json"),
    JSON.stringify(
      {
        name: "testmp",
        description: "test marketplace",
        plugins: [
          { name: "demo", source: "./plugins/demo" },
          { name: "bad", source: "./plugins/bad" },
        ],
      },
      null,
      2,
    ),
  );

  // demo plugin manifest + one of every component kind
  await write(
    path.join(demoRoot, ".easy-agent-plugin", "plugin.json"),
    JSON.stringify({ name: "demo", version: "1.0.0", description: "demo plugin" }, null, 2),
  );
  await write(
    path.join(demoRoot, "skills", "greet", "SKILL.md"),
    "---\nname: greet\ndescription: Greet the user warmly.\nallowed-tools: Bash(${EASY_AGENT_PLUGIN_ROOT}/bin/*)\n---\nSay hello from ${EASY_AGENT_PLUGIN_ROOT}; data=${EASY_AGENT_PLUGIN_DATA}.\n",
  );
  await write(
    path.join(demoRoot, "commands", "hello.md"),
    "---\ndescription: Say hello.\n---\nGreet $ARGUMENTS from ${EASY_AGENT_PLUGIN_ROOT}.\n",
  );
  await write(
    path.join(demoRoot, "agents", "helper.md"),
    "---\nname: helper\ndescription: A general helper agent for demo tasks.\npermissionMode: auto\nhooks: true\nmcpServers: true\n---\nYou are a helper rooted at ${EASY_AGENT_PLUGIN_ROOT}.\n",
  );
  await write(
    path.join(demoRoot, "output-styles", "fancy.md"),
    "---\nname: fancy\ndescription: A fancy output style.\n---\nRespond with flair using ${EASY_AGENT_PLUGIN_DATA}.\n",
  );
  await write(
    path.join(demoRoot, "hooks", "hooks.json"),
    JSON.stringify(
      { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo ${EASY_AGENT_PLUGIN_ROOT}" }] }] } },
      null,
      2,
    ),
  );
  await write(
    path.join(demoRoot, ".mcp.json"),
    JSON.stringify(
      { mcpServers: { local: { command: "node", args: ["${EASY_AGENT_PLUGIN_ROOT}/server.js"] } } },
      null,
      2,
    ),
  );

  // bad plugin: manifest missing required `name` → strict validation must fail
  await write(
    path.join(badRoot, ".easy-agent-plugin", "plugin.json"),
    JSON.stringify({ version: "9.9.9" }, null, 2),
  );

  // escape plugin: manifest points a component path outside the plugin root
  await write(
    path.join(escapeRoot, ".easy-agent-plugin", "plugin.json"),
    JSON.stringify({ name: "escape", skills: "../../../../etc" }, null, 2),
  );

  // ── `.claude-plugin/` convention: same layout, alternate manifest dir ──
  const claudeMarketplaceRoot = path.join(root, "claude-market");
  const claudeDemoRoot = path.join(claudeMarketplaceRoot, "plugins", "cdemo");
  await write(
    path.join(claudeMarketplaceRoot, ".claude-plugin", "marketplace.json"),
    JSON.stringify(
      {
        name: "claudemp",
        description: "claude-style marketplace",
        plugins: [{ name: "cdemo", source: "./plugins/cdemo" }],
      },
      null,
      2,
    ),
  );
  await write(
    path.join(claudeDemoRoot, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "cdemo", version: "2.0.0", description: "claude-style plugin" }, null, 2),
  );
  await write(
    path.join(claudeDemoRoot, "skills", "wave", "SKILL.md"),
    "---\nname: wave\ndescription: Wave at the user.\n---\nWave hello.\n",
  );

  // ── Catalog-described, manifest-less plugin (a bare skill folder) ──
  const bareMarketplaceRoot = path.join(root, "bare-market");
  await write(
    path.join(bareMarketplaceRoot, ".claude-plugin", "marketplace.json"),
    JSON.stringify(
      {
        name: "barepack",
        plugins: [
          { name: "bare-pack", source: "./skills/solo", strict: false, skills: ["./"] },
        ],
      },
      null,
      2,
    ),
  );
  // No plugin.json anywhere, and SKILL.md sits at the component path's root.
  await write(
    path.join(bareMarketplaceRoot, "skills", "solo", "SKILL.md"),
    "---\nname: solo\ndescription: A standalone packaged skill.\n---\nDo the solo thing.\n",
  );

  return {
    marketplaceRoot,
    demoRoot,
    escapeRoot,
    claudeMarketplaceRoot,
    claudeDemoRoot,
    bareMarketplaceRoot,
  };
}

// ─── main ─────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ea-stage35-work-"));
  const projectCwd = await fs.mkdtemp(path.join(os.tmpdir(), "ea-stage35-proj-"));
  const fx = await buildFixtures(workRoot);

  // [1] schemas
  section("[1] schema validation");
  assert(PluginManifestSchema.safeParse({ name: "ok", version: "1.0.0" }).success, "valid plugin.json parses");
  assert(!PluginManifestSchema.safeParse({}).success, "plugin.json missing name rejected");
  assert(!PluginManifestSchema.safeParse({ name: "x", skills: "../evil" }).success, "'..' in component path rejected");
  assert(!PluginManifestSchema.safeParse({ name: "x", skills: "/abs" }).success, "absolute component path rejected");
  assert(MarketplaceManifestSchema.safeParse({ name: "m", plugins: [] }).success, "valid marketplace.json parses");
  assert(!MarketplaceManifestSchema.safeParse({ plugins: [] }).success, "marketplace.json missing name rejected");

  // [2] namespace helpers
  section("[2] namespace helpers");
  assert(applyNamespace("demo", "greet") === "demo:greet", "applyNamespace prefixes");
  assert(applyNamespace("demo", "demo:greet") === "demo:greet", "applyNamespace idempotent");
  assert(splitNamespace("demo:greet")?.pluginName === "demo", "splitNamespace pluginName");
  assert(splitNamespace("bare") === null, "splitNamespace null for unqualified");
  assert(
    mcpServerNamespace("demo", "local") === "plugin:demo:local",
    "mcpServerNamespace uses plugin:<plugin>:<server>",
  );
  assert(substitutePluginVars("a/${EASY_AGENT_PLUGIN_ROOT}/b", { root: "/R", data: "/D" }) === "a//R/b", "var substitution");
  assert(safePathSegment("../../escape") !== "../../escape", "unsafe version/path segment is sanitized");
  const hostileCache = getPluginCacheDir("team", "demo", "../../escape");
  assert(
    path.relative(getPluginCacheRoot(), hostileCache).split(path.sep).length === 3,
    "hostile version stays in exactly one cache slot",
  );

  // [3] path containment
  section("[3] component-path containment");
  const inside = await resolveInsidePlugin(fx.demoRoot, "skills");
  assert(inside.ok, "in-root path accepted");
  const escape = await resolveInsidePlugin(fx.demoRoot, "../../../../etc");
  assert(!escape.ok, "escaping path rejected");
  // Regression: an absent optional dir must be allowed even when the plugin
  // root sits under a symlinked ancestor (macOS /var → /private/var).
  const absent = await resolveInsidePlugin(fx.demoRoot, "not-there");
  assert(absent.ok, "absent optional dir allowed under a symlinked root");
  const absentDeep = await resolveInsidePlugin(fx.demoRoot, "a/b/c");
  assert(absentDeep.ok, "absent nested dir allowed under a symlinked root");
  const absentEscape = await resolveInsidePlugin(fx.demoRoot, "../../nope-outside");
  assert(!absentEscape.ok, "absent ESCAPING dir still rejected");

  // [4] loader
  section("[4] loader: namespace + provenance + substitution");
  const loaded = await loadPlugin({ root: fx.demoRoot, pluginId: "demo@testmp", strict: true });
  assert(loaded.errors.length === 0, "demo plugin loads with no errors");
  assert(loaded.skills[0]?.name === "demo:greet", "skill namespaced → demo:greet");
  assert(loaded.skills[0]?.source === "plugin" && loaded.skills[0]?.pluginId === "demo@testmp", "skill provenance stamped");
  assert(
    loaded.skills[0]?.body.includes(fx.demoRoot) &&
      loaded.skills[0]?.body.includes(getPluginDataDir("demo@testmp")),
    "skill body substitutes ROOT + DATA",
  );
  assert(
    loaded.skills[0]?.frontmatter.allowedTools[0]?.includes(fx.demoRoot),
    "skill allowed-tools substitutes ROOT",
  );
  assert(loaded.commands[0]?.name === "demo:hello", "command namespaced → demo:hello");
  assert(loaded.commands[0]?.body.includes(fx.demoRoot), "command body substitutes ROOT");
  assert(loaded.agents[0]?.agentType === "demo:helper", "agent namespaced → demo:helper");
  assert(loaded.agents[0]?.permissionMode === undefined, "plugin agent permissionMode is ignored");
  assert(
    loaded.agents[0]?.getSystemPrompt().includes(fx.demoRoot),
    "agent prompt substitutes ROOT",
  );
  assert(
    loaded.warnings.some((warning) => warning.includes("permissionMode")) &&
      loaded.warnings.some((warning) => warning.includes("hooks")) &&
      loaded.warnings.some((warning) => warning.includes("mcpServers")),
    "ignored plugin-agent executable/permission fields emit warnings",
  );
  assert(loaded.outputStyles.some((s) => s.name === "demo:fancy"), "output style namespaced → demo:fancy");
  assert(
    loaded.outputStyles.some(
      (style) =>
        style.name === "demo:fancy" &&
        style.prompt.includes(getPluginDataDir("demo@testmp")),
    ),
    "output style prompt substitutes DATA",
  );
  assert(loaded.hooks.length === 1 && loaded.hooks[0].event === "PreToolUse", "hooks parsed");
  assert(loaded.hooks[0].hooks[0].command === `echo ${fx.demoRoot}`, "hook ${ROOT} substituted");
  assert(
    loaded.hooks[0].hooks[0].env?.EASY_AGENT_PLUGIN_ROOT === fx.demoRoot &&
      loaded.hooks[0].hooks[0].env?.EASY_AGENT_PLUGIN_DATA ===
        getPluginDataDir("demo@testmp"),
    "hook subprocess receives ROOT + DATA env",
  );
  assert(
    loaded.mcpServers[0]?.namespacedName === "plugin:demo:local",
    "mcp server namespaced → plugin:demo:local",
  );
  const mcpArgs = (loaded.mcpServers[0]?.config as { args?: string[] }).args ?? [];
  assert(mcpArgs[0] === `${fx.demoRoot}/server.js`, "mcp ${ROOT} substituted");
  const mcpEnv =
    (loaded.mcpServers[0]?.config as { env?: Record<string, string> }).env ?? {};
  assert(
    mcpEnv.EASY_AGENT_PLUGIN_ROOT === fx.demoRoot &&
      mcpEnv.EASY_AGENT_PLUGIN_DATA === getPluginDataDir("demo@testmp"),
    "MCP subprocess receives ROOT + DATA env",
  );
  assert(loaded.hasExecutableComponents, "hooks/mcp flagged as executable");

  const escapeLoaded = await loadPlugin({ root: fx.escapeRoot, pluginId: "escape@testmp", strict: true });
  assert(escapeLoaded.errors.some((e) => e.scope === "manifest"), "escape plugin flagged (invalid manifest path)");

  // [5] marketplace
  section("[5] marketplace add / list / resolve");
  const added = await marketplace.addMarketplace({ kind: "local", path: fx.marketplaceRoot });
  assert(added.name === "testmp", "addMarketplace returns testmp");
  const list = await marketplace.listMarketplaces();
  assert(list.length === 1 && list[0].name === "testmp", "listMarketplaces shows one");
  const resolved = await marketplace.resolvePlugin("demo@testmp");
  assert(resolved.pluginSource.kind === "local", "resolvePlugin → local source");
  await assertThrows(() => marketplace.resolvePlugin("nope@testmp"), "resolve unknown plugin throws");

  const commandContext: CommandContext = {
    cwd: projectCwd,
    sessionId: "stage35-command-progress",
    defaultModel: "test-model",
    getMessages: () => [],
    getTotalUsage: () => ({ input_tokens: 0, output_tokens: 0 }),
    getActiveModel: () => "test-model",
    getModelSource: () => "default",
    getPermissionMode: () => "default",
    getPrePlanMode: () => null,
    applyRestoredSession: () => {},
    getPermissionSettings: () => undefined,
    getSessionPermissionRules: () => ({ allow: [], deny: [] }),
    reloadPermissionSettings: async () => {},
  };
  const marketplaceUpdateRun = handlePluginCommand(
    commandContext,
    ["marketplace", "update", "testmp"],
  );
  const progressEvent = await marketplaceUpdateRun.next();
  assert(
    !progressEvent.done && progressEvent.value.type === "command_progress",
    "marketplace mutation yields progress before its asynchronous work",
  );
  const resultEvent = await marketplaceUpdateRun.next();
  assert(
    !resultEvent.done &&
      resultEvent.value.type === "command" &&
      resultEvent.value.message.startsWith("Marketplace updated:"),
    "marketplace mutation yields its final result without another user input",
  );
  await marketplaceUpdateRun.return({ handled: true });

  // [5b] Git refs accept raw commit SHAs, not only branch/tag names.
  section("[5b] Git raw-SHA clone/update");
  const gitOrigin = path.join(workRoot, "git-origin");
  const gitCloneDir = path.join(workRoot, "git-clone");
  await fs.mkdir(gitOrigin, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: gitOrigin });
  await write(path.join(gitOrigin, "version.txt"), "one\n");
  await execFileAsync("git", ["add", "version.txt"], { cwd: gitOrigin });
  await execFileAsync(
    "git",
    ["-c", "user.name=Stage35", "-c", "user.email=stage35@example.invalid", "commit", "-m", "one"],
    { cwd: gitOrigin },
  );
  const sha1 = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: gitOrigin })).stdout.trim();
  await gitClone(gitOrigin, gitCloneDir, sha1);
  assert((await gitHeadCommit(gitCloneDir)) === sha1.slice(0, 12), "gitClone accepts a raw commit SHA");

  await write(path.join(gitOrigin, "version.txt"), "two\n");
  await execFileAsync("git", ["add", "version.txt"], { cwd: gitOrigin });
  await execFileAsync(
    "git",
    ["-c", "user.name=Stage35", "-c", "user.email=stage35@example.invalid", "commit", "-m", "two"],
    { cwd: gitOrigin },
  );
  const sha2 = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: gitOrigin })).stdout.trim();
  await gitUpdate(gitCloneDir, sha2);
  assert((await gitHeadCommit(gitCloneDir)) === sha2.slice(0, 12), "gitUpdate accepts a raw commit SHA");

  await execFileAsync("git", ["init"], { cwd: fx.claudeMarketplaceRoot });
  await execFileAsync("git", ["add", "."], { cwd: fx.claudeMarketplaceRoot });
  await execFileAsync(
    "git",
    ["-c", "user.name=Stage35", "-c", "user.email=stage35@example.invalid", "commit", "-m", "marketplace"],
    { cwd: fx.claudeMarketplaceRoot },
  );
  const marketplaceSha = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: fx.claudeMarketplaceRoot })
  ).stdout.trim();
  const gitMarketplace = await marketplace.addMarketplace({
    kind: "git",
    url: fx.claudeMarketplaceRoot,
    ref: marketplaceSha,
  });
  assert(
    gitMarketplace.name === "claudemp" &&
      gitMarketplace.installLocation !== fx.claudeMarketplaceRoot,
    "Git marketplace clones into a separate managed directory",
  );
  const gitMarketplaceInstall = await installPlugin("cdemo@claudemp", "user", projectCwd);
  assert(
    gitMarketplaceInstall.loaded.skills.some((skill) => skill.name === "cdemo:wave"),
    "plugin installs from a Git marketplace",
  );
  await marketplace.removeMarketplace("claudemp");
  runtime._resetPluginRuntimeForTesting();
  const offlineCacheReload = await runtime.refreshActivePlugins(projectCwd, { applyMcp: false });
  assert(
    offlineCacheReload.plugins.some((plugin) => plugin.pluginId === "cdemo@claudemp") &&
      findSkill("cdemo:wave") !== undefined,
    "installed Git plugin reloads from cache after its marketplace is removed",
  );
  assert(
    await fs.stat(fx.claudeMarketplaceRoot).then(() => true).catch(() => false),
    "removing a Git marketplace never deletes its source repository",
  );
  await uninstallPlugin("cdemo@claudemp", { scope: "user", cwd: projectCwd });

  // [6] install + rollback
  section("[6] install + atomic rollback");
  await assertThrows(
    () => installPlugin("demo@testmp", "user"),
    "headless executable install fails closed without confirmation",
  );
  const preview = await inspectPlugin("demo@testmp");
  assert(
    preview.hasExecutableComponents &&
      preview.components.hooks.length === 1 &&
      preview.components.mcpServers.length === 1,
    "install preflight reports exact executable component list",
  );
  const changedAfterPreview = path.join(fx.demoRoot, "changed-after-preview.txt");
  await write(changedAfterPreview, "changed\n");
  await assertThrows(
    () =>
      installPlugin("demo@testmp", "user", process.cwd(), {
        allowExecutableComponents: true,
        expectedFingerprint: preview.fingerprint,
      }),
    "content fingerprint rejects a package changed after confirmation",
  );
  await fs.rm(changedAfterPreview);
  const install = await installPlugin("demo@testmp", "user", process.cwd(), {
    allowExecutableComponents: true,
  });
  assert(install.record.pluginId === "demo@testmp" && install.record.version === "1.0.0", "install record correct");
  assert(isManagedPluginPath(install.record.installPath), "install path is under managed cache");
  const cacheExists = await fs.stat(install.record.installPath).then(() => true).catch(() => false);
  assert(cacheExists, "version-locked cache dir created");
  assert((await getEnabledPluginIds(projectCwd)).has("demo@testmp"), "user-scope enable is visible from any cwd");
  assert((await readInstalledPlugins()).plugins["demo@testmp"] !== undefined, "installed record persisted");

  await assertThrows(() => installPlugin("bad@testmp", "user"), "installing invalid plugin throws");
  assert((await readInstalledPlugins()).plugins["bad@testmp"] === undefined, "ROLLBACK: bad plugin left no install record");

  // [7] enable scope + live reload into registries
  section("[7] per-scope enable + live reload");
  runtime._resetPluginRuntimeForTesting();
  // installPlugin enabled it at USER scope already; refresh against projectCwd.
  let res = await runtime.refreshActivePlugins(projectCwd, { applyMcp: false });
  assert(res.plugins.length === 1, "refresh picks up 1 enabled plugin");
  assert(findSkill("demo:greet") !== undefined, "skill registry has demo:greet after refresh");
  assert(
    matchesPermissionRule("Skill(demo:*)", "Skill", { skill: "demo:greet" }),
    "Skill(plugin:*) permission rule matches a namespaced skill",
  );
  const skillResult = await skillTool.call(
    { skill: "demo:greet", args: "Stage 35" },
    { cwd: projectCwd, sessionId: "stage35-plugin-test" },
  );
  assert(
    !skillResult.isError &&
      typeof skillResult.content === "string" &&
      skillResult.content.includes('Loaded skill "demo:greet"'),
    'Skill(skill="plugin:name") executes through SkillTool',
  );
  assert(findAgent("demo:helper") !== undefined, "agent registry has demo:helper");
  assert(getAllUserCommands().some((c) => c.name === "demo:hello"), "command registry has demo:hello");
  assert(resolveOutputStyle("demo:fancy") !== undefined, "style registry has demo:fancy");

  assert(setActiveOutputStyle("demo:fancy"), "plugin output style can become active");
  await setPluginEnabled(projectCwd, "demo@testmp", false, "user");
  res = await runtime.refreshActivePlugins(projectCwd, { applyMcp: false });
  assert(res.plugins.length === 0, "disable removes the plugin");
  assert(findSkill("demo:greet") === undefined, "skill registry no longer has demo:greet");
  assert(getAllUserCommands().every((c) => c.name !== "demo:hello"), "command registry no longer has demo:hello");
  assert(
    getActiveOutputStyleName() === "default",
    "disabled plugin's active output style falls back to default",
  );

  await setPluginEnabled(projectCwd, "demo@testmp", true, "user");
  res = await runtime.refreshActivePlugins(projectCwd, { applyMcp: false });
  assert(res.plugins.length === 1 && findSkill("demo:greet") !== undefined, "re-enable restores the plugin");

  const devRoot = path.join(workRoot, "dev-demo");
  await write(
    path.join(devRoot, ".easy-agent-plugin", "plugin.json"),
    JSON.stringify({ name: "demo", version: "dev" }),
  );
  await write(
    path.join(devRoot, "skills", "dev", "SKILL.md"),
    "---\nname: dev\ndescription: Development override.\n---\nUse the development build.\n",
  );
  res = await runtime.refreshActivePlugins(projectCwd, {
    applyMcp: false,
    pluginDirs: [devRoot],
  });
  assert(
    res.plugins.length === 1 &&
      res.plugins[0]?.pluginId.endsWith("@dev") &&
      findSkill("demo:dev") !== undefined &&
      findSkill("demo:greet") === undefined,
    "--plugin-dir deterministically overrides an installed plugin with the same name",
  );
  res = await runtime.refreshActivePlugins(projectCwd, { applyMcp: false });
  assert(
    findSkill("demo:dev") !== undefined,
    "session --plugin-dir roots survive subsequent mutation/reload calls",
  );
  await runtime.refreshActivePlugins(projectCwd, {
    applyMcp: false,
    pluginDirs: [],
  });
  assert(findSkill("demo:greet") !== undefined, "clearing dev roots restores installed plugin");

  // [8] trust gating of executable components
  section("[8] trust gating (hooks/MCP)");
  runtime._resetPluginRuntimeForTesting();
  // Move enablement to PROJECT scope so trust applies (user scope is always trusted).
  await setPluginEnabled(projectCwd, "demo@testmp", null, "user");
  await setPluginEnabled(projectCwd, "demo@testmp", true, "project");
  const risks = await detectRisks(projectCwd);
  assert(
    risks.some((risk) => risk.includes("project plugins")),
    "trust gate warns about project-level enabledPlugins",
  );
  resetGlobalStateCache();
  res = await runtime.refreshActivePlugins(projectCwd, { applyMcp: false });
  assert(res.plugins.length === 0, "UNTRUSTED: project-enabled plugin is not activated");
  assert(Object.keys(runtime.getActivePluginHooks()).length === 0, "UNTRUSTED: plugin hooks NOT applied");

  await trustProject(projectCwd);
  resetGlobalStateCache();
  res = await runtime.refreshActivePlugins(projectCwd, { applyMcp: false });
  assert(res.plugins.length === 1, "TRUSTED: project-enabled plugin is activated");
  assert((runtime.getActivePluginHooks().PreToolUse?.length ?? 0) === 1, "TRUSTED: plugin hooks applied");

  // [8b] deterministic manifest-name conflict
  section("[8b] duplicate plugin-name conflict");
  const conflictMarket = path.join(workRoot, "conflict-market");
  const conflictPlugin = path.join(conflictMarket, "plugins", "demo-alt");
  await fs.cp(fx.demoRoot, conflictPlugin, { recursive: true });
  await write(
    path.join(conflictMarket, ".easy-agent-plugin", "marketplace.json"),
    JSON.stringify({
      name: "conflict",
      plugins: [{ name: "demo-alt", source: "./plugins/demo-alt" }],
    }),
  );
  await marketplace.addMarketplace({ kind: "local", path: conflictMarket });
  await installPlugin("demo-alt@conflict", "user", projectCwd, {
    allowExecutableComponents: true,
  });
  res = await runtime.refreshActivePlugins(projectCwd, { applyMcp: false });
  assert(
    res.plugins.filter((plugin) => plugin.name === "demo").length === 1,
    "only one plugin with manifest name 'demo' becomes active",
  );
  assert(
    res.errors.some(
      (issue) => issue.scope === "manifest" && issue.message.includes("conflicts with"),
    ),
    "duplicate manifest name produces a structured deterministic error",
  );
  await uninstallPlugin("demo-alt@conflict", { scope: "user", cwd: projectCwd });
  await marketplace.removeMarketplace("conflict");
  await runtime.refreshActivePlugins(projectCwd, { applyMcp: false });

  // [9] MCP diff purity + cleanup
  section("[9] MCP diff + cleanup");
  const a = new Map([["plugin:demo:local", { type: "stdio", command: "node", scope: "project" } as never]]);
  const b = new Map([["plugin:demo:local", { type: "stdio", command: "node", scope: "project" } as never]]);
  const c = new Map([["plugin:demo:other", { type: "stdio", command: "node", scope: "project" } as never]]);
  assert(diffMcpServers(a, b).added.length === 0 && diffMcpServers(a, b).removed.length === 0, "identical maps → no churn");
  assert(
    diffMcpServers(a, c).added[0] === "plugin:demo:other" &&
      diffMcpServers(a, c).removed[0] === "plugin:demo:local",
    "diff detects add + remove",
  );

  // Seed a fake registry entry, then reconcile to empty → it must be torn down.
  const fakeCfg = { type: "stdio", command: "node", scope: "project" } as never;
  setMcpRegistryEntry("plugin:demo:local", { name: "plugin:demo:local", type: "failed", error: "seeded", config: fakeCfg } as never, []);
  const staleChurn = await applyPluginMcpDiff(
    new Map([["plugin:demo:local", fakeCfg]]),
    new Map(),
    { generation: 1, isCurrent: () => false },
  );
  assert(
    staleChurn.stopped.length === 0 &&
      getMcpRegistryEntry("plugin:demo:local") !== undefined,
    "stale MCP generation cannot remove a newer registry entry",
  );
  const churn = await applyPluginMcpDiff(new Map([["plugin:demo:local", fakeCfg]]), new Map());
  assert(churn.stopped.includes("plugin:demo:local"), "reconcile-to-empty reports plugin:demo:local stopped");
  assert(getMcpRegistryEntry("plugin:demo:local") === undefined, "MCP cleanup removed the registry entry");

  // [10] uninstall + delete safety
  section("[10] uninstall + delete safety");
  const installPathBefore = (await readInstalledPlugins()).plugins["demo@testmp"].installPath;
  await uninstallPlugin("demo@testmp", { scope: "project" });
  assert(
    (await readInstalledPlugins()).plugins["demo@testmp"] !== undefined,
    "project uninstall preserves a user-scope installation",
  );
  const cacheStillPresent = await fs.stat(installPathBefore).then(() => true).catch(() => false);
  assert(cacheStillPresent, "shared cache remains while another scope owns the install");
  await uninstallPlugin("demo@testmp", { scope: "user" });
  assert(
    (await readInstalledPlugins()).plugins["demo@testmp"] === undefined,
    "last-scope uninstall drops the install record",
  );
  const cacheGone = await fs.stat(installPathBefore).then(() => false).catch(() => true);
  assert(cacheGone, "managed cache dir deleted after the last owner uninstalls");
  const fixtureIntact = await fs.stat(fx.demoRoot).then(() => true).catch(() => false);
  assert(fixtureIntact, "SAFETY: source fixture dir NOT deleted");
  assert(!isManagedPluginPath(fx.demoRoot), "fixture dir correctly classified as unmanaged");

  // [11] `.claude-plugin/` directory compatibility
  section("[11] .claude-plugin directory compatibility");
  const claudeRead = await marketplace.readMarketplaceManifest(fx.claudeMarketplaceRoot);
  assert(claudeRead.manifest.name === "claudemp", "reads marketplace.json from .claude-plugin/");
  assert(claudeRead.root === fx.claudeMarketplaceRoot, "marketplace root resolves to the fixture dir");
  const claudeLoaded = await loadPlugin({ root: fx.claudeDemoRoot, pluginId: "cdemo@claudemp", strict: true });
  assert(claudeLoaded.errors.length === 0, "loads plugin.json from .claude-plugin/");
  assert(claudeLoaded.version === "2.0.0", "manifest version read from .claude-plugin/");
  assert(claudeLoaded.skills.some((s) => s.name === "cdemo:wave"), "namespaces skill from a .claude-plugin plugin");
  const claudeAdded = await marketplace.addMarketplace({ kind: "local", path: fx.claudeMarketplaceRoot });
  assert(claudeAdded.name === "claudemp", "addMarketplace accepts a .claude-plugin marketplace");
  const claudeResolved = await marketplace.resolvePlugin("cdemo@claudemp");
  assert(claudeResolved.pluginSource.kind === "local", "resolvePlugin works across .claude-plugin marketplace");
  await marketplace.removeMarketplace("claudemp");

  // [12] catalog-described plugin: no plugin.json + inline component paths
  section("[12] manifest-less plugin described by its catalog entry");
  await marketplace.addMarketplace({ kind: "local", path: fx.bareMarketplaceRoot });
  const bareInstall = await installPlugin("bare-pack@barepack", "user");
  assert(bareInstall.loaded.errors.length === 0, "strict:false entry installs without a plugin.json");
  assert(
    bareInstall.loaded.skills.some((s) => s.name === "bare-pack:solo"),
    "inline skills:['./'] loads the dir's own SKILL.md",
  );
  assert(
    bareInstall.loaded.name === "bare-pack",
    "plugin name comes from the entry, not the temp/cache dir basename",
  );
  const bareRecord = (await readInstalledPlugins()).plugins["bare-pack@barepack"];
  assert(bareRecord?.strict === false, "record persists strict:false");
  assert(
    JSON.stringify(bareRecord?.componentPaths?.skills) === JSON.stringify(["./"]),
    "record persists the inline component paths",
  );

  // The point of persisting them: a cold reload must NOT lose the components.
  runtime._resetPluginRuntimeForTesting();
  const bareRes = await runtime.refreshActivePlugins(projectCwd, { applyMcp: false });
  assert(
    bareRes.plugins.some((p) => p.pluginId === "bare-pack@barepack"),
    "catalog-described plugin is active after a cold reload",
  );
  assert(findSkill("bare-pack:solo") !== undefined, "its skill survives the reload (overlay replayed)");

  // ── teardown ──
  await fs.rm(workRoot, { recursive: true, force: true }).catch(() => {});
  await fs.rm(projectCwd, { recursive: true, force: true }).catch(() => {});
  await fs.rm(SANDBOX_HOME, { recursive: true, force: true }).catch(() => {});

  process.stdout.write(`\n\u001b[1mStage 35: ${passed} passed, ${failed} failed.\u001b[0m\n`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
