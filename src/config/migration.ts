/**
 * The only compatibility reader for retired product configuration.
 * Conversion is pure: callers preview the report before writing a backup and
 * applying it. Re-reading a canonical document makes no further changes.
 */
import { createHash } from "node:crypto";
import { configString } from "./values.js";
import { isAuthenticationHeader, MODEL_PROTOCOLS } from "./modelSchema.js";

/** A saved target owns its credentials, even if a declared reference is missing. */
export function savedProfileOwnsConnection(
  layers: readonly (Record<string, unknown> | null)[],
  selection?: string,
  canonicalProfileIds?: ReadonlySet<string>,
): boolean {
  const profiles: Record<string, Record<string, unknown>> = {};
  let selected: string | undefined;
  for (const raw of layers) {
    for (const [id, value] of Object.entries(object(raw?.models) ?? {})) {
      const profile = object(value);
      if (profile) profiles[id] = { ...profiles[id], ...profile };
    }
    selected = configString(typeof raw?.model === "string" ? raw.model : undefined) ?? selected;
    if (!selected) selected = configString(typeof raw?.defaultModel === "string" ? raw.defaultModel : undefined);
  }
  selected = configString(selection) ?? selected;
  if (!selected && Object.keys(profiles).length === 1) selected = Object.keys(profiles)[0];
  const profile = selected ? profiles[selected] : undefined;
  return Boolean(
    selected &&
      (!canonicalProfileIds || canonicalProfileIds.has(selected)) &&
      profile &&
      MODEL_PROTOCOLS.includes(profile.protocol as (typeof MODEL_PROTOCOLS)[number]) &&
      configString(typeof profile.model === "string" ? profile.model : undefined),
  );
}

export interface MigrationNotice {
  level: "info" | "warning" | "error";
  field: string;
  message: string;
}

export interface SettingsMigration {
  value: Record<string, unknown>;
  notices: MigrationNotice[];
  changed: boolean;
}

/** The old defaultModel was consulted only when no trusted layer set model. */
export function legacyDefaultModelIsShadowed(
  layers: readonly { raw: Record<string, unknown> | null; trusted: boolean }[],
): boolean {
  return layers.some((layer) => layer.trusted && typeof layer.raw?.model === "string" && layer.raw.model.trim() !== "");
}

export const LEGACY_ENVIRONMENT_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "MAX_THINKING_TOKENS",
  "CLAUDE_CODE_DISABLE_THINKING",
  "CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING",
  "DISABLE_INTERLEAVED_THINKING",
  "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "CLAUDE_CODE_MAX_RETRIES",
  "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
  "WEB_SEARCH_ADAPTER",
  "MCP_CONNECT_TIMEOUT",
  "EASY_AGENT_ENABLE_TOOL_SEARCH",
  "ENABLE_TOOL_SEARCH",
] as const;

