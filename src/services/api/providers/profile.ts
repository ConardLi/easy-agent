/**
 * The single connection resolver for generation, counting, search, connection
 * checks and diagnostics. A handle is always a profile ID; credentials belong
 * to that profile and are resolved only against the runtime environment.
 */
import { loadSettingSources, isTrustedScopeForSensitiveKeys, type SettingSource } from "../../../config/sources.js";
import { isProjectTrusted } from "../../../config/globalState.js";
import {
  ModelProfileSchema,
  ENVIRONMENT_PROFILE_ID,
  MODEL_PROTOCOLS,
  profileValidationErrors,
  type ModelProfileConfig,
  type ModelProtocol,
} from "../../../config/modelSchema.js";
import { configurationEnvironment } from "../../../config/environment.js";
import { ConfigurationError, configString, configEnum, resolveEnvironmentReferences } from "../../../config/values.js";
import { resolveApiKeyFromHelper } from "../apiKeyHelper.js";
import { replaceModelMetadata } from "../../../config/modelMetadata.js";
import {
  declaredEnvironmentReferences,
  retiredEnvironmentNotices,
  retiredSettingsNotices,
} from "../../../config/retired.js";
import { harnessFor } from "../../../harness/active.js";

export type { ModelProtocol } from "../../../config/modelSchema.js";
export interface ModelProfile extends Omit<ModelProfileConfig, "apiKey"> {
  id: string;
  apiKey?: string;
  /** Internal source, never written to a transcript. Executed only for an actual connection. */
  apiKeyHelper?: string;
}

/** Reserved stable ID for the explicitly configured temporary connection. */
export { ENVIRONMENT_PROFILE_ID };
export const DEFAULT_PROVIDER_BASE_URLS: Readonly<Record<ModelProtocol, string>> = {
  anthropic: "https://api.anthropic.com",
  "openai-chat": "https://api.openai.com/v1",
  "openai-responses": "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
};

export function getProfileBaseURL(profile: ModelProfile): string {
  const base = (profile.baseURL ?? DEFAULT_PROVIDER_BASE_URLS[profile.protocol]).replace(/\/+$/, "");
  return profile.protocol === "anthropic" ? base.replace(/\/v1$/i, "") : base;
}

export interface LoadedProfiles {
  profiles: Record<string, ModelProfile>;
  /** Effective selection. The persisted field is settings.model. */
  defaultModel?: string;
  warnings: string[];
  provenance: Record<string, Partial<Record<keyof ModelProfileConfig, SettingSource>>>;
  defaultModelSource?: SettingSource;
  errors?: Record<string, string[]>;
  /** Blocks model use while keeping configuration inspection and manual migration available. */
  configurationErrors?: string[];
}

