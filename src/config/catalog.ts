import { SettingsSchema } from "./schema.js";
import { loadSettingSources, isTrustedScopeForSensitiveKeys } from "./sources.js";
import { isProjectTrusted } from "./globalState.js";
import { redactSettingValue } from "./redaction.js";
import { loadFeatureSettings } from "./features.js";

/** Metadata supplements (rather than duplicates) the executable schema. */
export const SETTING_RELOAD: Record<string, string> = {
  toolSearch: "next request",
  toolSearchAutoThreshold: "next request",
  modelRoles: "next request",
  hooks: "next event",
  disableAllHooks: "next event",
  models: "next request",
  model: "next session",
  defaultModel: "next session",
  alwaysThinkingEnabled: "next request",
  effortLevel: "next request",
  language: "next turn",
  maxTurns: "next turn",
  checkpointingEnabled: "next session",
  respectGitignore: "next request",
  allow: "config command",
  deny: "config command",
  ask: "config command",
  mode: "config command",
  autoMode: "config command",
  outputStyle: "output-style command or restart",
  enabledPlugins: "plugin reload",
  mcpServers: "MCP reconnect",
  sandbox: "next shell execution",
};
/** Built-in values for settings no source sets. */
export const SETTING_DEFAULTS: Record<string, unknown> = {
  toolSearch: "on",
  toolSearchAutoThreshold: 10,
  modelRoles: {},
  mode: "default",
  autoMode: false,
  allow: [],
  deny: [],
  ask: [],
  additionalDirectories: [],
  disableAllHooks: false,
  checkpointingEnabled: true,
  respectGitignore: true,
  syntaxHighlightingDisabled: false,
  prefersReducedMotion: false,
  enableAllProjectMcpServers: false,
  enabledPlugins: {},
};

/**
 * Who a setting or environment variable belongs to:
 * - `environment`: facts about the machine, the project, or the terminal UI
 *   (provider endpoints and credentials, trust, sandbox, retention, display).
 * - `resource`: what is installed and approved (MCP servers, hooks, plugins,
 *   rule files).
 * - `agent`: how the agent is composed and behaves (model, tools, prompt,
 *   permissions, compaction, feature switches).
 */
export type ConfigCategory = "environment" | "resource" | "agent";

/**
 * Settings layers a key is read from:
 * - `trusted`: user, flag, and policy always; project and local only in a trusted workspace.
 * - `any`: every layer, also in an untrusted workspace. Only keys that can
 *   only remove capabilities use this.
 * - `user`: user, flag, and policy; project and local values are ignored.
 * - `user-file`: the user settings file only; every other layer is ignored with a warning.
 */
export type SettingScope = "trusted" | "any" | "user" | "user-file";

export interface SettingCatalogEntry {
  category: ConfigCategory;
  /** Changes what the agent may execute, read, write, or reach, or which credentials it uses. */
  security: boolean;
  scope: SettingScope;
  /** Exceptions to `scope` for part of the value. */
  scopeNote?: string;
  summary: string;
}

