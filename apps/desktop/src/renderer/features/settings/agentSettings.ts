/**
 * Easy Agent settings as the settings pages edit them, built from the
 * Agent's `config/read` snapshot, and the `config/write` calls an edit turns
 * into. Each value records the settings layer that set it, so a page can show
 * where it comes from; list values (rules, directories, env) keep one entry
 * per file, so an edit only touches the file being edited.
 */

import type { ConfigSnapshot, PermissionMode } from "../../../shared/agent";
import type { SettingLayer, WriteScope } from "../../lib/scopes";
import { WRITE_SCOPES } from "../../lib/scopes";

export interface RuleEntry {
  rule: string;
  effect: "allow" | "ask" | "deny";
  scope: WriteScope;
}

export interface EnvEntry {
  key: string;
  value: string;
  scope: WriteScope;
}

export interface SandboxSettings {
  enabled: boolean;
  failClosed: boolean;
  autoAllowBashIfSandboxed: boolean;
  allowUnsandboxedCommands: boolean;
  excludedCommands: string[];
  allowWrite: string[];
  denyWrite: string[];
  allowRead: string[];
  denyRead: string[];
  allowedDomains: string[];
  deniedDomains: string[];
  allowLocalBinding: boolean;
  allowUnixSockets: string[];
  allowAllUnixSockets: boolean;
}

export interface AgentSettings {
  language: string;
  outputStyle: string;
  maxTurns: number;
  respectGitignore: boolean;
  toolSearch: "off" | "auto" | "on";
  toolSearchAutoThreshold: number;
  syntaxHighlightingDisabled: boolean;
  prefersReducedMotion: boolean;
  statusLine: string;
  mode: PermissionMode;
  rules: RuleEntry[];
  additionalDirectories: { path: string; scope: WriteScope }[];
  sandbox: SandboxSettings;
  disableAllHooks: boolean;
  env: EnvEntry[];
  apiKeyHelper: string;
  checkpointingEnabled: boolean;
  cleanupPeriodDays: number;
  alwaysThinkingEnabled: boolean;
  effortLevel: "low" | "medium" | "high" | "max";
  defaultModel: string;
  modelRoles: { background?: string; think?: string; longContext?: string };
}

type SandboxKey = keyof SandboxSettings;
type RoleKey = keyof AgentSettings["modelRoles"];

/** A key a page edits: a top-level setting, a sandbox field, or a model role. */
export type SettingKey = keyof AgentSettings | `sandbox.${SandboxKey}` | `modelRoles.${RoleKey}`;

/** The layer that set each scalar key; absent means the built-in default. */
export type SettingSources = Partial<Record<SettingKey, SettingLayer>>;

/** Settings that only exist as environment variables or command-line flags today, and how to set them now. */
export const TODO_SETTINGS: Record<string, string> = {
  agentTeams: "--agent-teams 或 EASY_AGENT_TEAMS=1",
  taskMode: "会话里的 /tasks 命令，不会保存",
  maxRetries: "EASY_AGENT_MAX_RETRIES",
  promptCaching: "EASY_AGENT_DISABLE_PROMPT_CACHING=1",
  experimentalBetas: "EASY_AGENT_DISABLE_EXPERIMENTAL_BETAS=1",
  mcpConnectTimeout: "MCP_CONNECT_TIMEOUT",
  thinkingBudget: "MAX_THINKING_TOKENS",
  autoModeModel: "EASY_AGENT_AUTO_MODE_MODEL",
  "webSearch.adapter": "WEB_SEARCH_ADAPTER",
  "webSearch.apiKey": "WEB_SEARCH_API_KEY",
};

const SANDBOX_DEFAULTS: SandboxSettings = {
  enabled: false,
  failClosed: true,
  autoAllowBashIfSandboxed: true,
  allowUnsandboxedCommands: true,
  excludedCommands: [],
  allowWrite: [],
  denyWrite: [],
  allowRead: [],
  denyRead: [],
  allowedDomains: [],
  deniedDomains: [],
  allowLocalBinding: false,
  allowUnixSockets: [],
  allowAllUnixSockets: false,
};

