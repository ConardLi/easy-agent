/**
 * Plugin Runtime (plan §35.7).
 *
 * The single orchestrator that turns "which plugins are installed + enabled"
 * into live registry state. It owns registry population for the four
 * markdown-based subsystems (skills / agents / commands / output styles) so it
 * can layer plugin components on top of the built-in + user + project base in a
 * single, idempotent pass — call `refreshActivePlugins(cwd)` again any time
 * (install / enable / disable / update) and the registries converge to match.
 *
 * Component precedence (plan §35.2):
 *   built-in  →  plugin  →  user  →  project      (later wins on bare-name
 * collisions). In practice plugin components are namespaced (`plugin:foo`) so
 * they never collide with a user/project component — the ordering only matters
 * for the theoretical un-namespaced case.
 *
 * Executable components (hooks / MCP servers) are TRUST-GATED: a plugin enabled
 * only via project/local scope in an untrusted folder contributes its prompt
 * components but NOT its hooks/MCP, mirroring how project hooks + statusLine are
 * gated. A user-scope-enabled plugin is the user's own machine-level choice and
 * always runs.
 */

import * as path from "node:path";
import { applyLspServers } from "../services/lsp/runtime.js";
import { loadAllSkills } from "../services/skills/loadSkillsDir.js";
import { setSkills } from "../services/skills/registry.js";
import { getBuiltInAgents } from "../agents/builtIn/index.js";
import { loadAllCustomAgents } from "../agents/loadAgentsDir.js";
import { setAgents } from "../agents/registry.js";
import { loadAllUserCommands } from "../commands/userCommands/loadCommandsDir.js";
import { setUserCommands } from "../commands/userCommands/registry.js";
import { loadAllOutputStyles } from "../styles/loadOutputStylesDir.js";
import {
  ensureActiveOutputStyleAvailable,
  setCustomOutputStyles,
} from "../styles/registry.js";
import { isProjectTrusted } from "../config/globalState.js";
import type { HooksSettings } from "../hooks/types.js";
import type { ScopedMcpServerConfig } from "../types/mcp.js";
import { readInstalledPlugins } from "./state.js";
import { getEnabledPluginState } from "./enable.js";
import { loadPlugin } from "./loader.js";
import { applyPluginMcpDiff } from "./mcpApply.js";
import type { LoadedPlugin } from "./loadedTypes.js";
import type { PluginError } from "./schemas.js";

export interface RefreshOptions {
  /** Extra dev plugin roots from `--plugin-dir` (lenient, always trusted). */
  pluginDirs?: string[];
  /** Skip the (network/subprocess) MCP apply — used by headless tests. */
  applyMcp?: boolean;
}

export interface RefreshResult {
  plugins: LoadedPlugin[];
  errors: PluginError[];
  /** Namespaced MCP server ids that were (re)started this refresh. */
  mcpStarted: string[];
  /** Namespaced MCP server ids that were torn down this refresh. */
  mcpStopped: string[];
  summary: {
    enabledPlugins: number;
    disabledPlugins: number;
    skills: number;
    agents: number;
    commands: number;
    outputStyles: number;
    hooks: number;
    mcpServers: number;
    lspServers: number;
    errors: number;
  };
}

// ─── module state ─────────────────────────────────────────────────────

let activePlugins: LoadedPlugin[] = [];
let activeErrors: PluginError[] = [];
let activeHooks: HooksSettings = {};
let sessionPluginDirs: string[] = [];
let refreshGeneration = 0;
let refreshQueue: Promise<void> = Promise.resolve();

/** Snapshot of the plugin MCP configs currently applied (namespaced name → cfg). */
let appliedMcp = new Map<string, ScopedMcpServerConfig>();

export function getActivePlugins(): LoadedPlugin[] {
  return activePlugins;
}

export function getActivePluginErrors(): PluginError[] {
  return activeErrors;
}

/** Plugin-contributed hooks, in the same shape the hook executor consumes. */
export function getActivePluginHooks(): HooksSettings {
  return activeHooks;
}

/** Test seam: forget all applied plugin state (does NOT touch registries). */
export function _resetPluginRuntimeForTesting(): void {
  activePlugins = [];
  activeErrors = [];
  activeHooks = {};
  appliedMcp = new Map();
  sessionPluginDirs = [];
  refreshGeneration = 0;
  refreshQueue = Promise.resolve();
}

// ─── discovery ────────────────────────────────────────────────────────

/**
 * Load every enabled + installed plugin plus any `--plugin-dir` dev roots.
 * A single plugin that fails to load contributes its `errors` but never aborts
 * the others (plan §35.2 fail-soft).
 */