/** Every top-level settings key this build applies. Keys outside this table are reported as unsupported. */
export const SETTING_CATALOG: Record<string, SettingCatalogEntry> = {
  model: { category: "agent", security: false, scope: "trusted", summary: "Main model or model profile." },
  models: {
    category: "environment",
    security: true,
    scope: "trusted",
    summary: "Model profiles: protocol, model, endpoint, credentials, headers.",
  },
  defaultModel: {
    category: "agent",
    security: false,
    scope: "trusted",
    summary: "Profile or model used when nothing else selects one.",
  },
  modelRoles: {
    category: "agent",
    security: false,
    scope: "trusted",
    summary: "Models for the background, think, and longContext roles.",
  },
  toolSearch: {
    category: "agent",
    security: false,
    scope: "trusted",
    summary: "Defer tool schemas: off, auto, or on.",
  },
  toolSearchAutoThreshold: {
    category: "agent",
    security: false,
    scope: "trusted",
    summary: "Context-window percentage at which auto ToolSearch defers schemas.",
  },
  mode: {
    category: "agent",
    security: true,
    scope: "user",
    summary: "Permission mode at startup: default, plan, or auto.",
  },
  autoMode: { category: "agent", security: true, scope: "user", summary: 'Same as `mode: "auto"` when true.' },
  allow: { category: "agent", security: true, scope: "trusted", summary: "Permission rules that skip confirmation." },
  deny: { category: "agent", security: true, scope: "any", summary: "Permission rules that reject a call." },
  ask: {
    category: "agent",
    security: true,
    scope: "trusted",
    summary: "Accepted and listed by /config; permission checks do not apply these rules.",
  },
  additionalDirectories: {
    category: "environment",
    security: true,
    scope: "trusted",
    summary: "Extra directories the file tools may access.",
  },
  env: {
    category: "environment",
    security: true,
    scope: "trusted",
    scopeNote: "Project and local values cannot replace a credential-shaped variable the parent process already set.",
    summary: "Environment variables applied to the process and to commands it starts.",
  },
  hooks: { category: "resource", security: true, scope: "trusted", summary: "Shell commands run on lifecycle events." },
  mcpServers: { category: "resource", security: true, scope: "trusted", summary: "MCP server definitions." },
  statusLine: {
    category: "environment",
    security: true,
    scope: "trusted",
    summary: "Command whose output the terminal UI shows as its status line.",
  },
  outputStyle: { category: "agent", security: false, scope: "trusted", summary: "Active output style." },
  language: { category: "agent", security: false, scope: "trusted", summary: "Language the agent replies in." },
  apiKeyHelper: {
    category: "environment",
    security: true,
    scope: "trusted",
    summary: "Command that prints an API token when none is set.",
  },
  cleanupPeriodDays: {
    category: "environment",
    security: false,
    scope: "trusted",
    summary: "Days to keep session transcripts; 0 stops writing them.",
  },
  maxTurns: {
    category: "agent",
    security: false,
    scope: "trusted",
    summary: "Tool-turn limit for one request of the main session.",
  },
  disableAllHooks: {
    category: "resource",
    security: true,
    scope: "any",
    summary: "Turns off hooks and the status line command when any layer sets it.",
  },
  checkpointingEnabled: {
    category: "agent",
    security: false,
    scope: "trusted",
    summary: "File checkpoints before Write, Edit, and MultiEdit.",
  },
  alwaysThinkingEnabled: {
    category: "agent",
    security: false,
    scope: "trusted",
    summary: "Extended thinking on by default when unset or true.",
  },
  effortLevel: {
    category: "agent",
    security: false,
    scope: "trusted",
    summary: "Default reasoning effort: low, medium, high, or max.",
  },
  respectGitignore: {
    category: "agent",
    security: false,
    scope: "trusted",
    summary: "Glob and Grep skip files ignored by git.",
  },
  syntaxHighlightingDisabled: {
    category: "environment",
    security: false,
    scope: "trusted",
    summary: "Terminal UI renders code without highlighting.",
  },
  prefersReducedMotion: {
    category: "environment",
    security: false,
    scope: "trusted",
    summary: "Terminal UI turns off animations.",
  },
  claudeMdExcludes: {
    category: "resource",
    security: false,
    scope: "any",
    summary: "Globs of AGENTS.md and AGENT.md files not to load.",
  },
  enableAllProjectMcpServers: {
    category: "resource",
    security: true,
    scope: "trusted",
    summary: "Approve every server in the project .mcp.json.",
  },
  enabledMcpjsonServers: {
    category: "resource",
    security: true,
    scope: "trusted",
    summary: "Approved servers from the project .mcp.json.",
  },
  disabledMcpjsonServers: {
    category: "resource",
    security: true,
    scope: "any",
    summary: "Rejected servers from the project .mcp.json.",
  },
  enabledPlugins: {
    category: "resource",
    security: true,
    scope: "trusted",
    summary: "Plugins turned on or off in this layer.",
  },
  sandbox: {
    category: "environment",
    security: true,
    scope: "trusted",
    summary: "Shell sandbox: filesystem and network limits.",
  },
  harnesses: {
    category: "agent",
    security: true,
    scope: "user-file",
    summary: "User-defined Agents: name to Harness spec, selected with --harness.",
  },
};

/**
 * When a read takes effect:
 * - `use`: read every time the code path runs.
 * - `runtime`: resolved into the Agent's settings when the runtime starts;
 *   code without a runtime reads it at each use.
 *
 * `env` settings and the workspace `.env` are written into the process
 * environment when the workspace starts, so their values change only on restart.
 */
export type EnvironmentReadTiming = "use" | "runtime";

export interface EnvironmentVariableEntry {
  name: string;
  /** Older names read when `name` is unset. */
  aliases?: string[];
  /** `system` marks variables set by the operating system or shell rather than for Easy Agent. */
  category: ConfigCategory | "system";
  security: boolean;
  readAt: EnvironmentReadTiming;
  /** Settings key or CLI flag that covers the same behavior. */
  replacement?: string;
  /** Behavior when the variable is unset. */
  default?: string;
  summary: string;
}

