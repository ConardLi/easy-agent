/**
 * Model profiles — resolves a user-facing "model handle" into a concrete
 * provider target (protocol + model + endpoint + credentials).
 *
 * A profile is declared in settings.json under `models`:
 *
 *   {
 *     "models": {
 *       "gpt5":   { "protocol": "openai-chat", "model": "gpt-5.1",
 *                   "baseURL": "https://api.openai.com/v1", "apiKey": "${OPENAI_API_KEY}" },
 *       "gemini": { "protocol": "gemini", "model": "gemini-2.5-pro",
 *                   "apiKey": "${GEMINI_API_KEY}" }
 *     },
 *     "defaultModel": "gpt5"
 *   }
 *
 * The profile *id* (the map key) is the handle the rest of the system passes
 * around — `--model gpt5`, `/model gpt5`, etc. When a handle does not match any
 * declared profile it is treated as a raw Anthropic model name (backwards
 * compatible: `--model claude-sonnet-4-...` still works with no `models` block).
 *
 * Translation to OpenAI / Gemini happens entirely at the edge (see
 * providerStream.ts via the zero-dependency `llm-bridge` library). The upper
 * stack never learns a profile is non-Anthropic — it keeps speaking the
 * normalized StreamEvent contract.
 *
 * Provider selection, endpoints, credentials, and headers from project/local
 * settings are ignored until workspace trust has been established.
 */

import {
  loadSettingSources,
  isTrustedScopeForSensitiveKeys,
  type SettingSource,
} from "../../../config/sources.js";
import { isProjectTrusted } from "../../../config/globalState.js";

export type ModelProtocol =
  | "anthropic"
  | "openai-chat"
  | "openai-responses"
  | "gemini";

export interface ModelProfile {
  /** The map key / user-facing handle. */
  id: string;
  protocol: ModelProtocol;
  /** The model name sent to the upstream provider. */
  model: string;
  /** Override the provider base URL (else a protocol default is used). */
  baseURL?: string;
  /** Resolved API key (after `${ENV}` interpolation). */
  apiKey?: string;
  /** Per-profile max output tokens override. */
  maxTokens?: number;
  /** Extra HTTP headers merged into the upstream request. */
  headers?: Record<string, string>;
}

interface RawProfile {
  protocol?: unknown;
  model?: unknown;
  baseURL?: unknown;
  apiKey?: unknown;
  maxTokens?: unknown;
  headers?: unknown;
}

const VALID_PROTOCOLS: ReadonlySet<string> = new Set<ModelProtocol>([
  "anthropic",
  "openai-chat",
  "openai-responses",
  "gemini",
]);

/** `${VAR}` → process.env.VAR (missing vars collapse to empty string). */
function interpolateEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name) => process.env[name] ?? "");
}

export interface LoadedProfiles {
  profiles: Record<string, ModelProfile>;
  defaultModel?: string;
  /** Non-fatal notices (dropped inline secrets, malformed entries). */
  warnings: string[];
  /** Effective source for each merged profile field. Contains no values. */
  provenance: Record<string, Partial<Record<keyof RawProfile, SettingSource>>>;
  defaultModelSource?: SettingSource;
}

/**
 * Merge the `models` map (and `defaultModel`) across every settings source in
 * priority order, sanitizing privilege-sensitive fields from untrusted scopes.
 */
export async function loadProfiles(cwd: string = process.cwd()): Promise<LoadedProfiles> {
  const sources = await loadSettingSources(cwd);
  const merged: Record<string, RawProfile> = {};
  const provenance: LoadedProfiles["provenance"] = {};
  const warnings: string[] = [];
  let defaultModel: string | undefined;
  let defaultModelSource: SettingSource | undefined;
  const workspaceTrusted = await isProjectTrusted(cwd);

  for (const src of sources) {
    if (!src.raw) continue;
    const trusted = isTrustedScopeForSensitiveKeys(src.source) || workspaceTrusted;

    const models = src.raw.models;
    if (models && typeof models === "object" && !Array.isArray(models)) {
      for (const [id, value] of Object.entries(models as Record<string, unknown>)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const raw: RawProfile = { ...(value as RawProfile) };

        if (!trusted) {
          warnings.push(
            `models.${id}: profile from "${src.source}" scope ignored until the workspace is trusted`,
          );
          continue;
        }

        merged[id] = { ...merged[id], ...raw };
        const fieldSources = (provenance[id] ??= {});
        for (const key of Object.keys(raw) as (keyof RawProfile)[]) {
          fieldSources[key] = src.source;
        }
      }
    }

    const dm = src.raw.defaultModel;
    if (trusted && typeof dm === "string" && dm.trim().length > 0) {
      defaultModel = dm.trim();
      defaultModelSource = src.source;
    }
  }

  const profiles: Record<string, ModelProfile> = {};
  for (const [id, raw] of Object.entries(merged)) {
    const built = buildProfile(id, raw, warnings);
    if (built) profiles[id] = built;
  }

  return {
    profiles,
    defaultModel,
    warnings,
    provenance,
    ...(defaultModelSource ? { defaultModelSource } : {}),
  };
}

function buildProfile(
  id: string,
  raw: RawProfile,
  warnings: string[],
): ModelProfile | null {
  const protocol = typeof raw.protocol === "string" ? raw.protocol.trim() : "";
  const model = typeof raw.model === "string" ? raw.model.trim() : "";

  if (!VALID_PROTOCOLS.has(protocol)) {
    warnings.push(
      `models.${id}: unknown or missing protocol "${protocol}" — ignored (expected anthropic | openai-chat | openai-responses | gemini)`,
    );
    return null;
  }
  if (!model) {
    warnings.push(`models.${id}: missing "model" — ignored`);
    return null;
  }

  const profile: ModelProfile = { id, protocol: protocol as ModelProtocol, model };

  if (typeof raw.baseURL === "string" && raw.baseURL.trim()) {
    profile.baseURL = interpolateEnv(raw.baseURL.trim());
  }
  if (typeof raw.apiKey === "string" && raw.apiKey.trim()) {
    const key = interpolateEnv(raw.apiKey.trim());
    if (key) profile.apiKey = key;
  }
  if (typeof raw.maxTokens === "number" && Number.isFinite(raw.maxTokens) && raw.maxTokens > 0) {
    profile.maxTokens = raw.maxTokens;
  }
  if (raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.headers as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = interpolateEnv(v);
    }
    if (Object.keys(out).length > 0) profile.headers = out;
  }

  return profile;
}

/**
 * Resolve a model handle into a concrete profile.
 *
 * - A handle matching a declared profile id → that profile.
 * - Anything else → a synthetic Anthropic profile whose `model` is the handle
 *   verbatim (legacy / direct-model behavior, env-configured client).
 */
export async function resolveProfile(
  handle: string,
  cwd: string = process.cwd(),
): Promise<ModelProfile> {
  const { profiles } = await loadProfiles(cwd);
  const declared = profiles[handle];
  if (declared) return declared;
  return { id: handle, protocol: "anthropic", model: handle };
}
