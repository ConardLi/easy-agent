/**
 * Every setting a Harness spec can carry, and where its value comes from today.
 *
 * Each key names its spec path, its built-in default, the top-level settings
 * key and environment variable that already control it, and whether this
 * build applies it. The built-in `default` harness is these defaults plus the
 * current settings and environment, so it reproduces today's behavior.
 *
 * `applied: false` marks keys that a spec may already carry but that no code
 * reads yet; the resolver reports them when a spec sets one.
 *
 * This module must not import a module that reads the active harness: the
 * import cycle would evaluate the key table before that module's defaults
 * exist. Defaults of such modules are declared here and re-exported there.
 */

import type { SettingScope } from "../config/catalog.js";
import type { HarnessComponent } from "./spec.js";

/** Retries for a failed model request when nothing sets `features.maxRetries`. */
export const DEFAULT_MAX_RETRIES = 10;
/** Model when no setting, flag, Agent, or ANTHROPIC_MODEL selects one. */
export const FALLBACK_MODEL = "claude-sonnet-4-20250514";
/** Characters for the skill listing when nothing sets `skills.listingBudgetChars`. */
export const DEFAULT_BUDGET_CHARS = 8000;

export type HarnessLayerSource =
  | "built-in"
  | "user"
  | "harness"
  | "project"
  | "local"
  | "environment"
  | "flag"
  | "policy";

export interface HarnessSettingsInput {
  /** Top-level settings key (dotted for a field of an object setting). */
  key: string;
  /** The value in one settings layer, or undefined when that layer does not set it. */
  read: (raw: Record<string, unknown>) => unknown;
  scope: Exclude<SettingScope, "user-file">;
}

export type HarnessEnvRead =
  | { value: unknown; name: string }
  | { invalid: string; name: string; raw: string }
  | undefined;

export interface HarnessEnvInput {
  names: readonly string[];
  read: (env: NodeJS.ProcessEnv) => HarnessEnvRead;
  /**
   * - `default`: stands in for the built-in default; any settings layer wins over it.
   * - `override`: above user, project, and local settings, below flags and policy.
   * - `top`: above every settings layer, policy included.
   */
  position: "default" | "override" | "top";
}

export interface HarnessKey {
  path: string;
  component: HarnessComponent;
  summary: string;
  defaultValue?: unknown;
  /** `union` concatenates every accepted layer (rule lists); `replace` keeps the last one. */
  merge: "replace" | "union";
  settings?: HarnessSettingsInput;
  /** Read only when no layer and no spec sets the main value, as `defaultModel` after `model`. */
  fallbackSettings?: HarnessSettingsInput;
  env?: HarnessEnvInput;
  /** Set by `--agent-teams` on the command line. */
  argvAgentTeams?: boolean;
  applied: boolean;
}

// ─── Settings readers (same acceptance rules as the current loaders) ───

