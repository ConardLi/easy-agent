/**
 * Settings, workspace trust, and model connections for frontends that edit
 * them (`AgentRuntime.readConfig()` and friends).
 *
 * Reads go through the same layered sources the runtime uses, so the values,
 * their provenance, and the trust rules match what a session sees. Writes go
 * through the same validated, locked, atomic writers as `/config set`.
 * Credentials never leave in clear text: inline secrets are replaced by
 * `[redacted]`, while `${VAR}` references are shown as written. A write that
 * sends `[redacted]` back keeps the value already stored in that file.
 */

import { SETTING_DEFAULTS, SETTING_RELOAD } from "../config/catalog.js";
import { isProjectTrusted, trustProject, untrustProject } from "../config/globalState.js";
import { isSensitiveSettingKey, REDACTED, redactUrlForDisplay } from "../config/redaction.js";
import { SettingsSchema, validateSettings } from "../config/schema.js";
import { isTrustedScopeForSensitiveKeys, loadSettingSources, type SettingSource } from "../config/sources.js";
import { getAnthropicClientForProfile } from "../services/api/client.js";
import {
  DEFAULT_PROVIDER_BASE_URLS,
  getProfileBaseURL,
  loadProfiles,
  type ModelProfile,
  resolveProfile,
} from "../services/api/providers/profile.js";
import { collectViaProvider } from "../services/api/providers/providerStream.js";
import { updateLocalSettings, updateProjectSettings, updateUserSettings } from "../utils/settings.js";
import { AgentSdkError } from "./errors.js";
import type {
  ConfigScope,
  ConfigSnapshot,
  ConfigSourceInfo,
  EffectiveSetting,
  ModelCheckResult,
  ModelProfileInfo,
} from "./types.js";

/** Keys only a user-level (or flag/policy) source may set; project files cannot escalate them. */
const USER_ONLY_KEYS = new Set(["mode", "autoMode"]);
/** Keys whose values merge across sources instead of the last one winning. */
const ARRAY_KEYS = new Set([
  "allow",
  "deny",
  "ask",
  "additionalDirectories",
  "claudeMdExcludes",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
]);
const OBJECT_KEYS = new Set(["env", "enabledPlugins", "mcpServers", "modelRoles"]);
const ENV_REFERENCE = /^\$\{[A-Z0-9_]+\}$/i;
const REQUEST_TIMEOUT_MS = 20_000;

/** A display-safe copy: inline secrets become `[redacted]`, `${VAR}` references stay. */
function displayValue(value: unknown, key = ""): unknown {
  const normalized = key.toLowerCase();
  if (typeof value === "string") {
    if (ENV_REFERENCE.test(value.trim())) return value;
    if (isSensitiveSettingKey(key)) return REDACTED;
    if (normalized.endsWith("url")) return /\/\/[^/]*@|\?/.test(value) ? redactUrlForDisplay(value) : value;
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => displayValue(item));
  if (value && typeof value === "object") {
    const secretValues = normalized === "env" || normalized === "headers";
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([child, v]) => [
        child,
        secretValues && typeof v === "string" && !ENV_REFERENCE.test(v.trim()) ? REDACTED : displayValue(v, child),
      ]),
    );
  }
  return value;
}

/** Put stored values back wherever an edited value still says `[redacted]`. */
function restoreRedacted(next: unknown, stored: unknown, path: string): unknown {
  if (next === REDACTED) {
    if (stored === undefined || stored === REDACTED)
      throw new AgentSdkError("invalid_argument", `${path} has no stored value to keep; send the value itself.`);
    return stored;
  }
  if (Array.isArray(next))
    return next.map((item, i) => restoreRedacted(item, Array.isArray(stored) ? stored[i] : undefined, `${path}[${i}]`));
  if (next && typeof next === "object") {
    const base =
      stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
    return Object.fromEntries(
      Object.entries(next as Record<string, unknown>).map(([k, v]) => [k, restoreRedacted(v, base[k], `${path}.${k}`)]),
    );
  }
  return next;
}

const knownKey = (key: string) => Object.hasOwn(SettingsSchema.shape, key) || key === "sandbox";