/** No helper execution: this path is safe for configuration editors and first launch. */
export async function loadProfiles(cwd: string = process.cwd()): Promise<LoadedProfiles> {
  const sources = await loadSettingSources(cwd);
  const workspaceTrusted = await isProjectTrusted(cwd);
  const merged: Record<string, Record<string, unknown>> = {};
  const provenance: LoadedProfiles["provenance"] = {};
  const warnings: string[] = [];
  const errors: Record<string, string[]> = {};
  let defaultModel: string | undefined;
  let defaultModelSource: SettingSource | undefined;
  let environmentAdded = false;
  const env = configurationEnvironment();
  const trustedSources = sources.filter((source) => isTrustedScopeForSensitiveKeys(source.source) || workspaceTrusted);
  const references = declaredEnvironmentReferences(trustedSources.map((source) => source.raw));
  const configurationErrors = [
    ...retiredEnvironmentNotices(env, references).map((notice) => `environment: ${notice.message}`),
    ...trustedSources.flatMap((source) => [
      ...(source.migrationNotices ?? retiredSettingsNotices(source.raw, references)).map(
        (notice) => `${source.path ?? source.source}: ${notice.message}`,
      ),
      ...(source.validationErrors ?? []).filter((error) => error.includes("environment.connection:")),
    ]),
  ];
  warnings.push(...configurationErrors);
  const selectEnvironment = () => {
    if (environmentAdded) return;
    environmentAdded = true;
    const profileId = configString(env.EASY_AGENT_PROFILE);
    const hasTarget = ["EASY_AGENT_PROTOCOL", "EASY_AGENT_MODEL", "EASY_AGENT_BASE_URL"].some(
      (key) => configString(env[key]) !== undefined,
    );
    if (profileId && hasTarget) {
      errors[ENVIRONMENT_PROFILE_ID] = [
        "environment.connection: choose EASY_AGENT_PROFILE or EASY_AGENT_PROTOCOL/EASY_AGENT_MODEL, not both.",
      ];
      defaultModel = ENVIRONMENT_PROFILE_ID;
      defaultModelSource = undefined;
      return;
    }
    if (profileId) {
      defaultModel = profileId;
      defaultModelSource = undefined;
    } else if (hasTarget) {
      defaultModel = ENVIRONMENT_PROFILE_ID;
      defaultModelSource = undefined;
      try {
        const protocol = configEnum(env.EASY_AGENT_PROTOCOL, "EASY_AGENT_PROTOCOL", MODEL_PROTOCOLS);
        const model = configString(env.EASY_AGENT_MODEL);
        if (!protocol || !model) {
          throw new ConfigurationError(
            "environment.connection",
            "provide both EASY_AGENT_PROTOCOL and EASY_AGENT_MODEL.",
          );
        }
        const id = ENVIRONMENT_PROFILE_ID;
        const selected = {
          protocol,
          model,
          ...(configString(env.EASY_AGENT_BASE_URL) ? { baseURL: configString(env.EASY_AGENT_BASE_URL) } : {}),
          ...(configString(env.EASY_AGENT_API_KEY) ? { apiKey: "${EASY_AGENT_API_KEY}" } : {}),
        };
        if (merged[id])
          throw new ConfigurationError("models", `${ENVIRONMENT_PROFILE_ID} is reserved for environment connections.`);
        merged[id] = selected;
        defaultModel = id;
      } catch (error) {
        errors[ENVIRONMENT_PROFILE_ID] = [safeConfigurationMessage(error)];
      }
    }
  };

  for (const src of sources) {
    if (src.source === "flag") selectEnvironment();
    if (!src.raw) continue;
    const trusted = isTrustedScopeForSensitiveKeys(src.source) || workspaceTrusted;
    if (!trusted) {
      if (src.raw.models) warnings.push(`models: "${src.source}" profiles ignored until the workspace is trusted.`);
      continue;
    }
    const models = src.raw.models;
    if (models && typeof models === "object" && !Array.isArray(models)) {
      for (const [id, value] of Object.entries(models)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          errors[id] = [`models.${id}: expected a model profile object.`];
          continue;
        }
        const raw = value as Record<string, unknown>;
        const previous = merged[id];
        const targetChanged =
          previous &&
          ((raw.protocol !== undefined && raw.protocol !== previous.protocol) ||
            (raw.baseURL !== undefined && raw.baseURL !== previous.baseURL));
        if (
          targetChanged &&
          raw.apiKey === undefined &&
          (raw.authentication as { type?: string } | undefined)?.type !== "none"
        ) {
          errors[id] = [
            `models.${id} (${src.source}): changing protocol or baseURL requires an explicit API Key source or authentication.type=none.`,
          ];
          continue;
        }
        // Target changes discard connection-specific state, even when a new
        // API Key was explicitly supplied. A protocol also owns its metadata.
        const inherited = { ...previous };
        const fieldSources = (provenance[id] ??= {});
        if (targetChanged) {
          for (const key of ["apiKey", "authentication", "headers"] as const) {
            delete inherited[key];
            delete fieldSources[key];
          }
          if (raw.protocol !== undefined && raw.protocol !== previous?.protocol) {
            for (const key of ["protocolOptions", "capabilities", "baseURL", "maxTokens"] as const) {
              delete inherited[key];
              delete fieldSources[key];
            }
          }
        }
        merged[id] = { ...inherited, ...raw };
        delete errors[id];
        for (const key of Object.keys(raw) as (keyof ModelProfileConfig)[]) fieldSources[key] = src.source;
      }
    }
    const selection = src.raw.model;
    if (typeof selection === "string" && selection.trim()) {
      defaultModel = selection.trim();
      defaultModelSource = src.source;
    }
  }
  selectEnvironment();

  const profiles: Record<string, ModelProfile> = {};
  for (const [id, raw] of Object.entries(merged)) {
    if (errors[id]) continue;
    const issues = profileValidationErrors(raw, `models.${id}`);
    if (issues.length) {
      errors[id] = issues;
      continue;
    }
    const config = ModelProfileSchema.parse(raw);
    try {
      const { apiKey, ...rest } = config;
      const profile: ModelProfile = { id, ...rest };
      if (profile.baseURL) {
        profile.baseURL = resolveEnvironmentReferences(profile.baseURL, env, `models.${id}.baseURL`);
        let url: URL;
        try {
          url = new URL(profile.baseURL);
        } catch {
          throw new ConfigurationError(`models.${id}.baseURL`, "provide an absolute HTTP or HTTPS service URL.");
        }
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
          throw new ConfigurationError(
            `models.${id}.baseURL`,
            "use an HTTP(S) URL without credentials, query or fragment; configure authentication separately.",
          );
        }
      }
      if (typeof apiKey === "string") profile.apiKey = resolveEnvironmentReferences(apiKey, env, `models.${id}.apiKey`);
      else if (apiKey) profile.apiKeyHelper = apiKey.helper;
      if (profile.headers) {
        profile.headers = Object.fromEntries(
          Object.entries(profile.headers).map(([name, value]) => [
            name,
            resolveEnvironmentReferences(value, env, `models.${id}.headers`),
          ]),
        );
      }
      profiles[id] = profile;
    } catch (error) {
      errors[id] = [safeConfigurationMessage(error)];
    }
  }
  if (!defaultModel && Object.keys(profiles).length === 1) defaultModel = Object.keys(profiles)[0];
  replaceModelMetadata(profiles);
  return {
    profiles,
    defaultModel,
    warnings,
    provenance,
    errors,
    configurationErrors,
    ...(defaultModelSource ? { defaultModelSource } : {}),
  };
}