export const CONNECTION_ENVIRONMENT_NAMES = [
  "EASY_AGENT_PROFILE",
  "EASY_AGENT_PROTOCOL",
  "EASY_AGENT_MODEL",
  "EASY_AGENT_BASE_URL",
  "EASY_AGENT_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

/** Legacy key-only connections count as a target only at the migration boundary. */
export function environmentDeclaresConnection(env: Readonly<NodeJS.ProcessEnv>): boolean {
  return CONNECTION_ENVIRONMENT_NAMES.some((name) => name !== "EASY_AGENT_API_KEY" && configString(env[name]));
}

/** Used only to preserve the old selection when an actual legacy connection exists. */
const LEGACY_DEFAULT_MODEL = "claude-sonnet-4-20250514";

export interface EnvironmentMigration {
  /** Includes original names only so explicit user-declared references still resolve. */
  env: NodeJS.ProcessEnv;
  notices: MigrationNotice[];
  legacyConnection: boolean;
  savedProfileSelected?: boolean;
  profileOptions: {
    adaptiveThinking?: boolean;
    interleavedThinking?: boolean;
    effort?: boolean;
  };
  toolSearch?: { toolSearch: "off" | "auto" | "on"; toolSearchAutoThreshold: number };
}

export function parseLegacyToolSearch(
  value: string,
): { toolSearch: "off" | "auto" | "on"; toolSearchAutoThreshold: number } | null {
  const text = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return { toolSearch: "on", toolSearchAutoThreshold: 10 };
  if (["0", "false", "no", "off"].includes(text)) return { toolSearch: "off", toolSearchAutoThreshold: 10 };
  if (text === "auto") return { toolSearch: "auto", toolSearchAutoThreshold: 10 };
  if (/^auto:\d+(?:\.\d+)?$/.test(text)) {
    const threshold = Number(text.slice(5));
    if (threshold > 100) return null;
    return {
      toolSearch: threshold === 0 ? "on" : threshold === 100 ? "off" : "auto",
      toolSearchAutoThreshold: threshold,
    };
  }
  return null;
}

export function migrateLegacyEnvironment(
  input: Readonly<NodeJS.ProcessEnv>,
  options: { savedProfileSelected?: boolean } = {},
): EnvironmentMigration {
  const env = { ...input };
  const notices: MigrationNotice[] = [];
  const note = (field: string, message: string, level: MigrationNotice["level"] = "warning") =>
    notices.push({ level, field, message });
  const canonicalTarget =
    options.savedProfileSelected === true ||
    ["EASY_AGENT_PROFILE", "EASY_AGENT_PROTOCOL", "EASY_AGENT_MODEL", "EASY_AGENT_BASE_URL"].some(
      (key) => configString(input[key]) !== undefined,
    );
  const legacyTarget = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"].some(
    (key) => configString(input[key]) !== undefined,
  );
  const legacyConnection = legacyTarget && !canonicalTarget;
  if (legacyTarget && canonicalTarget) {
    note(
      "environment.connection",
      "Legacy connection variables are ignored because a canonical connection was selected.",
    );
  } else if (legacyConnection) {
    const apiKey = configString(input.ANTHROPIC_API_KEY);
    const token = configString(input.ANTHROPIC_AUTH_TOKEN);
    if (apiKey && token && apiKey !== token) {
      note(
        "environment.connection",
        "ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN disagree. Select one API Key explicitly before migrating this connection.",
        "error",
      );
    } else if (configString(input.EASY_AGENT_API_KEY)) {
      note(
        "environment.connection",
        "Provide EASY_AGENT_PROTOCOL and EASY_AGENT_MODEL with EASY_AGENT_API_KEY; canonical and legacy connection fields cannot be combined.",
        "error",
      );
    } else {
      env.EASY_AGENT_PROTOCOL = "anthropic";
      env.EASY_AGENT_MODEL = configString(input.ANTHROPIC_MODEL) ?? LEGACY_DEFAULT_MODEL;
      if (configString(input.ANTHROPIC_BASE_URL)) env.EASY_AGENT_BASE_URL = input.ANTHROPIC_BASE_URL;
      if (apiKey || token) env.EASY_AGENT_API_KEY = apiKey ?? token;
      note(
        "environment.connection",
        "Legacy connection converted to an explicit Anthropic profile, preserving its original model.",
      );
      if (token) {
        note(
          "ANTHROPIC_AUTH_TOKEN",
          "Use one API Key with x-api-key by default. Duplicate authentication is removed; verify the gateway's authentication policy.",
        );
      }
    }
  }
  for (const [oldName, name] of [
    ["CLAUDE_CODE_MAX_CONTEXT_TOKENS", "EASY_AGENT_MAX_CONTEXT_TOKENS"],
    ["CLAUDE_CODE_MAX_RETRIES", "EASY_AGENT_MAX_RETRIES"],
    ["CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "EASY_AGENT_DISABLE_EXPERIMENTAL_BETAS"],
    ["WEB_SEARCH_ADAPTER", "EASY_AGENT_WEB_SEARCH_BACKEND"],
    ["MCP_CONNECT_TIMEOUT", "EASY_AGENT_MCP_CONNECT_TIMEOUT_MS"],
  ]) {
    if (!configString(input[oldName!])) continue;
    if (!configString(input[name!])) env[name!] = input[oldName!];
    note(
      oldName!,
      `Use ${name}; the canonical value wins when both exist. Environment priority is below explicit overrides and managed policy.`,
    );
  }
  const budget = configString(input.MAX_THINKING_TOKENS);
  if (budget !== undefined) {
    if (!/^\d+$/.test(budget) || !Number.isSafeInteger(Number(budget))) {
      note(
        "MAX_THINKING_TOKENS",
        "Expected a non-negative integer; set reasoning.mode and reasoning.budgetTokens explicitly.",
        "error",
      );
    } else {
      if (!configString(input.EASY_AGENT_REASONING)) env.EASY_AGENT_REASONING = Number(budget) === 0 ? "off" : "on";
      if (Number(budget) > 0 && !configString(input.EASY_AGENT_REASONING_BUDGET_TOKENS)) {
        env.EASY_AGENT_REASONING_BUDGET_TOKENS = budget;
      }
      note(
        "MAX_THINKING_TOKENS",
        "Converted to reasoning mode and budget. Explicit session overrides and policy now take precedence.",
      );
    }
  }
  // These old switches used presence, including the strings "false" and "0".
  // Preserve that behavior only here; canonical variables use strict booleans.
  if (input.CLAUDE_CODE_DISABLE_THINKING) {
    if (!configString(input.EASY_AGENT_REASONING)) env.EASY_AGENT_REASONING = "off";
    note(
      "CLAUDE_CODE_DISABLE_THINKING",
      "The old presence-based request prohibition takes precedence over old thinking defaults; migrated to reasoning.mode=off.",
    );
  }
  const profileOptions: EnvironmentMigration["profileOptions"] = {};
  for (const [name, key, value] of [
    ["CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING", "adaptiveThinking", false],
    ["DISABLE_INTERLEAVED_THINKING", "interleavedThinking", false],
    ["CLAUDE_CODE_ALWAYS_ENABLE_EFFORT", "effort", true],
  ] as const) {
    if (input[name]) {
      profileOptions[key] = value;
      note(
        name,
        "Move this legacy global override to the selected Anthropic profile. It must not apply to other connections.",
      );
    }
  }
  const legacySearch = input.EASY_AGENT_ENABLE_TOOL_SEARCH ?? input.ENABLE_TOOL_SEARCH;
  let toolSearch: EnvironmentMigration["toolSearch"];
  if (configString(legacySearch)) {
    toolSearch = parseLegacyToolSearch(legacySearch!) ?? undefined;
    note(
      "toolSearch",
      toolSearch
        ? "Move the retired ToolSearch environment setting to toolSearch/toolSearchAutoThreshold or --tool-search."
        : "Invalid legacy ToolSearch value; use on, off, auto, or auto:N (0–100).",
      toolSearch ? "warning" : "error",
    );
  }
  return {
    env,
    notices,
    legacyConnection,
    profileOptions,
    ...(options.savedProfileSelected ? { savedProfileSelected: true } : {}),
    ...(toolSearch ? { toolSearch } : {}),
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Stable IDs avoid duplicates on repeated migration and avoid revealing URLs or credentials. */
export function legacyProfileId(model: string): string {
  return `legacy-${createHash("sha256").update(model).digest("hex").slice(0, 12)}`;
}

/** An independent legacy role retains its original credential when the main profile owns another connection. */
export function legacyRoleConnection(migration: EnvironmentMigration | undefined) {
  if (!migration) return undefined;
  if (migration.legacyConnection) return { ...migration, apiKeyReference: "${EASY_AGENT_API_KEY}" };
  const original = Object.fromEntries(LEGACY_ENVIRONMENT_NAMES.map((name) => [name, migration.env[name]]));
  const legacy = migrateLegacyEnvironment(original);
  if (!legacy.legacyConnection) return undefined;
  const credential = configString(original.ANTHROPIC_API_KEY)
    ? "ANTHROPIC_API_KEY"
    : configString(original.ANTHROPIC_AUTH_TOKEN)
      ? "ANTHROPIC_AUTH_TOKEN"
      : undefined;
  return { ...legacy, apiKeyReference: credential ? `\${${credential}}` : undefined };
}

/** A raw legacy classifier selection is converted only with confirmed connection evidence. */
export function legacyClassifierConnection(migration: EnvironmentMigration, configuredIds: ReadonlySet<string>) {
  const model = configString(migration.env.EASY_AGENT_AUTO_MODE_MODEL);
  const connection = legacyRoleConnection(migration);
  if (!model || configuredIds.has(model) || !connection) return undefined;
  return {
    id: legacyProfileId(model),
    notices: connection.notices,
    profile: {
      protocol: "anthropic" as const,
      model,
      ...(connection.env.EASY_AGENT_BASE_URL ? { baseURL: connection.env.EASY_AGENT_BASE_URL } : {}),
      ...(connection.env.EASY_AGENT_API_KEY ? { apiKey: connection.apiKeyReference } : {}),
    },
  };
}

/** Saved raw names may be mapped only to a unique, already configured connection. */
export function migrateSessionModelSelection(
  saved: string,
  profiles: Readonly<Record<string, { model: string }>>,
): string | undefined {
  if (profiles[saved]) return saved;
  const matches = Object.entries(profiles).filter(([, profile]) => profile.model === saved);
  return matches.length === 1 ? matches[0]![0] : undefined;
}

function migrateReasoning(
  raw: Record<string, unknown>,
  features: Record<string, unknown> | undefined,
  notices: MigrationNotice[],
  field: string,
): void {
  const reasoning = { ...object(raw.reasoning) };
  const old = features ?? raw;
  const thinking = features ? old.thinking : old.alwaysThinkingEnabled;
  const budget = features ? old.thinkingBudget : undefined;
  const effort = features ? old.effort : old.effortLevel;
  const present =
    thinking !== undefined || budget !== undefined || effort !== undefined || old.thinkingInRequests !== undefined;
  if (!present) return;
  if (reasoning.mode === undefined && (thinking !== undefined || old.thinkingInRequests !== undefined)) {
    reasoning.mode = thinking === false || old.thinkingInRequests === false ? "off" : "auto";
  }
  if (reasoning.budgetTokens === undefined && budget !== undefined) reasoning.budgetTokens = budget;
  if (reasoning.effort === undefined && effort !== undefined) reasoning.effort = effort;
  raw.reasoning = reasoning;
  for (const key of features
    ? ["thinking", "thinkingBudget", "thinkingInRequests", "effort"]
    : ["alwaysThinkingEnabled", "effortLevel"])
    delete old[key];
  notices.push({
    level: "warning",
    field,
    message:
      "Thinking defaults, request prohibition, budget, and effort are represented by reasoning; canonical fields win conflicts.",
  });
}

function migrateProfile(
  profile: Record<string, unknown>,
  field: string,
  notices: MigrationNotice[],
  inherited = false,
): void {
  const note = (message: string, level: MigrationNotice["level"] = "warning") =>
    notices.push({ level, field, message });
  if (!inherited && profile.protocol === undefined && profile.model !== undefined) {
    profile.protocol = "anthropic";
    note("Missing protocol converted using the legacy Anthropic semantics. New profiles must specify protocol.");
  }
  const protocol = typeof profile.protocol === "string" ? profile.protocol : "";
  for (const key of ["countTokens", "promptCacheKey"] as const) {
    if (profile[key] === undefined) continue;
    const compatible =
      key === "countTokens" ? protocol === "anthropic" : protocol === "openai-chat" || protocol === "openai-responses";
    if (!compatible) {
      note(
        `${key} is incompatible with this protocol; select an applicable protocol option before applying migration.`,
        "error",
      );
      continue;
    }
    const all = { ...object(profile.protocolOptions) };
    const options = { ...object(all[protocol]) };
    if (options[key] === undefined) options[key] = profile[key];
    all[protocol] = options;
    profile.protocolOptions = all;
    delete profile[key];
    note(`${key} moved into the selected protocol's options.`);
  }
  const headers = object(profile.headers);
  const auth = Object.entries(headers ?? {}).filter(([key]) => isAuthenticationHeader(key));
  if (auth.length === 0) return;
  if (auth.length !== 1 || profile.authentication !== undefined) {
    note(
      "Authentication headers require an explicit single-key authentication policy; remove duplicate headers after reviewing the gateway requirements.",
      "error",
    );
    return;
  }
  const [name, raw] = auth[0]!;
  if (typeof raw !== "string") {
    note("Invalid authentication header; configure apiKey and authentication explicitly.", "error");
    return;
  }
  const bearer = /^Bearer /i.test(raw);
  const key = bearer ? raw.slice(7) : raw;
  if (profile.apiKey !== undefined && profile.apiKey !== key) {
    note("The authentication header and apiKey have different sources. Select one API Key explicitly.", "error");
    return;
  }
  profile.apiKey = key;
  profile.authentication = { type: "header", name, ...(bearer ? { prefix: raw.slice(0, 7) } : {}) };
  delete headers![name];
  note("Moved the existing authentication header to a policy referencing the single API Key.");
}

function applyLegacyProfileOptions(
  profile: Record<string, unknown>,
  options: EnvironmentMigration["profileOptions"],
): void {
  if (options.effort !== undefined) profile.capabilities = { effort: options.effort, ...object(profile.capabilities) };
  const protocolOptions = { ...object(profile.protocolOptions) };
  const anthropic = { ...object(protocolOptions.anthropic) };
  if (options.adaptiveThinking !== undefined) anthropic.adaptiveThinking ??= options.adaptiveThinking;
  if (options.interleavedThinking !== undefined) anthropic.interleavedThinking ??= options.interleavedThinking;
  if (Object.keys(anthropic).length) profile.protocolOptions = { ...protocolOptions, anthropic };
}

export function migrateSettings(
  input: Record<string, unknown>,
  context: {
    inheritedProfileIds?: ReadonlySet<string>;
    knownProfileIds?: ReadonlySet<string>;
    legacyEnvironment?: EnvironmentMigration;
    legacyDefaultModelShadowed?: boolean;
    savedProfileSelected?: boolean;
  } = {},
): SettingsMigration {
  const value = structuredClone(input);
  const notices: MigrationNotice[] = [];
  const inheritedIds = context.inheritedProfileIds ?? new Set<string>();
  const knownIds = context.knownProfileIds ?? inheritedIds;
  const oldEnvironment = object(value.env);
  let connection = context.legacyEnvironment;
  let roleConnection = legacyRoleConnection(connection);
  let localEnvironment: EnvironmentMigration | undefined;
  if (oldEnvironment) {
    const strings = Object.fromEntries(Object.entries(oldEnvironment).map(([key, item]) => [key, String(item)]));
    const environment = migrateLegacyEnvironment(strings, {
      savedProfileSelected: context.savedProfileSelected ?? savedProfileOwnsConnection([input]),
    });
    localEnvironment = environment;
    roleConnection = legacyRoleConnection(environment) ?? roleConnection;
    if (
      typeof value.model === "string" &&
      !environment.legacyConnection &&
      ["EASY_AGENT_PROTOCOL", "EASY_AGENT_MODEL", "EASY_AGENT_BASE_URL"].some((name) => configString(strings[name]))
    ) {
      notices.push({
        level: "error",
        field: "environment.connection",
        message: "This settings layer selects model and a shortcut connection; keep one complete connection source.",
      });
    }
    connection = environment.legacyConnection ? environment : connection;
    notices.push(...environment.notices);
    const next = { ...environment.env };
    value.env = next;
    if (environment.legacyConnection && !environment.notices.some((notice) => notice.level === "error")) {
      const profiles = object(value.models) ?? {};
      const selection =
        typeof value.model === "string"
          ? value.model
          : typeof value.defaultModel === "string"
            ? value.defaultModel
            : undefined;
      const selectedProfile = selection ? object(profiles[selection]) : undefined;
      if (!selectedProfile && !(selection && knownIds.has(selection))) {
        const model = selection ?? environment.env.EASY_AGENT_MODEL!;
        const id = legacyProfileId(model);
        const profile: Record<string, unknown> = {
          protocol: "anthropic",
          model,
          ...(environment.env.EASY_AGENT_BASE_URL ? { baseURL: environment.env.EASY_AGENT_BASE_URL } : {}),
          ...(environment.env.EASY_AGENT_API_KEY ? { apiKey: "${EASY_AGENT_API_KEY}" } : {}),
        };
        applyLegacyProfileOptions(profile, environment.profileOptions);
        if (profiles[id] && JSON.stringify(profiles[id]) !== JSON.stringify(profile)) {
          notices.push({
            level: "error",
            field: "models",
            message:
              "A generated migration profile ID already exists with different settings; choose a distinct profile ID.",
          });
        } else {
          profiles[id] = profile;
          value.models = profiles;
          value.model = id;
          // The target now belongs to a saved profile; the credential stays a reference.
          delete next.EASY_AGENT_PROTOCOL;
          delete next.EASY_AGENT_MODEL;
          delete next.EASY_AGENT_BASE_URL;
          notices.push({
            level: "warning",
            field: "model",
            message: "Created a stable explicit profile for the previously selected raw model.",
          });
        }
      } else if (selectedProfile) {
        delete next.EASY_AGENT_PROTOCOL;
        delete next.EASY_AGENT_MODEL;
        delete next.EASY_AGENT_BASE_URL;
        if (selectedProfile.protocol === undefined || selectedProfile.protocol === "anthropic") {
          if (selectedProfile.apiKey === undefined && environment.env.EASY_AGENT_API_KEY)
            selectedProfile.apiKey = "${EASY_AGENT_API_KEY}";
          if (selectedProfile.baseURL === undefined && environment.env.EASY_AGENT_BASE_URL)
            selectedProfile.baseURL = environment.env.EASY_AGENT_BASE_URL;
          applyLegacyProfileOptions(selectedProfile, environment.profileOptions);
        }
      }
    }
    if (environment.toolSearch) {
      value.toolSearch ??= environment.toolSearch.toolSearch;
      value.toolSearchAutoThreshold ??= environment.toolSearch.toolSearchAutoThreshold;
    }
  }
  if (value.defaultModel !== undefined) {
    if (value.model === undefined && !context.legacyDefaultModelShadowed) value.model = value.defaultModel;
    delete value.defaultModel;
    notices.push({
      level: "warning",
      field: "model",
      message: context.legacyDefaultModelShadowed
        ? "defaultModel was a fallback shadowed by a trusted model selection; removed it without changing the selected model."
        : "defaultModel retired; the existing model selection takes precedence.",
    });
  }
  if (value.claudeMdExcludes !== undefined) {
    value.agentMdExcludes = [...new Set([...stringList(value.agentMdExcludes), ...stringList(value.claudeMdExcludes)])];
    delete value.claudeMdExcludes;
    notices.push({
      level: "warning",
      field: "agentMdExcludes",
      message: "Merged old and new exclusions so previously excluded rules stay excluded.",
    });
  }
  migrateReasoning(value, undefined, notices, "reasoning");
  const profiles = object(value.models) ?? {};
  const preserveReference = (container: Record<string, unknown>, key: string, field: string, role = false) => {
    const original = configString(typeof container[key] === "string" ? container[key] : undefined);
    const target = role ? roleConnection : connection?.legacyConnection ? connection : undefined;
    if (!original || profiles[original] || knownIds.has(original) || !target) return;
    const errors = target.notices.filter((notice) => notice.level === "error");
    if (errors.length) {
      notices.push(...errors.map((notice) => ({ ...notice, field })));
      return;
    }
    const id = legacyProfileId(original);
    const env = target.env;
    const profile: Record<string, unknown> = {
      protocol: "anthropic",
      model: original,
      ...(env.EASY_AGENT_BASE_URL ? { baseURL: env.EASY_AGENT_BASE_URL } : {}),
      ...(env.EASY_AGENT_API_KEY ? { apiKey: role ? roleConnection!.apiKeyReference : "${EASY_AGENT_API_KEY}" } : {}),
    };
    applyLegacyProfileOptions(profile, target.profileOptions);
    if (profiles[id] && JSON.stringify(profiles[id]) !== JSON.stringify(profile)) {
      notices.push({
        level: "error",
        field,
        message: "Legacy profile ID collision; choose a distinct explicit profile ID.",
      });
      return;
    }
    profiles[id] ??= profile;
    value.models = profiles;
    container[key] = id;
    notices.push({
      level: "warning",
      field,
      message: "Preserved the historical raw model in a stable profile using the confirmed legacy connection.",
    });
  };
  const roles = object(value.modelRoles);
  for (const role of Object.keys(roles ?? {})) preserveReference(roles!, role, `modelRoles.${role}`, true);
  for (const [name, item] of Object.entries(object(value.harnesses) ?? {})) {
    const model = object(object(item)?.model);
    if (!model) continue;
    preserveReference(model, "main", `harnesses.${name}.model.main`);
    const scopedRoles = object(model.roles);
    for (const role of Object.keys(scopedRoles ?? {}))
      preserveReference(scopedRoles!, role, `harnesses.${name}.model.roles.${role}`, true);
  }
  const savedEnv = object(value.env);
  if (savedEnv) preserveReference(savedEnv, "EASY_AGENT_AUTO_MODE_MODEL", "env.EASY_AGENT_AUTO_MODE_MODEL", true);
  const inheritedClassifier = configString(context.legacyEnvironment?.env.EASY_AGENT_AUTO_MODE_MODEL);
  if (
    inheritedClassifier &&
    !profiles[legacyProfileId(inheritedClassifier)] &&
    !inheritedIds.has(legacyProfileId(inheritedClassifier)) &&
    !knownIds.has(inheritedClassifier)
  )
    preserveReference({ classifier: inheritedClassifier }, "classifier", "env.EASY_AGENT_AUTO_MODE_MODEL", true);
  // A raw historical selection is convertible only with evidence of the
  // original legacy connection. A new typo without that evidence stays an error.
  preserveReference(value, "model", "model");
  if (savedEnv && localEnvironment) {
    // Generated role profiles may explicitly retain their original credential.
    const references = JSON.stringify({ models: value.models, hooks: value.hooks, mcpServers: value.mcpServers });
    for (const name of LEGACY_ENVIRONMENT_NAMES) {
      if (!localEnvironment.notices.some((notice) => notice.level === "error") && !references.includes(`\${${name}}`))
        delete savedEnv[name];
    }
  }
  for (const [id, item] of Object.entries(profiles)) {
    const profile = object(item);
    if (profile) {
      const oldImplicit = profile.protocol === undefined && profile.model !== undefined && !inheritedIds.has(id);
      migrateProfile(profile, `models.${id}`, notices, inheritedIds.has(id));
      if (oldImplicit && connection?.legacyConnection) {
        if (profile.apiKey === undefined && connection.env.EASY_AGENT_API_KEY) profile.apiKey = "${EASY_AGENT_API_KEY}";
        if (profile.baseURL === undefined && connection.env.EASY_AGENT_BASE_URL)
          profile.baseURL = connection.env.EASY_AGENT_BASE_URL;
      }
    }
  }
  const chosen =
    typeof value.model === "string" && object(profiles[value.model])
      ? value.model
      : Object.keys(profiles).length === 1
        ? Object.keys(profiles)[0]
        : undefined;
  if (connection && Object.keys(connection.profileOptions).length && !connection.legacyConnection) {
    const targets = new Set([
      ...(chosen ? [chosen] : []),
      ...Object.values(object(value.harnesses) ?? {}).flatMap((spec) => {
        const id = object(object(spec)?.model)?.main;
        return typeof id === "string" ? [id] : [];
      }),
    ]);
    const profile = targets.size === 1 && chosen ? object(profiles[chosen]) : undefined;
    if (profile?.protocol === "anthropic") applyLegacyProfileOptions(profile, connection.profileOptions);
    else
      notices.push({
        level: "error",
        field: "protocolOptions",
        message: "Legacy protocol switches have no unambiguous Anthropic profile; assign or remove them explicitly.",
      });
  }
  if (value.apiKeyHelper !== undefined) {
    if (chosen && object(profiles[chosen])?.apiKey === undefined) {
      object(profiles[chosen])!.apiKey = { helper: value.apiKeyHelper };
      delete value.apiKeyHelper;
      notices.push({
        level: "warning",
        field: `models.${chosen}.apiKey`,
        message: "Bound the old helper to the original selected profile; it no longer supplies other connections.",
      });
    } else {
      notices.push({
        level: "error",
        field: "apiKeyHelper",
        message:
          "Bind this helper to one unambiguous profile and resolve any existing API Key source before applying migration.",
      });
    }
  }
  for (const [name, item] of Object.entries(object(value.harnesses) ?? {})) {
    const spec = object(item);
    if (!spec) continue;
    const features = object(spec.features);
    migrateReasoning(spec, features, notices, `harnesses.${name}.reasoning`);
    if (!features) continue;
    const scoped = ["adaptiveThinking", "interleavedThinking", "effortForAllModels"];
    const target = object(spec.model)?.main ?? chosen;
    const profile = typeof target === "string" ? object(profiles[target]) : undefined;
    for (const key of scoped) {
      if (features[key] === undefined) continue;
      if (!profile || profile.protocol !== "anthropic") {
        notices.push({
          level: "error",
          field: `harnesses.${name}.features.${key}`,
          message:
            "Cannot assign the legacy override to one Anthropic profile. Select that profile and its capability/protocol option explicitly.",
        });
        continue;
      }
      if (key === "effortForAllModels") {
        profile.capabilities = { effort: features[key], ...object(profile.capabilities) };
      } else {
        const options = { ...object(profile.protocolOptions) };
        options.anthropic = { [key]: features[key], ...object(options.anthropic) };
        profile.protocolOptions = options;
      }
      delete features[key];
      notices.push({
        level: "warning",
        field: `harnesses.${name}.features.${key}`,
        message:
          "Moved the override to the selected profile. Other Agents using that profile share its declared capabilities.",
      });
    }
  }
  return { value, notices, changed: JSON.stringify(input) !== JSON.stringify(value) };
}