/** Every settings source with its display-safe values, the effective value of each key, and the model profiles. */
export async function readConfig(cwd: string): Promise<ConfigSnapshot> {
  const [sources, workspaceTrusted, profiles] = await Promise.all([
    loadSettingSources(cwd),
    isProjectTrusted(cwd),
    loadProfiles(cwd),
  ]);
  const applies = (source: SettingSource, key: string) =>
    isTrustedScopeForSensitiveKeys(source) || (workspaceTrusted && !USER_ONLY_KEYS.has(key));

  const info: ConfigSourceInfo[] = sources.map((src) => ({
    source: src.source,
    path: src.path,
    exists: src.raw !== null || src.parseError !== undefined,
    applied: isTrustedScopeForSensitiveKeys(src.source) || workspaceTrusted,
    values: src.raw ? (displayValue(src.raw) as Record<string, unknown>) : {},
    ...(src.parseError ? { parseError: src.parseError } : {}),
    ...(src.validationErrors?.length ? { validationErrors: src.validationErrors } : {}),
  }));

  const keys = new Set([...Object.keys(SettingsSchema.shape), "sandbox"]);
  for (const src of sources) for (const key of Object.keys(src.raw ?? {})) keys.add(key);
  const effective: Record<string, EffectiveSetting> = {};
  for (const key of [...keys].sort()) {
    const defining = sources.filter((src) => src.raw?.[key] !== undefined && applies(src.source, key));
    const reload = SETTING_RELOAD[key] ?? "restart";
    if (defining.length === 0) {
      if (SETTING_DEFAULTS[key] !== undefined)
        effective[key] = { value: SETTING_DEFAULTS[key], source: "default", sources: [], reload };
      continue;
    }
    const raws = defining.map((src) => src.raw![key]);
    let value: unknown = raws[raws.length - 1];
    if (ARRAY_KEYS.has(key) && raws.every(Array.isArray))
      value = [...new Set(raws.flat().map((item) => JSON.stringify(item)))].map((item) => JSON.parse(item));
    else if (OBJECT_KEYS.has(key) && raws.every((raw) => raw && typeof raw === "object" && !Array.isArray(raw)))
      value = Object.assign({}, ...raws);
    effective[key] = {
      value: displayValue(value, key),
      source: defining[defining.length - 1]!.source,
      sources: defining.map((src) => src.source),
      reload,
    };
  }

  const models: Record<string, ModelProfileInfo> = {};
  for (const [id, profile] of Object.entries(profiles.profiles)) {
    const fields = profiles.provenance[id] ?? {};
    const stored = storedProfile(sources, id);
    models[id] = {
      protocol: profile.protocol,
      model: profile.model,
      baseURL: getProfileBaseURL(profile),
      apiKey: typeof stored?.apiKey === "string" ? (displayValue(stored.apiKey, "apiKey") as string) : null,
      hasApiKey: Boolean(profile.apiKey),
      headers: Object.keys(profile.headers ?? {}),
      ...(profile.maxTokens ? { maxTokens: profile.maxTokens } : {}),
      source: fields.model ?? fields.protocol ?? "user",
    };
  }

  return {
    workspaceTrusted,
    sources: info,
    effective,
    models: {
      profiles: models,
      defaultModel: profiles.defaultModel ?? null,
      warnings: profiles.warnings,
    },
    userOnlyKeys: [...USER_ONLY_KEYS],
  };
}

/** The raw `models.<id>` entry from the highest source that defines it. */
function storedProfile(
  sources: Awaited<ReturnType<typeof loadSettingSources>>,
  id: string,
): Record<string, unknown> | undefined {
  for (const src of [...sources].reverse()) {
    const models = src.raw?.models as Record<string, Record<string, unknown>> | undefined;
    if (models?.[id]) return models[id];
  }
  return undefined;
}

/**
 * Set one top-level key in a settings file, or delete it with `null`. The
 * value is validated against the settings schema first; nothing is written
 * when it does not pass. Returns when the change takes effect.
 */
