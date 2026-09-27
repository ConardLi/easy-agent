/**
 * Plugin Loader (plan §35.2 / §35.3).
 *
 * Turns one plugin directory into a fully-resolved {@link LoadedPlugin}:
 *   1. read + validate `.easy-agent-plugin/plugin.json` (or `.claude-plugin/`)
 *   2. discover components in the default dirs (always) + manifest paths
 *   3. containment-check every path (reject `..` / absolute / escaping symlink)
 *   4. reuse the existing per-dir loaders to parse each component kind
 *   5. apply the `plugin:` namespace + stamp provenance on every component
 *   6. substitute `${EASY_AGENT_PLUGIN_ROOT}` / `${EASY_AGENT_PLUGIN_DATA}`
 *
 * Design rule (plan §35.2): the loader NEVER re-implements a parser. It calls
 * `loadSkillsFromDir` / `loadAgentsFromDir` / `loadCommandsFromDir` /
 * `loadOutputStylesFromDir`, then decorates the results. A single bad
 * component is recorded as a structured {@link PluginError} and skipped — it
 * never aborts the whole plugin (plan §35.2 "one bad plugin doesn't break the
 * others" starts here, at "one bad component doesn't break the plugin").
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { LspServersSchema } from "../services/lsp/schema.js";
import { loadSkillsFromDir } from "../services/skills/loadSkillsDir.js";
import { loadAgentsFromDir } from "../agents/loadAgentsDir.js";
import { loadCommandsFromDir } from "../commands/userCommands/loadCommandsDir.js";
import { loadOutputStylesFromDir } from "../styles/loadOutputStylesDir.js";
import { isHookEvent, type HookCommand, type HookEvent } from "../hooks/types.js";
import type { ScopedMcpServerConfig } from "../types/mcp.js";
import {
  getPluginDataDir,
  getPluginManifestPath,
  getPluginManifestPathCandidates,
  substitutePluginVars,
} from "./paths.js";
import { applyNamespace, mcpServerNamespace } from "./namespace.js";
import { resolveInsidePlugin } from "./pathSafety.js";
import {
  PluginManifestSchema,
  type PluginComponentPaths,
  type PluginError,
  type PluginManifest,
} from "./schemas.js";
import type {
  LoadedPlugin,
  PluginHookEntry,
  PluginMcpServer,
} from "./loadedTypes.js";

export interface LoadPluginOptions {
  /** Absolute plugin root directory. */
  root: string;
  /** Stable id `<name>@<marketplace>`. Also the data-dir key. */
  pluginId: string;
  /**
   * strict (marketplace installs): a valid `plugin.json` is REQUIRED.
   * lenient (`--plugin-dir` dev, or a catalog entry with `strict: false`): a
   * missing manifest is allowed and {@link nameHint} / the directory name is
   * used as the plugin name.
   */
  strict: boolean;
  /**
   * Name to use when no manifest supplies one. Required whenever `root` is a
   * temp/cache directory, since its basename is not a meaningful plugin name.
   */
  nameHint?: string;
  /**
   * Component paths contributed by something other than the plugin's own
   * manifest — a marketplace catalog entry declaring the layout inline. Merged
   * with the manifest's own paths; never replaces them.
   */
  overlay?: PluginComponentPaths;
}

// ─── manifest path helpers ────────────────────────────────────────────

function asPathList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

/**
 * Component dirs to scan: the always-on default, plus every declared path from
 * each source (the plugin manifest and any marketplace-entry overlay).
 * Normalized via `resolve` so `"./"` and a trailing slash de-dupe correctly.
 */
function componentDirs(root: string, defaultDir: string, ...pathSources: unknown[]): string[] {
  const dirs = [
    path.resolve(root, defaultDir),
    ...pathSources.flatMap(asPathList).map((p) => path.resolve(root, p)),
  ];
  // De-dupe while preserving order (a manifest may redundantly list the default).
  return [...new Set(dirs)];
}