async function discoverPlugins(cwd: string, pluginDirs: string[]): Promise<{
  plugins: LoadedPlugin[];
  trustedById: Map<string, boolean>;
  errors: PluginError[];
  enabledCount: number;
  disabledCount: number;
}> {
  const trusted = await isProjectTrusted(cwd);
  const { enabled, bySource } = await getEnabledPluginState(cwd);
  const installed = (await readInstalledPlugins()).plugins;

  const pluginsByName = new Map<string, LoadedPlugin>();
  const trustedById = new Map<string, boolean>();
  const errors: PluginError[] = [];

  for (const pluginId of [...enabled].sort()) {
    const record = installed[pluginId];
    if (!record) {
      errors.push({
        pluginId,
        scope: "io",
        message: "Plugin is enabled but has no installation record. Reinstall or disable it.",
      });
      continue;
    }
    try {
      // Replay the load options captured at install time, so a plugin whose
      // identity/layout is described by its marketplace still resolves after a
      // restart (or after that marketplace has been removed).
      const loaded = await loadPlugin({
        root: record.installPath,
        pluginId,
        strict: record.strict !== false,
        nameHint: record.name,
        ...(record.componentPaths ? { overlay: record.componentPaths } : {}),
      });
      if (loaded.errors.some((issue) => issue.scope === "manifest")) {
        errors.push(...loaded.errors);
        continue;
      }
      const previous = pluginsByName.get(loaded.name);
      if (previous) {
        errors.push({
          pluginId,
          scope: "manifest",
          message:
            `Plugin name "${loaded.name}" conflicts with ${previous.pluginId}; ` +
            "the first enabled plugin wins.",
        });
        continue;
      }
      pluginsByName.set(loaded.name, loaded);
      // user-scope enable → always trusted; project/local → gated by folder trust.
      const scope = bySource.get(pluginId);
      trustedById.set(pluginId, scope === "user" ? true : trusted);
    } catch (error) {
      errors.push({ pluginId, scope: "io", message: (error as Error).message });
    }
  }

  // Dev plugin dirs: lenient manifest, always fully trusted (explicit CLI
  // flag), and intentionally override an installed plugin with the same
  // manifest name so plugin authors can test local changes.
  for (const dir of pluginDirs) {
    const pluginId = `${devName(dir)}@dev`;
    try {
      const loaded = await loadPlugin({ root: dir, pluginId, strict: false });
      if (loaded.errors.some((issue) => issue.scope === "manifest")) {
        errors.push(...loaded.errors);
        continue;
      }
      const previous = pluginsByName.get(loaded.name);
      if (previous) {
        trustedById.delete(previous.pluginId);
        errors.push({
          pluginId: previous.pluginId,
          scope: "manifest",
          message: `Overridden by development plugin ${pluginId} (name "${loaded.name}").`,
        });
      }
      pluginsByName.set(loaded.name, loaded);
      trustedById.set(pluginId, true);
    } catch (error) {
      errors.push({ pluginId, scope: "io", message: (error as Error).message });
    }
  }

  const installedIds = Object.keys(installed);
  return {
    plugins: [...pluginsByName.values()],
    trustedById,
    errors,
    enabledCount: [...enabled].filter((id) => installed[id] !== undefined).length,
    disabledCount: installedIds.filter((id) => !enabled.has(id)).length,
  };
}

function devName(dir: string): string {
  const base = dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "plugin";
  return base.replace(/[^a-zA-Z0-9_-]/g, "-") || "plugin";
}

// ─── apply ────────────────────────────────────────────────────────────

/**
 * Reconcile the live registries with the current install/enable state. Safe to
 * call repeatedly. Returns the loaded plugins + a summary of MCP churn.
 */
export async function refreshActivePlugins(
  cwd: string,
  opts: RefreshOptions = {},
): Promise<RefreshResult> {
  if (opts.pluginDirs !== undefined) {
    sessionPluginDirs = [...new Set(opts.pluginDirs.map((dir) => path.resolve(cwd, dir)))];
  }
  const effectiveOptions: RefreshOptions = {
    ...opts,
    pluginDirs: [...sessionPluginDirs],
  };

  // Serialize refreshes. Install/enable UI actions can arrive close together;
  // without this queue, a slower older load could overwrite a newer snapshot.
  let resolveRun!: (result: RefreshResult) => void;
  let rejectRun!: (error: unknown) => void;
  const result = new Promise<RefreshResult>((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
  });
  refreshQueue = refreshQueue
    .catch(() => undefined)
    .then(async () => {
      try {
        const prepared = await performRefresh(cwd, effectiveOptions);
        // Release the snapshot mutex before MCP handshakes finish. A newer
        // refresh can now advance the generation and cancel late old results.
        void prepared.completion.then(resolveRun, rejectRun);
      } catch (error) {
        rejectRun(error);
      }
    });
  return result;
}

