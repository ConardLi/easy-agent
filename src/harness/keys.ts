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
import { configBoolean, configInteger, configEnum, configString } from "../config/values.js";
import { migrateLegacyEnvironment, parseLegacyToolSearch } from "../config/migration.js";
import { ENVIRONMENT_PROFILE_ID } from "../config/modelSchema.js";

/** Retries for a failed model request when nothing sets `features.maxRetries`. */
export const DEFAULT_MAX_RETRIES = 10;
/** Characters for the skill listing when nothing sets `skills.listingBudgetChars`. */
export const DEFAULT_BUDGET_CHARS = 8000;
/** Recent messages compaction keeps as they are when nothing sets `compaction.keepRecentMessages`. */
export const DEFAULT_KEEP_RECENT_MESSAGES = 8;

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
  scope: Exclude<SettingScope, "user-file" | "local-file">;
}

export type HarnessEnvRead =
  | { value: unknown; name: string }
  | { invalid: string; name: string; raw: string }
  | undefined;

export interface HarnessEnvInput {
  names: readonly string[];
  read: (env: NodeJS.ProcessEnv) => HarnessEnvRead;
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

export { parseLegacyToolSearch };

function envValue(name: string, parse: (value: string | undefined, name: string) => unknown): HarnessEnvInput {
  return {
    names: [name],
    read: (env) => {
      const value = parse(env[name], name);
      return value === undefined ? undefined : { value, name };
    },
  };
}
const envInteger = (name: string, min = 1) => envValue(name, (value, field) => configInteger(value, field, min));
const envBoolean = (name: string, invert = false) =>
  envValue(name, (value, field) => {
    const parsed = configBoolean(value, field);
    return parsed === undefined ? undefined : invert ? !parsed : parsed;
  });
const reasoningField =
  (key: string) =>
  (raw: Record<string, unknown>): unknown =>
    raw.reasoning && typeof raw.reasoning === "object" ? (raw.reasoning as Record<string, unknown>)[key] : undefined;

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
    summary: "Main model profile ID; unset selects the only available profile.",
    defaultValue: "",
    merge: "replace",
    settings: { key: "model", read: trimmedString("model"), scope: "trusted" },
    env: {
      names: ["EASY_AGENT_PROFILE", "EASY_AGENT_PROTOCOL", "EASY_AGENT_MODEL", "EASY_AGENT_BASE_URL"],
      read: (env) => {
        const migration = migrateLegacyEnvironment(env);
        const canonical = migration.env;
        // Legacy model variables used to be a fallback, not an override of a
        // saved selection. The profile migration preserves that relationship.
        if (migration.legacyConnection) return undefined;
        if (
          configString(canonical.EASY_AGENT_PROFILE) &&
          ["EASY_AGENT_PROTOCOL", "EASY_AGENT_MODEL", "EASY_AGENT_BASE_URL"].some((name) =>
            configString(canonical[name]),
          )
        ) {
          return { value: ENVIRONMENT_PROFILE_ID, name: "environment.connection" };
        }
        if (configString(canonical.EASY_AGENT_PROFILE))
          return { value: canonical.EASY_AGENT_PROFILE!.trim(), name: "EASY_AGENT_PROFILE" };
        if (
          ["EASY_AGENT_PROTOCOL", "EASY_AGENT_MODEL", "EASY_AGENT_BASE_URL"].some((name) =>
            configString(canonical[name]),
          )
        ) {
          return { value: ENVIRONMENT_PROFILE_ID, name: "EASY_AGENT_PROTOCOL/EASY_AGENT_MODEL" };
        }
        return undefined;
      },
    },
    applied: true,
  },
  ...(["background", "think", "longContext", "compaction", "webFetch"] as const).map(
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
    env: envValue("EASY_AGENT_AUTO_MODE_MODEL", (value) => configString(value)),
    applied: true,
  },

  ...selection("tools", "tools", true),
  {
    ...specOnly(
      "tools.config",
      "tools",
      "Settings of single tools by name: timeoutMs, maxOutputBytes, maxResultChars.",
    ),
    applied: true,
  },
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
    env: envValue("EASY_AGENT_WEB_SEARCH_BACKEND", (value, name) => configEnum(value, name, ["bing", "api"])),
    applied: true,
  },

  { ...specOnly("prompt.identity", "prompt", "Identity section text; empty leaves it out."), applied: true },
  {
    path: "prompt.language",
    component: "prompt",
    summary: "Language the agent replies in.",
    merge: "replace",
    settings: { key: "language", read: trimmedString("language"), scope: "trusted" },
    applied: true,
  },
  {
    ...specOnly("prompt.sections", "prompt", "Dynamic sections turned off, replaced, moved, or added."),
    applied: true,
  },

  ...(
    [
      ["context.agentMd", "Load AGENTS.md and AGENT.md files."],
      ["context.memory", "Load the project memory index."],
      ["context.environment", "Include the working directory, date, and operating system."],
      ["context.gitStatus", "Include the git snapshot taken when the session starts."],
      ["context.skills", "Include the skill listing."],
      ["context.agents", "Include the sub-agent listing."],
    ] as const
  ).map(([keyPath, summary]): HarnessKey => ({ ...specOnly(keyPath, "context", summary, true), applied: true })),

  {
    ...specOnly(
      "compaction.auto",
      "compaction",
      "Summarize the conversation automatically near the context limit and after a prompt-too-long error.",
      true,
    ),
    applied: true,
  },
  {
    ...specOnly(
      "compaction.autoThreshold",
      "compaction",
      "Fraction of the effective window that starts auto-compaction; unset starts it a fixed buffer below the window.",
    ),
    applied: true,
  },
  {
    ...specOnly("compaction.microcompact", "compaction", "Clear old tool results and images before each turn.", true),
    applied: true,
  },
  {
    ...specOnly(
      "compaction.keepRecentMessages",
      "compaction",
      "Recent messages compaction keeps as they are: their tool results are not cleared, and a summary keeps them after it.",
      DEFAULT_KEEP_RECENT_MESSAGES,
    ),
    applied: true,
  },
  {
    path: "compaction.contextWindow",
    component: "compaction",
    summary: "Context window size; unset uses the model's.",
    merge: "replace",
    env: envInteger("EASY_AGENT_MAX_CONTEXT_TOKENS"),
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
  { ...specOnly("hooks.enabled", "hooks", "Run command hooks.", true), applied: true },
  ...selection("hooks", "hook selection keys", true),
  ...selection("rules", "rule file paths (memory for the memory index)", true),

  ...selection("skills", "skills", true),
  {
    path: "skills.listingBudgetChars",
    component: "skills",
    summary: "Characters for the skill listing.",
    defaultValue: DEFAULT_BUDGET_CHARS,
    merge: "replace",
    env: envInteger("EASY_AGENT_SKILL_CHAR_BUDGET"),
    applied: true,
  },
  ...selection("agents", "sub-agents", true),
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
  ...selection("plugins", "plugins", true),

  {
    path: "features.agentTeams",
    component: "features",
    summary: "Agent Teams tools.",
    defaultValue: false,
    merge: "replace",
    env: envBoolean("EASY_AGENT_TEAMS"),
    argvAgentTeams: true,
    applied: true,
  },
  {
    ...specOnly(
      "features.tasks",
      "features",
      "Task tracking a session starts with: task (persistent task list) or todo (session-only list).",
      "task",
    ),
    applied: true,
  },
  {
    ...specOnly(
      "features.autoModeClassifier",
      "features",
      "Auto Mode asks the classifier about actions no rule decides; off asks the user.",
      true,
    ),
    applied: true,
  },
  {
    path: "features.toolSearch",
    component: "features",
    summary: "Defer tool schemas: off, auto, or on.",
    defaultValue: "on",
    merge: "replace",
    settings: { key: "toolSearch", read: (raw) => raw.toolSearch, scope: "trusted" },
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
    applied: true,
  },
  {
    path: "reasoning.mode",
    component: "reasoning",
    summary: "Reasoning intent: auto uses confirmed model capabilities.",
    defaultValue: "auto",
    merge: "replace",
    settings: { key: "reasoning.mode", read: reasoningField("mode"), scope: "trusted" },
    env: envValue("EASY_AGENT_REASONING", (value, name) => configEnum(value, name, ["auto", "on", "off"])),
    applied: true,
  },
  {
    path: "reasoning.budgetTokens",
    component: "reasoning",
    summary: "Reasoning budget in tokens.",
    merge: "replace",
    settings: { key: "reasoning.budgetTokens", read: reasoningField("budgetTokens"), scope: "trusted" },
    env: envInteger("EASY_AGENT_REASONING_BUDGET_TOKENS"),
    applied: true,
  },
  {
    path: "reasoning.effort",
    component: "reasoning",
    summary: "Default reasoning effort; unset lets the model decide.",
    merge: "replace",
    settings: {
      key: "reasoning.effort",
      read: reasoningField("effort"),
      scope: "trusted",
    },
    applied: true,
  },
  {
    path: "features.promptCaching",
    component: "features",
    summary: "Prompt-cache markers and keys in requests.",
    defaultValue: true,
    merge: "replace",
    env: envBoolean("EASY_AGENT_DISABLE_PROMPT_CACHING", true),
    applied: true,
  },
  {
    path: "features.experimentalBetas",
    component: "features",
    summary: "Experimental beta request fields.",
    defaultValue: true,
    merge: "replace",
    env: envBoolean("EASY_AGENT_DISABLE_EXPERIMENTAL_BETAS", true),
    applied: true,
  },
  {
    path: "features.maxRetries",
    component: "features",
    summary: "Retries for a failed model request.",
    defaultValue: DEFAULT_MAX_RETRIES,
    merge: "replace",
    env: envInteger("EASY_AGENT_MAX_RETRIES", 0),
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
    env: envBoolean("EASY_AGENT_DISABLE_CHECKPOINTING", true),
    applied: true,
  },
  {
    ...specOnly(
      "trace.level",
      "trace",
      "Request records: summary writes each request's parts (sizes, tokens, hashes) next to the transcript; off writes none.",
      "summary",
    ),
    applied: true,
  },
];

export const HARNESS_KEY_BY_PATH: ReadonlyMap<string, HarnessKey> = new Map(HARNESS_KEYS.map((key) => [key.path, key]));