const trimmedString =
  (key: string) =>
  (raw: Record<string, unknown>): string | undefined => {
    const value = raw[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };

const boolean =
  (key: string) =>
  (raw: Record<string, unknown>): boolean | undefined => {
    const value = raw[key];
    return typeof value === "boolean" ? value : undefined;
  };

const ruleList =
  (key: string) =>
  (raw: Record<string, unknown>): string[] | undefined => {
    const value = raw[key];
    if (!Array.isArray(value)) return undefined;
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  };

const modelRole =
  (role: string) =>
  (raw: Record<string, unknown>): unknown => {
    const roles = raw.modelRoles;
    return roles && typeof roles === "object" ? (roles as Record<string, unknown>)[role] : undefined;
  };

function permissionMode(raw: Record<string, unknown>): string | undefined {
  const mode = raw.mode;
  if (mode === "default" || mode === "plan" || mode === "auto") return mode;
  return raw.autoMode === true ? "auto" : undefined;
}

function positiveInteger(raw: Record<string, unknown>, key: string): number | undefined {
  const value = raw[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

// ─── Environment readers ───────────────────────────────────────────────

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const isTruthy = (value: string | undefined) => Boolean(value) && TRUTHY.has(value!.trim().toLowerCase());

/** Set to any non-empty value. */
const present = (value: string | undefined) => Boolean(value);

function positiveIntegerFrom(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return !Number.isNaN(parsed) && parsed > 0 ? parsed : undefined;
}

/** The deprecated `EASY_AGENT_ENABLE_TOOL_SEARCH` spellings: on/off words, `auto`, and `auto:N`. */
export function parseLegacyToolSearch(
  value: string,
): { toolSearch: "off" | "auto" | "on"; toolSearchAutoThreshold: number } | null {
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return { toolSearch: "on", toolSearchAutoThreshold: 10 };
  if (["false", "0", "no", "off"].includes(normalized)) return { toolSearch: "off", toolSearchAutoThreshold: 10 };
  if (normalized === "auto") return { toolSearch: "auto", toolSearchAutoThreshold: 10 };
  if (normalized.startsWith("auto:")) {
    const n = Number.parseInt(normalized.slice(5), 10);
    const threshold = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 10;
    return {
      toolSearch: threshold === 0 ? "on" : threshold === 100 ? "off" : "auto",
      toolSearchAutoThreshold: threshold,
    };
  }
  return null;
}

function legacyToolSearch(env: NodeJS.ProcessEnv): { raw: string; name: string } | undefined {
  if (env.EASY_AGENT_ENABLE_TOOL_SEARCH !== undefined) {
    return { raw: env.EASY_AGENT_ENABLE_TOOL_SEARCH, name: "EASY_AGENT_ENABLE_TOOL_SEARCH" };
  }
  if (env.ENABLE_TOOL_SEARCH !== undefined) return { raw: env.ENABLE_TOOL_SEARCH, name: "ENABLE_TOOL_SEARCH" };
  return undefined;
}

const legacyToolSearchField =
  (field: "toolSearch" | "toolSearchAutoThreshold") =>
  (env: NodeJS.ProcessEnv): HarnessEnvRead => {
    const legacy = legacyToolSearch(env);
    if (!legacy) return undefined;
    const parsed = parseLegacyToolSearch(legacy.raw);
    return parsed
      ? { value: parsed[field], name: legacy.name }
      : { invalid: "expected on, off, auto or auto:N", name: legacy.name, raw: legacy.raw };
  };

// ─── Keys ──────────────────────────────────────────────────────────────

const specOnly = (path: string, component: HarnessComponent, summary: string, defaultValue?: unknown): HarnessKey => ({
  path,
  component,
  summary,
  ...(defaultValue === undefined ? {} : { defaultValue }),
  merge: "replace",
  applied: false,
});

const selection = (component: HarnessComponent, noun: string, applied = false): HarnessKey[] => [
  { ...specOnly(`${component}.include`, component, `Only these ${noun}.`), applied },
  { ...specOnly(`${component}.exclude`, component, `Leave out these ${noun}.`), applied },
];

export const HARNESS_KEYS: readonly HarnessKey[] = [
  {
    path: "model.main",
    component: "model",
    summary: "Main model or model profile.",
    defaultValue: FALLBACK_MODEL,
    merge: "replace",
    settings: { key: "model", read: trimmedString("model"), scope: "trusted" },
    fallbackSettings: { key: "defaultModel", read: trimmedString("defaultModel"), scope: "trusted" },
    env: {
      names: ["ANTHROPIC_MODEL"],
      read: (env) => (env.ANTHROPIC_MODEL ? { value: env.ANTHROPIC_MODEL, name: "ANTHROPIC_MODEL" } : undefined),
      position: "default",
    },
    applied: true,
  },
  ...(["background", "think", "longContext"] as const).map(
    (role): HarnessKey => ({
      path: `model.roles.${role}`,
      component: "model",
      summary: `Model for the ${role} role.`,
      merge: "replace",
      settings: { key: `modelRoles.${role}`, read: modelRole(role), scope: "trusted" },
      applied: true,
    }),
  ),
  {
    path: "model.roles.classifier",
    component: "model",
    summary: "Model for the Auto Mode classifier; unset uses the session's model.",
    merge: "replace",
    env: {
      names: ["EASY_AGENT_AUTO_MODE_MODEL"],
      read: (env) =>
        env.EASY_AGENT_AUTO_MODE_MODEL
          ? { value: env.EASY_AGENT_AUTO_MODE_MODEL, name: "EASY_AGENT_AUTO_MODE_MODEL" }
          : undefined,
      position: "override",
    },
    applied: true,
  },
  specOnly("model.roles.compaction", "model", "Model for compaction summaries."),
  specOnly("model.roles.webFetch", "model", "Model for WebFetch summaries."),

  ...selection("tools", "tools", true),
  {
    path: "tools.respectGitignore",
    component: "tools",
    summary: "Glob and Grep skip files ignored by git.",
    defaultValue: true,
    merge: "replace",
    settings: { key: "respectGitignore", read: boolean("respectGitignore"), scope: "trusted" },
    applied: true,
  },
  {
    path: "tools.webSearchBackend",
    component: "tools",
    summary: "WebSearch backend; unset picks one from the model endpoint.",
    merge: "replace",
    env: {
      names: ["WEB_SEARCH_ADAPTER"],
      read: (env) =>
        env.WEB_SEARCH_ADAPTER === "bing" || env.WEB_SEARCH_ADAPTER === "api"
          ? { value: env.WEB_SEARCH_ADAPTER, name: "WEB_SEARCH_ADAPTER" }
          : undefined,
      position: "override",
    },
    applied: true,
  },

  specOnly("prompt.identity", "prompt", "Identity section text."),
  {
    path: "prompt.language",
    component: "prompt",
    summary: "Language the agent replies in.",
    merge: "replace",
    settings: { key: "language", read: trimmedString("language"), scope: "trusted" },
    applied: true,
  },
  specOnly("prompt.sections", "prompt", "Dynamic sections turned off, replaced, or added."),

  specOnly("context.agentMd", "context", "Load AGENTS.md and AGENT.md files.", true),
  specOnly("context.memory", "context", "Load project memory.", true),
  specOnly("context.environment", "context", "Include the environment section.", true),
  specOnly("context.gitStatus", "context", "Include the git status snapshot.", true),
  specOnly("context.skills", "context", "Include the skill listing.", true),
  specOnly("context.agents", "context", "Include the sub-agent listing.", true),

  specOnly("compaction.auto", "compaction", "Compact automatically near the context limit.", true),
  specOnly("compaction.autoThreshold", "compaction", "Fraction of the effective window that starts auto-compaction."),
  specOnly("compaction.microcompact", "compaction", "Clear old tool results before compacting.", true),
  specOnly("compaction.keepRecentMessages", "compaction", "Recent messages kept when clearing tool results."),
  {
    path: "compaction.contextWindow",
    component: "compaction",
    summary: "Context window size; unset uses the model's.",
    merge: "replace",
    env: {
      names: ["EASY_AGENT_MAX_CONTEXT_TOKENS", "CLAUDE_CODE_MAX_CONTEXT_TOKENS"],
      read: (env) => {
        const name = env.EASY_AGENT_MAX_CONTEXT_TOKENS
          ? "EASY_AGENT_MAX_CONTEXT_TOKENS"
          : "CLAUDE_CODE_MAX_CONTEXT_TOKENS";
        const raw = env.EASY_AGENT_MAX_CONTEXT_TOKENS ?? env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
        if (!raw) return undefined;
        const value = positiveIntegerFrom(raw);
        return value === undefined ? { invalid: "expected a positive integer", name, raw } : { value, name };
      },
      position: "override",
    },
    applied: true,
  },

  {
    path: "permissions.mode",
    component: "permissions",
    summary: "Permission mode at startup.",
    defaultValue: "default",
    merge: "replace",
    settings: { key: "mode", read: permissionMode, scope: "user" },
    applied: true,
  },
  {
    path: "permissions.allow",
    component: "permissions",
    summary: "Rules that skip confirmation.",
    defaultValue: [],
    merge: "union",
    settings: { key: "allow", read: ruleList("allow"), scope: "trusted" },
    applied: true,
  },
  {
    path: "permissions.deny",
    component: "permissions",
    summary: "Rules that reject a call.",
    defaultValue: [],
    merge: "union",
    settings: { key: "deny", read: ruleList("deny"), scope: "any" },
    applied: true,
  },
  {
    path: "permissions.ask",
    component: "permissions",
    summary: "Rules that always ask.",
    defaultValue: [],
    merge: "union",
    settings: { key: "ask", read: ruleList("ask"), scope: "trusted" },
    applied: false,
  },

  specOnly("sandbox.enabled", "sandbox", "Run shell commands in the sandbox."),
  specOnly("hooks.enabled", "hooks", "Run command hooks.", true),

  ...selection("skills", "skills"),
  {
    path: "skills.listingBudgetChars",
    component: "skills",
    summary: "Characters for the skill listing.",
    defaultValue: DEFAULT_BUDGET_CHARS,
    merge: "replace",
    env: {
      names: ["EASY_AGENT_SKILL_CHAR_BUDGET"],
      read: (env) => {
        const value = positiveIntegerFrom(env.EASY_AGENT_SKILL_CHAR_BUDGET);
        return value === undefined ? undefined : { value, name: "EASY_AGENT_SKILL_CHAR_BUDGET" };
      },
      position: "override",
    },
    applied: true,
  },
  ...selection("agents", "sub-agents"),
  ...selection("commands", "commands"),
  {
    path: "outputStyle",
    component: "outputStyle",
    summary: "Active output style; unset is the default style.",
    merge: "replace",
    settings: { key: "outputStyle", read: trimmedString("outputStyle"), scope: "trusted" },
    applied: true,
  },
  ...selection("mcpServers", "MCP servers", true),
  ...selection("plugins", "plugins"),

  {
    path: "features.agentTeams",
    component: "features",
    summary: "Agent Teams tools.",
    defaultValue: false,
    merge: "replace",
    env: {
      names: ["EASY_AGENT_TEAMS"],
      read: (env) => (isTruthy(env.EASY_AGENT_TEAMS) ? { value: true, name: "EASY_AGENT_TEAMS" } : undefined),
      position: "override",
    },
    argvAgentTeams: true,
    applied: true,
  },
  {
    path: "features.toolSearch",
    component: "features",
    summary: "Defer tool schemas: off, auto, or on.",
    defaultValue: "on",
    merge: "replace",
    settings: { key: "toolSearch", read: (raw) => raw.toolSearch, scope: "trusted" },
    env: {
      names: ["EASY_AGENT_ENABLE_TOOL_SEARCH", "ENABLE_TOOL_SEARCH"],
      read: legacyToolSearchField("toolSearch"),
      position: "override",
    },
    applied: true,
  },
  {
    path: "features.toolSearchAutoThreshold",
    component: "features",
    summary: "Context-window percentage at which auto ToolSearch defers schemas.",
    defaultValue: 10,
    merge: "replace",
    settings: {
      key: "toolSearchAutoThreshold",
      read: (raw) => raw.toolSearchAutoThreshold,
      scope: "trusted",
    },
    env: {
      names: ["EASY_AGENT_ENABLE_TOOL_SEARCH", "ENABLE_TOOL_SEARCH"],
      read: legacyToolSearchField("toolSearchAutoThreshold"),
      position: "override",
    },
    applied: true,
  },
  {
    path: "features.thinking",
    component: "features",
    summary: "Extended thinking on by default.",
    defaultValue: true,
    merge: "replace",
    settings: { key: "alwaysThinkingEnabled", read: boolean("alwaysThinkingEnabled"), scope: "trusted" },
    env: {
      names: ["MAX_THINKING_TOKENS"],
      read: (env) => {
        const raw = env.MAX_THINKING_TOKENS;
        if (raw === undefined) return undefined;
        const parsed = Number.parseInt(raw, 10);
        return Number.isNaN(parsed)
          ? { invalid: "expected 0 or a token budget", name: "MAX_THINKING_TOKENS", raw }
          : { value: parsed > 0, name: "MAX_THINKING_TOKENS" };
      },
      position: "top",
    },
    applied: true,
  },
  {
    path: "features.thinkingBudget",
    component: "features",
    summary: "Fixed thinking budget in tokens; unset lets the model decide.",
    merge: "replace",
    env: {
      names: ["MAX_THINKING_TOKENS"],
      read: (env) => {
        const value = positiveIntegerFrom(env.MAX_THINKING_TOKENS);
        return value === undefined ? undefined : { value, name: "MAX_THINKING_TOKENS" };
      },
      position: "top",
    },
    applied: true,
  },
  {
    path: "features.thinkingInRequests",
    component: "features",
    summary: "Send thinking parameters to the model.",
    defaultValue: true,
    merge: "replace",
    env: {
      names: ["CLAUDE_CODE_DISABLE_THINKING"],
      read: (env) =>
        present(env.CLAUDE_CODE_DISABLE_THINKING) ? { value: false, name: "CLAUDE_CODE_DISABLE_THINKING" } : undefined,
      position: "top",
    },
    applied: true,
  },
  {
    path: "features.adaptiveThinking",
    component: "features",
    summary: "Use adaptive thinking where the model supports it.",
    defaultValue: true,
    merge: "replace",
    env: {
      names: ["CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING"],
      read: (env) =>
        present(env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING)
          ? { value: false, name: "CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING" }
          : undefined,
      position: "top",
    },
    applied: true,
  },
  {
    path: "features.interleavedThinking",
    component: "features",
    summary: "Send the interleaved-thinking beta header.",
    defaultValue: true,
    merge: "replace",
    env: {
      names: ["DISABLE_INTERLEAVED_THINKING"],
      read: (env) =>
        present(env.DISABLE_INTERLEAVED_THINKING) ? { value: false, name: "DISABLE_INTERLEAVED_THINKING" } : undefined,
      position: "top",
    },
    applied: true,
  },
  {
    path: "features.effort",
    component: "features",
    summary: "Default reasoning effort; unset lets the model decide.",
    merge: "replace",
    settings: {
      key: "effortLevel",
      read: (raw) =>
        raw.effortLevel === "low" ||
        raw.effortLevel === "medium" ||
        raw.effortLevel === "high" ||
        raw.effortLevel === "max"
          ? raw.effortLevel
          : undefined,
      scope: "trusted",
    },
    applied: true,
  },
  {
    path: "features.effortForAllModels",
    component: "features",
    summary: "Treat every model as supporting the effort parameter.",
    defaultValue: false,
    merge: "replace",
    env: {
      names: ["CLAUDE_CODE_ALWAYS_ENABLE_EFFORT"],
      read: (env) =>
        present(env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT)
          ? { value: true, name: "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT" }
          : undefined,
      position: "top",
    },
    applied: true,
  },
  {
    path: "features.promptCaching",
    component: "features",
    summary: "Prompt-cache markers and keys in requests.",
    defaultValue: true,
    merge: "replace",
    env: {
      names: ["EASY_AGENT_DISABLE_PROMPT_CACHING"],
      read: (env) =>
        /^(1|true|yes|on)$/i.test(env.EASY_AGENT_DISABLE_PROMPT_CACHING?.trim() ?? "")
          ? { value: false, name: "EASY_AGENT_DISABLE_PROMPT_CACHING" }
          : undefined,
      position: "top",
    },
    applied: true,
  },
  {
    path: "features.experimentalBetas",
    component: "features",
    summary: "Experimental beta request fields.",
    defaultValue: true,
    merge: "replace",
    env: {
      names: ["EASY_AGENT_DISABLE_EXPERIMENTAL_BETAS", "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"],
      read: (env) => {
        const truthy = (value: string | undefined) => /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
        if (truthy(env.EASY_AGENT_DISABLE_EXPERIMENTAL_BETAS)) {
          return { value: false, name: "EASY_AGENT_DISABLE_EXPERIMENTAL_BETAS" };
        }
        if (truthy(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)) {
          return { value: false, name: "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS" };
        }
        return undefined;
      },
      position: "top",
    },
    applied: true,
  },
  {
    path: "features.maxRetries",
    component: "features",
    summary: "Retries for a failed model request.",
    defaultValue: DEFAULT_MAX_RETRIES,
    merge: "replace",
    env: {
      names: ["EASY_AGENT_MAX_RETRIES", "CLAUDE_CODE_MAX_RETRIES"],
      read: (env) => {
        const name = env.EASY_AGENT_MAX_RETRIES !== undefined ? "EASY_AGENT_MAX_RETRIES" : "CLAUDE_CODE_MAX_RETRIES";
        const raw = env.EASY_AGENT_MAX_RETRIES ?? env.CLAUDE_CODE_MAX_RETRIES;
        if (!raw) return undefined;
        const parsed = Number.parseInt(raw, 10);
        return Number.isFinite(parsed) && parsed >= 0
          ? { value: parsed, name }
          : { invalid: "expected a non-negative integer", name, raw };
      },
      position: "override",
    },
    applied: true,
  },
  {
    path: "features.maxTurns",
    component: "features",
    summary: "Tool-turn limit per request; unset uses the frontend default.",
    merge: "replace",
    settings: { key: "maxTurns", read: (raw) => positiveInteger(raw, "maxTurns"), scope: "trusted" },
    applied: true,
  },

  {
    path: "session.checkpoints",
    component: "session",
    summary: "File checkpoints before Write, Edit, and MultiEdit.",
    defaultValue: true,
    merge: "replace",
    settings: { key: "checkpointingEnabled", read: boolean("checkpointingEnabled"), scope: "trusted" },
    env: {
      names: ["EASY_AGENT_DISABLE_CHECKPOINTING"],
      read: (env) =>
        isTruthy(env.EASY_AGENT_DISABLE_CHECKPOINTING)
          ? { value: false, name: "EASY_AGENT_DISABLE_CHECKPOINTING" }
          : undefined,
      position: "top",
    },
    applied: true,
  },
  specOnly("trace.level", "trace", "Request record level.", "off"),
];

export const HARNESS_KEY_BY_PATH: ReadonlyMap<string, HarnessKey> = new Map(HARNESS_KEYS.map((key) => [key.path, key]));