export async function writeConfig(
  cwd: string,
  scope: ConfigScope,
  key: string,
  value: unknown,
): Promise<{ reload: string }> {
  if (!knownKey(key)) throw new AgentSdkError("invalid_argument", `Unknown setting "${key}".`);
  if (scope !== "user" && USER_ONLY_KEYS.has(key))
    throw new AgentSdkError(
      "invalid_argument",
      `"${key}" is only read from user settings; a ${scope} file cannot set it.`,
    );
  let next = value;
  if (value !== null) {
    const sources = await loadSettingSources(cwd);
    const stored = sources.find((src) => src.source === scope)?.raw?.[key];
    next = restoreRedacted(value, stored, key);
    const { errors } = validateSettings({ [key]: next }, scope);
    if (errors.length) throw new AgentSdkError("invalid_argument", errors.join("; "));
  }
  const patch = { [key]: next === null ? undefined : next };
  if (scope === "project") await updateProjectSettings(cwd, patch);
  else if (scope === "local") await updateLocalSettings(cwd, patch);
  else await updateUserSettings(patch);
  return { reload: SETTING_RELOAD[key] ?? "restart" };
}

/** Save or revoke trust for the workspace. Bootstrap reads it, so it applies to the next runtime. */
export async function setWorkspaceTrust(cwd: string, trusted: boolean): Promise<{ trusted: boolean }> {
  if (trusted) await trustProject(cwd);
  else await untrustProject(cwd);
  return { trusted: await isProjectTrusted(cwd) };
}

/** An error message with the profile's credentials taken out. */
function safeError(error: unknown, profile: ModelProfile): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [profile.apiKey, ...Object.values(profile.headers ?? {})]) {
    if (secret && secret.length >= 6) message = message.split(secret).join(REDACTED);
  }
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

/** Send the smallest possible request with a model handle (profile id or raw model name). */
export async function checkModel(cwd: string, handle: string): Promise<ModelCheckResult> {
  const profile = await resolveProfile(handle, cwd);
  const started = Date.now();
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    const messages = [{ role: "user" as const, content: "ping" }];
    if (profile.protocol === "anthropic") {
      const stream = await getAnthropicClientForProfile(profile).messages.create(
        { model: profile.model, max_tokens: 1, messages, stream: true },
        { signal, maxRetries: 0 },
      );
      for await (const _event of stream) {
        // Drain: an error surfaces here; reaching the end means the request was accepted.
      }
    } else {
      await collectViaProvider(profile, { model: profile.model, maxTokens: 1, messages, signal });
    }
    return { ok: true, protocol: profile.protocol, model: profile.model, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      protocol: profile.protocol,
      model: profile.model,
      latencyMs: Date.now() - started,
      error: safeError(error, profile),
    };
  }
}

/** Model ids the provider behind a handle offers, from its model-list endpoint. */
export async function listModels(cwd: string, handle: string): Promise<{ models: string[] }> {
  const profile = await resolveProfile(handle, cwd);
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    if (profile.protocol === "anthropic") {
      const ids: string[] = [];
      for await (const model of getAnthropicClientForProfile(profile).models.list(
        { limit: 100 },
        { signal, maxRetries: 0 },
      ))
        ids.push(model.id);
      return { models: ids };
    }
    const base = (profile.baseURL ?? DEFAULT_PROVIDER_BASE_URLS[profile.protocol]).replace(/\/+$/, "");
    const headers: Record<string, string> = { ...(profile.headers ?? {}) };
    if (profile.protocol === "gemini") {
      if (profile.apiKey) headers["x-goog-api-key"] = profile.apiKey;
      const response = await fetch(`${base}/models?pageSize=1000`, { headers, signal });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const body = (await response.json()) as { models?: { name?: string; supportedGenerationMethods?: string[] }[] };
      return {
        models: (body.models ?? [])
          .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"))
          .map((m) => String(m.name ?? "").replace(/^models\//, ""))
          .filter(Boolean),
      };
    }
    if (profile.apiKey) headers.authorization = `Bearer ${profile.apiKey}`;
    const response = await fetch(`${base}/models`, { headers, signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const body = (await response.json()) as { data?: { id?: string }[] };
    return { models: (body.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean) };
  } catch (error) {
    throw new AgentSdkError("provider", `Could not list models: ${safeError(error, profile)}`);
  }
}
