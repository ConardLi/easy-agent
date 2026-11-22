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
  reasoning: "next request",
  agentMdExcludes: "next turn",
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
  reasoning: { mode: "auto" },
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
 * - `local-file`: the local settings file of a trusted workspace only; every
 *   other layer, and the local file of an untrusted workspace, is ignored with a warning.
 */
export type SettingScope = "trusted" | "any" | "user" | "user-file" | "local-file";

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
  model: { category: "agent", security: false, scope: "trusted", summary: "Main model profile ID." },
  models: {
    category: "environment",
    security: true,
    scope: "trusted",
    summary: "Model profiles: protocol, model, endpoint, credentials, headers.",
  },
  reasoning: {
    category: "agent",
    security: false,
    scope: "trusted",
    summary: "Reasoning intent: mode (auto/on/off), budgetTokens, and effort.",
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
  agentMdExcludes: {
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
  harness: {
    category: "agent",
    security: true,
    scope: "local-file",
    summary: "The Agent this workspace uses when none is selected: a name from harnesses.",
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
  type: "string" | "boolean" | "integer" | "enum" | "API Key" | "URL";
  owner: string;
  priority: string;
}

const environmentEntry = (
  name: string,
  type: EnvironmentVariableEntry["type"],
  category: EnvironmentVariableEntry["category"],
  owner: string,
  summary: string,
  defaultValue = "unset",
  security = false,
): EnvironmentVariableEntry => ({
  name,
  type,
  category,
  owner,
  summary,
  default: defaultValue,
  security,
  readAt: category === "system" ? "use" : "runtime",
  priority:
    category === "system"
      ? "operating system"
      : name === "EASY_AGENT_DISABLE_HOOKS"
        ? "restrictive union with disableAllHooks"
        : "user → Harness → project → local → environment → CLI/SDK/session → policy",
});

/** Canonical product variables only. Removed names are diagnosed by config/retired. */
export const ENVIRONMENT_VARIABLES: readonly EnvironmentVariableEntry[] = [
  environmentEntry(
    "EASY_AGENT_PROFILE",
    "string",
    "agent",
    "model.main",
    "Select a saved profile ID; shortcut target variables cannot accompany it.",
  ),
  environmentEntry(
    "EASY_AGENT_PROTOCOL",
    "enum",
    "environment",
    "models.protocol",
    "Temporary connection: anthropic, openai-chat, openai-responses, or gemini.",
  ),
  environmentEntry(
    "EASY_AGENT_MODEL",
    "string",
    "environment",
    "models.model",
    "Upstream model name for the temporary connection; requires an explicit protocol.",
  ),
  environmentEntry(
    "EASY_AGENT_BASE_URL",
    "URL",
    "environment",
    "models.baseURL",
    "Service URL for the temporary connection.",
    "official URL of the selected protocol",
    true,
  ),
  environmentEntry(
    "EASY_AGENT_API_KEY",
    "API Key",
    "environment",
    "models.apiKey",
    "Single credential for the temporary connection or an explicit profile reference.",
    "unset",
    true,
  ),
  environmentEntry(
    "EASY_AGENT_AUTO_MODE_MODEL",
    "string",
    "agent",
    "model.roles.classifier",
    "Profile ID for the Auto Mode classifier.",
    "main profile",
  ),
  environmentEntry(
    "EASY_AGENT_REASONING",
    "enum",
    "agent",
    "reasoning.mode",
    "Reasoning intent: auto, on, or off.",
    "auto",
  ),
  environmentEntry(
    "EASY_AGENT_REASONING_BUDGET_TOKENS",
    "integer",
    "agent",
    "reasoning.budgetTokens",
    "Positive reasoning budget, within output and context limits.",
  ),
  environmentEntry(
    "EASY_AGENT_MAX_CONTEXT_TOKENS",
    "integer",
    "agent",
    "compaction.contextWindow",
    "Positive context window used by token budgeting.",
    "model metadata; unknown: 32000 (estimate)",
  ),
  environmentEntry(
    "EASY_AGENT_MAX_RETRIES",
    "integer",
    "agent",
    "features.maxRetries",
    "Non-negative retry count; 0 disables retries.",
    "10",
  ),
  environmentEntry(
    "EASY_AGENT_DISABLE_PROMPT_CACHING",
    "boolean",
    "agent",
    "features.promptCaching",
    "Disable protocol-supported prompt caching.",
    "false",
  ),
  environmentEntry(
    "EASY_AGENT_DISABLE_EXPERIMENTAL_BETAS",
    "boolean",
    "agent",
    "features.experimentalBetas",
    "Disable protocol experimental fields.",
    "false",
  ),
  environmentEntry(
    "EASY_AGENT_SKILL_CHAR_BUDGET",
    "integer",
    "agent",
    "skills.listingBudgetChars",
    "Positive character budget for the skill listing.",
    "8000",
  ),
  environmentEntry("EASY_AGENT_TEAMS", "boolean", "agent", "features.agentTeams", "Enable Agent Teams.", "false"),
  environmentEntry(
    "EASY_AGENT_DISABLE_CHECKPOINTING",
    "boolean",
    "agent",
    "session.checkpoints",
    "Disable file checkpoints.",
    "false",
  ),
  environmentEntry(
    "EASY_AGENT_WEB_SEARCH_BACKEND",
    "enum",
    "agent",
    "tools.webSearchBackend",
    "WebSearch backend: bing or api.",
    "selected connection capabilities",
  ),
  environmentEntry(
    "EASY_AGENT_DISABLE_HOOKS",
    "boolean",
    "resource",
    "disableAllHooks",
    "Disable hooks; false cannot undo another disabling source.",
    "false",
    true,
  ),
  environmentEntry(
    "EASY_AGENT_MCP_CONNECT_TIMEOUT_MS",
    "integer",
    "resource",
    "MCP",
    "Positive connection timeout in milliseconds.",
    "30000",
  ),
  environmentEntry(
    "EASY_AGENT_POWERSHELL",
    "string",
    "environment",
    "PowerShell",
    "Trusted PowerShell executable.",
    "powershell.exe",
    true,
  ),
  environmentEntry(
    "EASY_AGENT_DEBUG",
    "boolean",
    "environment",
    "logging",
    "Enable debug logs with credential redaction.",
    "false",
  ),
  environmentEntry(
    "EASY_AGENT_DEBUG_STREAM",
    "boolean",
    "environment",
    "logging",
    "Write model stream diagnostics to a private log.",
    "false",
  ),
  environmentEntry(
    "SHELL",
    "string",
    "system",
    "shell",
    "Shell for Bash, status line commands, and profile credential helpers.",
    "platform shell",
    true,
  ),
  environmentEntry("HOME", "string", "system", "paths", "User home directory."),
  {
    ...environmentEntry("VISUAL", "string", "system", "editor", "Editor opened from the terminal UI."),
    aliases: ["EDITOR"],
  },
  environmentEntry(
    "PROGRAMDATA",
    "string",
    "system",
    "policy",
    "Managed settings location on Windows.",
    "C:\\ProgramData",
  ),
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
        "agentMdExcludes",
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