async function validatedDirs(
  root: string,
  candidates: string[],
  pluginId: string,
  scope: PluginError["scope"],
  errors: PluginError[],
): Promise<string[]> {
  const ok: string[] = [];
  for (const dir of candidates) {
    const check = await resolveInsidePlugin(root, dir);
    if (!check.ok) {
      errors.push({ pluginId, scope, message: `rejected path ${dir}: ${check.reason}` });
      continue;
    }
    ok.push(check.resolved);
  }
  return ok;
}

// ─── manifest ──────────────────────────────────────────────────────────

interface ManifestResult {
  manifest: PluginManifest | null;
  name: string;
  errors: PluginError[];
  warnings: string[];
}

async function readManifest(opts: LoadPluginOptions): Promise<ManifestResult> {
  const errors: PluginError[] = [];
  const warnings: string[] = [];
  // `root` may be a temp/cache dir, so prefer an explicit hint over basename.
  const fallbackName = opts.nameHint ?? path.basename(opts.root);
  // Accept `.easy-agent-plugin/` or `.claude-plugin/`; first existing wins.
  const candidates = getPluginManifestPathCandidates(opts.root);
  let manifestPath = candidates[0] ?? getPluginManifestPath(opts.root);

  let text: string | null = null;
  for (const candidate of candidates) {
    try {
      text = await fs.readFile(candidate, "utf-8");
      manifestPath = candidate;
      break;
    } catch {
      // try the next candidate
    }
  }

  if (text === null) {
    if (opts.strict) {
      errors.push({
        pluginId: opts.pluginId,
        scope: "manifest",
        message: `missing ${path.relative(opts.root, manifestPath)}`,
      });
      return { manifest: null, name: fallbackName, errors, warnings };
    }
    // Lenient (--plugin-dir): synthesize a minimal manifest from the dir name.
    return {
      manifest: PluginManifestSchema.parse({ name: fallbackName }),
      name: fallbackName,
      errors,
      warnings,
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (error) {
    errors.push({
      pluginId: opts.pluginId,
      scope: "manifest",
      message: `invalid JSON in plugin.json: ${(error as Error).message}`,
    });
    return { manifest: null, name: fallbackName, errors, warnings };
  }

  const result = PluginManifestSchema.safeParse(parsedJson);
  if (!result.success) {
    errors.push({
      pluginId: opts.pluginId,
      scope: "manifest",
      message: `invalid plugin.json: ${result.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")}`,
    });
    return { manifest: null, name: fallbackName, errors, warnings };
  }

  // Forward-compat: warn about unknown top-level keys but keep loading.
  const known = new Set([
    "name", "version", "description", "author", "homepage", "repository",
    "license", "keywords", "skills", "agents", "commands", "outputStyles",
    "hooks", "mcpServers", "lspServers",
  ]);
  for (const key of Object.keys(parsedJson as Record<string, unknown>)) {
    if (!known.has(key)) warnings.push(`unknown plugin.json field "${key}" (ignored)`);
  }

  return { manifest: result.data, name: result.data.name, errors, warnings };
}

// ─── hooks & mcp ─────────────────────────────────────────────────────

async function loadPluginHooks(
  root: string,
  pluginId: string,
  vars: { root: string; data: string },
  pathSources: unknown[],
  errors: PluginError[],
): Promise<PluginHookEntry[]> {
  const out: PluginHookEntry[] = [];
  // Default hooks file is `hooks/hooks.json`; declared paths may add files.
  const files = [
    path.resolve(root, "hooks", "hooks.json"),
    ...pathSources.flatMap(asPathList).map((p) => path.resolve(root, p)),
  ];
  for (const file of [...new Set(files)]) {
    const check = await resolveInsidePlugin(root, file);
    if (!check.ok) {
      errors.push({ pluginId, scope: "hooks", message: `rejected hooks path ${file}: ${check.reason}` });
      continue;
    }
    let text: string;
    try {
      text = await fs.readFile(check.resolved, "utf-8");
    } catch {
      continue; // optional
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      errors.push({ pluginId, scope: "hooks", message: `invalid hooks.json: ${(error as Error).message}` });
      continue;
    }
    // Accept both `{ hooks: {...} }` and a bare `{ PreToolUse: [...] }`.
    const block = (json as Record<string, unknown>)?.hooks ?? json;
    if (!block || typeof block !== "object") continue;
    for (const [event, groups] of Object.entries(block as Record<string, unknown>)) {
      if (!isHookEvent(event) || !Array.isArray(groups)) continue;
      for (const group of groups) {
        const parsed = normalizeHookGroup(event, group, vars);
        if (parsed) out.push({ ...parsed, pluginId, pluginRoot: root });
      }
    }
  }
  return out;
}

function normalizeHookGroup(
  event: HookEvent,
  raw: unknown,
  vars: { root: string; data: string },
): { event: HookEvent; matcher?: string; hooks: HookCommand[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const matcher = typeof obj.matcher === "string" && obj.matcher ? obj.matcher : undefined;
  if (!Array.isArray(obj.hooks)) return null;
  const hooks: HookCommand[] = [];
  for (const h of obj.hooks) {
    if (!h || typeof h !== "object") continue;
    const entry = h as Record<string, unknown>;
    if ((entry.type ?? "command") !== "command") continue;
    if (typeof entry.command !== "string" || !entry.command) continue;
    const timeout = typeof entry.timeout === "number" && entry.timeout > 0 ? entry.timeout : 60;
    const shell = entry.shell === "sh" || entry.shell === "bash" || entry.shell === "powershell" || entry.shell === "pwsh"
      ? entry.shell
      : undefined;
    const command = substitutePluginVars(entry.command, vars);
    hooks.push({
      type: "command",
      command,
      timeout,
      ...(shell ? { shell } : {}),
      env: {
        EASY_AGENT_PLUGIN_ROOT: vars.root,
        EASY_AGENT_PLUGIN_DATA: vars.data,
      },
    });
  }
  if (hooks.length === 0) return null;
  return { event, hooks, ...(matcher ? { matcher } : {}) };
}

async function loadPluginMcp(
  root: string,
  pluginId: string,
  pluginName: string,
  vars: { root: string; data: string },
  pathSources: unknown[],
  errors: PluginError[],
): Promise<PluginMcpServer[]> {
  const out: PluginMcpServer[] = [];
  const files = [
    path.resolve(root, ".mcp.json"),
    ...pathSources.flatMap(asPathList).map((p) => path.resolve(root, p)),
  ];
  for (const file of [...new Set(files)]) {
    const check = await resolveInsidePlugin(root, file);
    if (!check.ok) {
      errors.push({ pluginId, scope: "mcp", message: `rejected mcp path ${file}: ${check.reason}` });
      continue;
    }
    let text: string;
    try {
      text = await fs.readFile(check.resolved, "utf-8");
    } catch {
      continue; // optional
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      errors.push({ pluginId, scope: "mcp", message: `invalid .mcp.json: ${(error as Error).message}` });
      continue;
    }
    const servers = (json as Record<string, unknown>)?.mcpServers;
    if (!servers || typeof servers !== "object") continue;
    for (const [name, rawConfig] of Object.entries(servers as Record<string, unknown>)) {
      const config = normalizeMcpServer(rawConfig, vars);
      if (!config) {
        errors.push({ pluginId, scope: "mcp", message: `skipped invalid MCP server "${name}"` });
        continue;
      }
      out.push({
        namespacedName: mcpServerNamespace(pluginName, name),
        config,
        pluginId,
        pluginRoot: root,
      });
    }
  }
  return out;
}

function normalizeMcpServer(
  raw: unknown,
  vars: { root: string; data: string },
): ScopedMcpServerConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const type = obj.type;
  const sub = (s: string) => substitutePluginVars(s, vars);
  const subRecord = (
    env: unknown,
    includePluginEnv = false,
  ): Record<string, string> | undefined => {
    const out: Record<string, string> = includePluginEnv
      ? {
          EASY_AGENT_PLUGIN_ROOT: vars.root,
          EASY_AGENT_PLUGIN_DATA: vars.data,
        }
      : {};
    if (env && typeof env === "object") {
      for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = sub(v);
      }
    }
    return out;
  };

  if (type === "http" || type === "sse") {
    if (typeof obj.url !== "string" || !obj.url) return null;
    const headers = subRecord(obj.headers);
    return { type, url: sub(obj.url), scope: "project", ...(headers ? { headers } : {}) } as ScopedMcpServerConfig;
  }
  // stdio (default)
  if (typeof obj.command !== "string" || !obj.command) return null;
  const args = Array.isArray(obj.args)
    ? obj.args.filter((a): a is string => typeof a === "string").map(sub)
    : [];
  const env = subRecord(obj.env, true);
  return {
    type: "stdio",
    command: sub(obj.command),
    args,
    scope: "project",
    ...(env ? { env } : {}),
  } as ScopedMcpServerConfig;
}

// ─── main entry ──────────────────────────────────────────────────────

export async function loadPlugin(opts: LoadPluginOptions): Promise<LoadedPlugin> {
  const errors: PluginError[] = [];
  const warnings: string[] = [];

  const manifestResult = await readManifest(opts);
  errors.push(...manifestResult.errors);
  warnings.push(...manifestResult.warnings);

  const name = manifestResult.name;
  const manifest = manifestResult.manifest ?? ({ name } as PluginManifest);
  const dataDir = getPluginDataDir(opts.pluginId);
  const vars = { root: opts.root, data: dataDir };
  const version =
    (typeof manifest.version === "string" && manifest.version) || "unknown";

  // A hard manifest failure in strict mode → return the shell with errors,
  // no components (nothing trustworthy to load).
  const manifestFatal = opts.strict && manifestResult.manifest === null;

  const emptyPlugin: LoadedPlugin = {
    pluginId: opts.pluginId,
    name,
    version,
    root: opts.root,
    dataDir,
    manifest,
    skills: [],
    agents: [],
    commands: [],
    outputStyles: [],
    hooks: [],
    mcpServers: [],
    lspServers: [],
    hasExecutableComponents: false,
    errors,
    warnings,
  };
  if (manifestFatal) return emptyPlugin;

  // ── Skills ──
  for (const dir of await validatedDirs(opts.root, componentDirs(opts.root, "skills", manifest.skills, opts.overlay?.skills), opts.pluginId, "skills", errors)) {
    const { skills, warnings: w } = await loadSkillsFromDir(dir, "plugin");
    warnings.push(...w);
    for (const s of skills) {
      emptyPlugin.skills.push({
        ...s,
        name: applyNamespace(name, s.name),
        body: substitutePluginVars(s.body, vars),
        frontmatter: {
          ...s.frontmatter,
          allowedTools: s.frontmatter.allowedTools.map((tool) =>
            substitutePluginVars(tool, vars),
          ),
        },
        source: "plugin",
        pluginId: opts.pluginId,
        pluginRoot: opts.root,
      });
    }
  }

  // ── Agents ──
  for (const dir of await validatedDirs(opts.root, componentDirs(opts.root, "agents", manifest.agents, opts.overlay?.agents), opts.pluginId, "agents", errors)) {
    const { agents, warnings: w } = await loadAgentsFromDir(dir, "plugin");
    warnings.push(...w);
    for (const a of agents) {
      const originalPrompt = a.getSystemPrompt;
      emptyPlugin.agents.push({
        ...a,
        agentType: applyNamespace(name, a.agentType),
        ...(a.tools
          ? { tools: a.tools.map((tool) => substitutePluginVars(tool, vars)) }
          : {}),
        ...(a.disallowedTools
          ? {
              disallowedTools: a.disallowedTools.map((tool) =>
                substitutePluginVars(tool, vars),
              ),
            }
          : {}),
        getSystemPrompt: () => substitutePluginVars(originalPrompt(), vars),
        source: "plugin",
        pluginId: opts.pluginId,
        pluginRoot: opts.root,
      });
    }
  }

  // ── Commands ──
  for (const dir of await validatedDirs(opts.root, componentDirs(opts.root, "commands", manifest.commands, opts.overlay?.commands), opts.pluginId, "commands", errors)) {
    const { commands, warnings: w } = await loadCommandsFromDir(dir, "plugin");
    warnings.push(...w);
    for (const c of commands) {
      emptyPlugin.commands.push({
        ...c,
        name: applyNamespace(name, c.name),
        body: substitutePluginVars(c.body, vars),
        allowedTools: c.allowedTools.map((tool) => substitutePluginVars(tool, vars)),
        source: "plugin",
        pluginId: opts.pluginId,
        pluginRoot: opts.root,
      });
    }
  }

  // ── Output styles ──
  for (const dir of await validatedDirs(opts.root, componentDirs(opts.root, "output-styles", manifest.outputStyles, opts.overlay?.outputStyles), opts.pluginId, "outputStyles", errors)) {
    const { styles, warnings: w } = await loadOutputStylesFromDir(dir, "plugin");
    warnings.push(...w);
    for (const st of styles) {
      emptyPlugin.outputStyles.push({
        ...st,
        name: applyNamespace(name, st.name),
        prompt: substitutePluginVars(st.prompt, vars),
        source: "plugin",
        pluginId: opts.pluginId,
        pluginRoot: opts.root,
      });
    }
  }

  // ── Hooks & MCP (executable — gated by trust at apply time) ──
  emptyPlugin.hooks = await loadPluginHooks(opts.root, opts.pluginId, vars, [manifest.hooks, opts.overlay?.hooks], errors);
  emptyPlugin.mcpServers = await loadPluginMcp(opts.root, opts.pluginId, name, vars, [manifest.mcpServers, opts.overlay?.mcpServers], errors);
  const lspMaps: unknown[] = [];
  if (manifest.lspServers && typeof manifest.lspServers === "object" && !Array.isArray(manifest.lspServers)) lspMaps.push(manifest.lspServers);
  const lspFiles = [path.join(opts.root, ".lsp.json"), ...[manifest.lspServers, opts.overlay?.lspServers].flatMap(asPathList).map((file) => path.resolve(opts.root, file))];
  for (const file of new Set(lspFiles)) {
    const check = await resolveInsidePlugin(opts.root, file);
    if (!check.ok) { errors.push({ pluginId: opts.pluginId, scope: "manifest", message: "Rejected LSP configuration path outside plugin" }); continue; }
    try {
      const json = JSON.parse(await fs.readFile(check.resolved, "utf8"));
      lspMaps.push(json.lspServers ?? json);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push({ pluginId: opts.pluginId, scope: "manifest", message: "Invalid LSP configuration file" });
    }
  }
  const lspByName = new Map<string, import("../services/lsp/runtime.js").LspRegistration>();
  for (const map of lspMaps) {
    const parsed = LspServersSchema.safeParse(map);
    if (!parsed.success) { errors.push({ pluginId: opts.pluginId, scope: "manifest", message: `Invalid lspServers: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}; expected stdio command, args and extensionToLanguage` }); continue; }
    for (const [serverName, config] of Object.entries(parsed.data)) {
      const sub = (value: string) => substitutePluginVars(value, vars);
      const name = `plugin:${emptyPlugin.name}:${serverName}`;
      lspByName.set(name, { name, cwd: opts.root, config: { ...config, command: sub(config.command), args: config.args.map(sub),
        env: { ...Object.fromEntries(Object.entries(config.env ?? {}).map(([key, value]) => [key, sub(value)])), EASY_AGENT_PLUGIN_ROOT: opts.root, EASY_AGENT_PLUGIN_DATA: dataDir } } });
    }
  }
  emptyPlugin.lspServers = [...lspByName.values()];
  emptyPlugin.hasExecutableComponents =
    emptyPlugin.hooks.length > 0 || emptyPlugin.mcpServers.length > 0 || emptyPlugin.lspServers.length > 0;

  // ── Within-plugin public-name conflict (plan §35.3): a skill and a command
  //    resolving to the same `/name` is ambiguous → validation error. ──
  const skillNames = new Set(emptyPlugin.skills.map((s) => s.name));
  for (const c of emptyPlugin.commands) {
    if (skillNames.has(c.name)) {
      errors.push({
        pluginId: opts.pluginId,
        scope: "commands",
        message: `name conflict: "${c.name}" is both a skill and a command in this plugin`,
      });
    }
  }

  return emptyPlugin;
}