const SANDBOX_FIELDS: Record<SandboxKey, string[]> = {
  enabled: ["enabled"],
  failClosed: ["failClosed"],
  autoAllowBashIfSandboxed: ["autoAllowBashIfSandboxed"],
  allowUnsandboxedCommands: ["allowUnsandboxedCommands"],
  excludedCommands: ["excludedCommands"],
  allowWrite: ["filesystem", "allowWrite"],
  denyWrite: ["filesystem", "denyWrite"],
  allowRead: ["filesystem", "allowRead"],
  denyRead: ["filesystem", "denyRead"],
  allowedDomains: ["network", "allowedDomains"],
  deniedDomains: ["network", "deniedDomains"],
  allowLocalBinding: ["network", "allowLocalBinding"],
  allowUnixSockets: ["network", "allowUnixSockets"],
  allowAllUnixSockets: ["network", "allowAllUnixSockets"],
};

const SCALARS = [
  "language",
  "outputStyle",
  "maxTurns",
  "respectGitignore",
  "toolSearch",
  "toolSearchAutoThreshold",
  "syntaxHighlightingDisabled",
  "prefersReducedMotion",
  "mode",
  "disableAllHooks",
  "apiKeyHelper",
  "checkpointingEnabled",
  "cleanupPeriodDays",
  "alwaysThinkingEnabled",
  "effortLevel",
  "defaultModel",
] as const;

const DEFAULTS: Pick<AgentSettings, (typeof SCALARS)[number]> = {
  language: "",
  outputStyle: "default",
  maxTurns: 200,
  respectGitignore: true,
  toolSearch: "on",
  toolSearchAutoThreshold: 10,
  syntaxHighlightingDisabled: false,
  prefersReducedMotion: false,
  mode: "default",
  disableAllHooks: false,
  apiKeyHelper: "",
  checkpointingEnabled: true,
  cleanupPeriodDays: 30,
  alwaysThinkingEnabled: true,
  effortLevel: "medium",
  defaultModel: "",
};

const at = (value: unknown, path: string[]): unknown =>
  path.reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), value);

/** The values of each writable file, as read. */
export function scopeValues(config: ConfigSnapshot, scope: WriteScope): Record<string, unknown> {
  return config.sources.find((s) => s.source === scope)?.values ?? {};
}

const applied = (config: ConfigSnapshot) => config.sources.filter((s) => s.applied);

export function agentFromConfig(config: ConfigSnapshot): { agent: AgentSettings; sources: SettingSources } {
  const sources: SettingSources = {};
  const scalar = <K extends (typeof SCALARS)[number]>(key: K): AgentSettings[K] => {
    const effective = config.effective[key];
    if (effective && effective.source !== "default") sources[key] = effective.source;
    const value = effective?.value;
    return (value === undefined || value === null ? DEFAULTS[key] : value) as AgentSettings[K];
  };
  const values = Object.fromEntries(SCALARS.map((key) => [key, scalar(key)])) as Pick<AgentSettings, (typeof SCALARS)[number]>;

  const statusLine = config.effective.statusLine;
  if (statusLine && statusLine.source !== "default") sources.statusLine = statusLine.source;
  const statusValue = statusLine?.value;

  const rules: RuleEntry[] = [];
  const additionalDirectories: AgentSettings["additionalDirectories"] = [];
  const env: EnvEntry[] = [];
  for (const scope of WRITE_SCOPES) {
    const raw = scopeValues(config, scope);
    for (const effect of ["allow", "ask", "deny"] as const) for (const rule of (raw[effect] as string[] | undefined) ?? []) rules.push({ rule, effect, scope });
    for (const path of (raw.additionalDirectories as string[] | undefined) ?? []) additionalDirectories.push({ path, scope });
    for (const [key, value] of Object.entries((raw.env as Record<string, string> | undefined) ?? {})) env.push({ key, value: String(value), scope });
  }

  // The sandbox loader merges field by field; lists add up across files.
  const sandbox: SandboxSettings = structuredClone(SANDBOX_DEFAULTS);
  for (const src of applied(config)) {
    const raw = src.values.sandbox;
    if (!raw || typeof raw !== "object") continue;
    for (const [field, path] of Object.entries(SANDBOX_FIELDS) as [SandboxKey, string[]][]) {
      const value = at(raw, path);
      if (value === undefined) continue;
      sources[`sandbox.${field}`] = src.source;
      if (Array.isArray(value)) (sandbox[field] as string[]) = [...new Set([...(sandbox[field] as string[]), ...value.map(String)])];
      else (sandbox as unknown as Record<string, unknown>)[field] = value;
    }
  }

  const modelRoles: AgentSettings["modelRoles"] = {};
  for (const src of applied(config)) {
    const raw = src.values.modelRoles as Record<string, string> | undefined;
    for (const role of ["background", "think", "longContext"] as const) {
      if (raw?.[role]) {
        modelRoles[role] = raw[role];
        sources[`modelRoles.${role}`] = src.source;
      }
    }
  }

  return {
    agent: {
      ...values,
      defaultModel: values.defaultModel || config.models.defaultModel || "",
      statusLine: typeof statusValue === "string" ? statusValue : String(at(statusValue, ["command"]) ?? ""),
      rules,
      additionalDirectories,
      sandbox,
      env,
      modelRoles,
    },
    sources,
  };
}