/** Every environment variable Easy Agent reads by name. */
export const ENVIRONMENT_VARIABLES: readonly EnvironmentVariableEntry[] = [
  {
    name: "ANTHROPIC_AUTH_TOKEN",
    category: "environment",
    security: true,
    readAt: "use",
    summary: "API token for Anthropic-protocol requests; the shared default client keeps the value it started with.",
  },
  {
    name: "ANTHROPIC_API_KEY",
    category: "environment",
    security: true,
    readAt: "use",
    summary: "Counts as configured credentials in the credential check and /doctor.",
  },
  {
    name: "ANTHROPIC_BASE_URL",
    category: "environment",
    security: true,
    readAt: "use",
    default: "https://api.anthropic.com",
    summary: "Endpoint for Anthropic-protocol requests and server-side web search.",
  },
  {
    name: "ANTHROPIC_MODEL",
    category: "agent",
    security: false,
    readAt: "runtime",
    replacement: "model",
    default: "claude-sonnet-4-20250514",
    summary: "Model used when no setting, flag, or Agent selects one.",
  },
  {
    name: "EASY_AGENT_AUTO_MODE_MODEL",
    category: "agent",
    security: false,
    readAt: "runtime",
    default: "the session's model",
    summary: "Model for the Auto Mode classifier.",
  },
  {
    name: "MAX_THINKING_TOKENS",
    category: "agent",
    security: false,
    readAt: "runtime",
    replacement: "alwaysThinkingEnabled",
    summary:
      "0 turns extended thinking off; N > 0 turns it on with a budget of N tokens; a value that is not a number is ignored.",
  },
  {
    name: "CLAUDE_CODE_DISABLE_THINKING",
    category: "agent",
    security: false,
    readAt: "runtime",
    summary: "Any value removes thinking from requests.",
  },
  {
    name: "CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING",
    category: "agent",
    security: false,
    readAt: "runtime",
    summary: "Any value sends a thinking budget instead of adaptive thinking.",
  },
  {
    name: "DISABLE_INTERLEAVED_THINKING",
    category: "agent",
    security: false,
    readAt: "runtime",
    summary: "Any value leaves out the interleaved-thinking beta header.",
  },
  {
    name: "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT",
    category: "agent",
    security: false,
    readAt: "runtime",
    summary: "Any value treats every model as supporting the effort parameter.",
  },
  {
    name: "EASY_AGENT_MAX_CONTEXT_TOKENS",
    aliases: ["CLAUDE_CODE_MAX_CONTEXT_TOKENS"],
    category: "agent",
    security: false,
    readAt: "runtime",
    default: "the model's context window (200000 when unknown)",
    summary: "Context window size used for warnings and auto-compaction.",
  },
  {
    name: "EASY_AGENT_MAX_RETRIES",
    aliases: ["CLAUDE_CODE_MAX_RETRIES"],
    category: "agent",
    security: false,
    readAt: "runtime",
    default: "10",
    summary: "Retries for a failed model request.",
  },
  {
    name: "EASY_AGENT_ENABLE_TOOL_SEARCH",
    aliases: ["ENABLE_TOOL_SEARCH"],
    category: "agent",
    security: false,
    readAt: "runtime",
    replacement: "toolSearch, toolSearchAutoThreshold, --tool-search",
    summary: "Deprecated ToolSearch switch: true, false, auto, or auto:N.",
  },
  {
    name: "EASY_AGENT_DISABLE_PROMPT_CACHING",
    category: "agent",
    security: false,
    readAt: "runtime",
    summary: "1, true, yes, or on removes prompt-cache markers and keys from requests.",
  },
  {
    name: "EASY_AGENT_DISABLE_EXPERIMENTAL_BETAS",
    aliases: ["CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"],
    category: "agent",
    security: false,
    readAt: "runtime",
    summary: "1, true, yes, or on leaves out experimental beta request fields.",
  },
  {
    name: "EASY_AGENT_SKILL_CHAR_BUDGET",
    category: "agent",
    security: false,
    readAt: "runtime",
    default: "8000",
    summary: "Character budget for the skill listing in the system prompt.",
  },
  {
    name: "EASY_AGENT_TEAMS",
    category: "agent",
    security: false,
    readAt: "runtime",
    replacement: "--agent-teams",
    summary: "1, true, yes, or on turns on Agent Teams.",
  },
  {
    name: "EASY_AGENT_DISABLE_CHECKPOINTING",
    category: "agent",
    security: false,
    readAt: "runtime",
    replacement: "checkpointingEnabled",
    summary: "1, true, yes, or on turns off file checkpoints.",
  },
  {
    name: "WEB_SEARCH_ADAPTER",
    category: "agent",
    security: false,
    readAt: "runtime",
    summary: "Forces the WebSearch backend: bing or api.",
  },
  {
    name: "EASY_AGENT_DISABLE_HOOKS",
    category: "resource",
    security: true,
    readAt: "use",
    replacement: "disableAllHooks",
    summary: "1, true, or yes turns off hooks.",
  },
  {
    name: "MCP_CONNECT_TIMEOUT",
    category: "resource",
    security: false,
    readAt: "use",
    default: "30000",
    summary: "MCP connection timeout in milliseconds.",
  },
  {
    name: "EASY_AGENT_POWERSHELL",
    category: "environment",
    security: true,
    readAt: "use",
    default: "powershell.exe",
    summary: "PowerShell executable for the PowerShell tool.",
  },
  {
    name: "EASY_AGENT_DEBUG",
    category: "environment",
    security: false,
    readAt: "use",
    summary: "Any value writes debug logs to stderr.",
  },
  {
    name: "EASY_AGENT_DEBUG_STREAM",
    category: "environment",
    security: false,
    readAt: "use",
    summary: "1 writes raw model stream events to a private log file.",
  },
  {
    name: "SHELL",
    category: "system",
    security: true,
    readAt: "use",
    summary: "Shell for Bash, the status line command, and apiKeyHelper.",
  },
  {
    name: "HOME",
    category: "system",
    security: false,
    readAt: "use",
    summary: "Shortens paths in the memory picker.",
  },
  {
    name: "VISUAL",
    aliases: ["EDITOR"],
    category: "system",
    security: false,
    readAt: "use",
    summary: "Editor opened from the terminal UI.",
  },
  {
    name: "PROGRAMDATA",
    category: "system",
    security: false,
    readAt: "use",
    default: "C:\\ProgramData",
    summary: "Location of the managed settings file on Windows.",
  },
];