async function performRefresh(
  cwd: string,
  opts: RefreshOptions,
): Promise<{ completion: Promise<RefreshResult> }> {
  const {
    plugins,
    trustedById,
    errors: discoveryErrors,
    enabledCount,
    disabledCount,
  } = await discoverPlugins(
    cwd,
    opts.pluginDirs ?? [],
  );
  const nextErrors = [
    ...discoveryErrors,
    ...plugins.flatMap((plugin) => plugin.errors),
  ];

  // Build the complete prospective snapshot first. A loader exception leaves
  // every currently active registry untouched.
  // ── Base (built-in + user + project) reloaded fresh each time ──
  const [baseSkills, customAgents, baseCommands, baseStyles] = await Promise.all([
    loadAllSkills(cwd),
    loadAllCustomAgents(cwd),
    loadAllUserCommands(cwd),
    loadAllOutputStyles(cwd),
  ]);

  // ── Merge plugin components on top (namespaced → no real collisions) ──
  const pluginSkills = plugins.flatMap((p) => p.skills);
  const pluginAgents = plugins.flatMap((p) => p.agents);
  const pluginCommands = plugins.flatMap((p) => p.commands);
  const pluginStyles = plugins.flatMap((p) => p.outputStyles);
  const nextSkills = [...pluginSkills, ...baseSkills.skills];
  const nextAgents = [...getBuiltInAgents(), ...pluginAgents, ...customAgents.agents];
  const nextCommands = [...pluginCommands, ...baseCommands.commands];
  const nextStyles = [...pluginStyles, ...baseStyles.styles];

  // ── Executable components (trust-gated) ──
  const nextHooks = buildPluginHooksSettings(plugins, trustedById);

  const desiredMcp = new Map<string, ScopedMcpServerConfig>();
  for (const p of plugins) {
    if (!trustedById.get(p.pluginId)) continue;
    for (const server of p.mcpServers) {
      desiredMcp.set(server.namespacedName, server.config);
    }
  }

  // Commit all prompt-side registries in one synchronous section. No async
  // operation can observe a half-updated plugin snapshot.
  setSkills(nextSkills);
  setAgents(nextAgents);
  setUserCommands(nextCommands);
  setCustomOutputStyles(nextStyles);
  if (ensureActiveOutputStyleAvailable()) {
    nextErrors.push({
      pluginId: "runtime",
      scope: "outputStyles",
      message: "The active output style disappeared during reload; reset to default.",
    });
  }
  activePlugins = plugins;
  activeErrors = nextErrors;
  activeHooks = nextHooks;

  const makeResult = (
    mcpStarted: string[] = [],
    mcpStopped: string[] = [],
  ): RefreshResult => ({
    plugins: [...plugins],
    errors: [...nextErrors],
    mcpStarted,
    mcpStopped,
    summary: {
      enabledPlugins: enabledCount,
      disabledPlugins: disabledCount,
      skills: pluginSkills.length,
      agents: pluginAgents.length,
      commands: pluginCommands.length,
      outputStyles: pluginStyles.length,
      hooks: plugins.reduce((sum, plugin) => sum + plugin.hooks.length, 0),
      mcpServers: plugins.reduce((sum, plugin) => sum + plugin.mcpServers.length, 0),
      lspServers: plugins.reduce((sum, plugin) => sum + (plugin.lspServers?.length ?? 0), 0),
      errors: nextErrors.length,
    },
  });

  if (opts.applyMcp !== false) {
    const lspErrors = await applyLspServers(plugins.filter((plugin) => trustedById.get(plugin.pluginId)).flatMap((plugin) =>
      (plugin.lspServers ?? []).map((server) => ({ ...server, cwd }))));
    nextErrors.push(...lspErrors.map((message) => ({ pluginId: "lsp", scope: "io" as const, message })));
    activeErrors = nextErrors;
    const generation = ++refreshGeneration;
    const previousMcp = appliedMcp;
    // Publish intent before connecting so a newer generation diffs against the
    // desired state and can tear down this generation's in-flight servers.
    appliedMcp = desiredMcp;
    const completion = applyPluginMcpDiff(previousMcp, desiredMcp, {
      generation,
      isCurrent: (candidate) => candidate === refreshGeneration,
    }).then((churn) => makeResult(churn.started, churn.stopped));
    return { completion };
  }

  // Prompt-only refreshes intentionally leave the applied MCP snapshot alone;
  // the later real apply must still see these servers as additions/removals.
  return { completion: Promise.resolve(makeResult()) };
}

/** Collect trust-gated plugin hooks into the executor's HooksSettings shape. */
function buildPluginHooksSettings(
  plugins: LoadedPlugin[],
  trustedById: Map<string, boolean>,
): HooksSettings {
  const settings: HooksSettings = {};
  for (const p of plugins) {
    if (!trustedById.get(p.pluginId)) continue;
    for (const entry of p.hooks) {
      const groups = settings[entry.event] ?? (settings[entry.event] = []);
      groups.push({
        hooks: entry.hooks,
        ...(entry.matcher ? { matcher: entry.matcher } : {}),
        pluginId: entry.pluginId,
        pluginRoot: entry.pluginRoot,
      });
    }
  }
  return settings;
}