export interface ConfigWrite {
  key: string;
  value: unknown;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const listOrNull = <T>(list: T[]) => (list.length > 0 ? list : null);

function setPath(target: Record<string, unknown>, path: string[], value: unknown): Record<string, unknown> {
  const [head, ...rest] = path;
  if (!head) return target;
  const out = { ...target };
  if (rest.length === 0) {
    if (value === undefined) delete out[head];
    else out[head] = value;
  } else out[head] = setPath((out[head] as Record<string, unknown>) ?? {}, rest, value);
  return out;
}

/**
 * The writes to `scope` that turn `prev` into `next` for the given keys.
 * Lists and objects are written whole for that file; other files are not
 * touched.
 */
export function writesFor(config: ConfigSnapshot, scope: WriteScope, prev: AgentSettings, next: AgentSettings, keys: SettingKey[]): ConfigWrite[] {
  const raw = scopeValues(config, scope);
  const writes: ConfigWrite[] = [];
  const pending: Record<string, unknown> = {};
  const queue = (key: string, value: unknown) => {
    pending[key] = value;
  };
  for (const key of keys) {
    if (key === "rules") {
      for (const effect of ["allow", "ask", "deny"] as const) {
        const pick = (s: AgentSettings) => s.rules.filter((r) => r.scope === scope && r.effect === effect).map((r) => r.rule);
        if (!same(pick(prev), pick(next))) queue(effect, listOrNull(pick(next)));
      }
    } else if (key === "additionalDirectories") {
      queue(key, listOrNull(next.additionalDirectories.filter((d) => d.scope === scope).map((d) => d.path)));
    } else if (key === "env") {
      const entries = next.env.filter((e) => e.scope === scope);
      queue(key, entries.length ? Object.fromEntries(entries.map((e) => [e.key, e.value])) : null);
    } else if (key.startsWith("sandbox.")) {
      const field = key.slice(8) as SandboxKey;
      const base = (pending.sandbox as Record<string, unknown>) ?? (raw.sandbox as Record<string, unknown>) ?? {};
      queue("sandbox", setPath(base, SANDBOX_FIELDS[field], next.sandbox[field]));
    } else if (key.startsWith("modelRoles.")) {
      const role = key.slice(11) as RoleKey;
      const base = (pending.modelRoles as Record<string, unknown>) ?? (raw.modelRoles as Record<string, unknown>) ?? {};
      const roles = setPath(base, [role], next.modelRoles[role] || undefined);
      queue("modelRoles", Object.keys(roles).length ? roles : null);
    } else if (key === "statusLine") {
      queue(key, next.statusLine.trim() ? next.statusLine.trim() : null);
    } else if (key in DEFAULTS) {
      const value = next[key as (typeof SCALARS)[number]];
      queue(key, value === "" ? null : value);
    }
  }
  for (const [key, value] of Object.entries(pending)) writes.push({ key, value });
  return writes;
}