function safeConfigurationMessage(error: unknown): string {
  return error instanceof ConfigurationError
    ? error.message
    : "Invalid connection configuration; check the profile fields.";
}

/** Select a stable ID without requiring a key or running a helper. */
export async function resolveProfileId(handle: string | undefined, cwd = process.cwd()): Promise<string> {
  const loaded = await loadProfiles(cwd);
  return selectedProfileId(loaded, handle);
}

function selectedProfileId(loaded: LoadedProfiles, handle: string | undefined): string {
  if (loaded.configurationErrors?.length)
    throw new ConfigurationError("configuration", loaded.configurationErrors.join(" "));
  const id = configString(handle) ?? loaded.defaultModel;
  if (!id) {
    throw new ConfigurationError(
      "model",
      Object.keys(loaded.profiles).length > 1
        ? "multiple profiles are available; choose a profile ID with model or --model."
        : "no model profile is configured; add a profile with protocol, model and an API Key source.",
    );
  }
  if (loaded.errors?.[id]?.length) throw new ConfigurationError(`models.${id}`, loaded.errors[id]!.join(" "));
  if (!loaded.profiles[id])
    throw new ConfigurationError("model", `profile "${id}" does not exist; select a saved profile ID.`);
  return id;
}

export async function resolveProfile(handle: string, cwd: string = process.cwd()): Promise<ModelProfile> {
  const profile = await resolveProfileConfiguration(handle, cwd);
  if (profile.apiKeyHelper) {
    profile.apiKey = await resolveApiKeyFromHelper(cwd, profile.apiKeyHelper, profile.id, configurationEnvironment());
  }
  return profile;
}

/** Display and context preview resolve identical targets without executing credentials helpers. */
export async function resolveProfileConfiguration(handle: string, cwd = process.cwd()): Promise<ModelProfile> {
  const retired = (await harnessFor(cwd)).issues.filter((issue) => issue.retired);
  if (retired.length) throw new ConfigurationError("configuration", retired.map((issue) => issue.message).join(" "));
  const loaded = await loadProfiles(cwd);
  return structuredClone(loaded.profiles[selectedProfileId(loaded, handle)]!);
}