export async function describeConfiguration(cwd: string): Promise<string[]> {
  const all = await loadSettingSources(cwd);
  const trusted = await isProjectTrusted(cwd);
  const lines = ["Configuration (effective values + source; reload policy)"];
  const keys = new Set([...Object.keys(SettingsSchema.shape), "sandbox"]);
  for (const key of keys) {
    if (["toolSearch", "toolSearchAutoThreshold", "modelRoles"].includes(key)) continue;
    const eligible = all.filter(
      (source) =>
        source.raw?.[key] !== undefined &&
        (isTrustedScopeForSensitiveKeys(source.source) || (trusted && !["mode", "autoMode"].includes(key))),
    );
    let value: unknown = SETTING_DEFAULTS[key];
    let from = "default";
    for (const source of eligible) {
      value = source.raw![key];
      from = source.source;
    }
    if (
      [
        "allow",
        "deny",
        "ask",
        "additionalDirectories",
        "claudeMdExcludes",
        "enabledMcpjsonServers",
        "disabledMcpjsonServers",
      ].includes(key) &&
      eligible.length
    ) {
      value = [...new Set(eligible.flatMap((source) => source.raw![key] as string[]))];
      from = `merged(${eligible.map((source) => source.source).join("+")})`;
    }
    if (["env", "enabledPlugins", "mcpServers"].includes(key) && eligible.length) {
      value = Object.assign({}, ...eligible.map((source) => source.raw![key]));
      from = `merged(${eligible.map((source) => source.source).join("+")})`;
    }
    if (key === "models") {
      const { loadProfiles } = await import("../services/api/providers/profile.js");
      const profiles = await loadProfiles(cwd);
      value = profiles.profiles;
      from = JSON.stringify(profiles.provenance);
    }
    if (key === "disableAllHooks") {
      const disabling = all.filter((source) => source.raw?.disableAllHooks === true);
      value = disabling.length > 0;
      from = disabling.length ? disabling.map((source) => source.source).join("+") : from;
    }
    if (value !== undefined)
      lines.push(
        `  ${key} = ${JSON.stringify(redactSettingValue(key, value))} [${from}; ${SETTING_RELOAD[key] ?? "restart"}]`,
      );
  }
  const features = await loadFeatureSettings(cwd);
  lines.push(
    `  toolSearch = ${features.toolSearch} [${features.sources.toolSearch}; next request]`,
    `  toolSearchAutoThreshold = ${features.toolSearchAutoThreshold} [${features.sources.toolSearchAutoThreshold}; next request]`,
  );
  for (const [role, model] of Object.entries(features.modelRoles))
    lines.push(
      `  modelRoles.${role} = ${JSON.stringify(model)} [${features.sources[`modelRoles.${role}`]}; next invocation/request]`,
    );
  for (const warning of features.warnings) lines.push(`  Warning: ${warning}`);
  return lines;
}
