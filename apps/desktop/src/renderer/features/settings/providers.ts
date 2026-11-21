/**
 * Model profiles grouped into providers, the way the Models page shows them.
 *
 * Easy Agent stores one flat profile per model under `models`. Profiles in
 * the same file with the same protocol, endpoint, key, and headers form one
 * provider here, matched to a provider template by endpoint, so a key and an
 * endpoint are entered once. Saving writes the file's `models` map back from
 * the providers in that file.
 */

import { secretEnvName } from "../../../shared/contract";
import type { Authentication, ProtocolOptions, ModelCapabilities } from "eagent/sdk";
import type { ConfigSnapshot } from "../../../shared/agent";
import { apiKeyEntry, type KeySource, type ModelEntry, type Protocol, type ProviderConfig, TEMPLATES, templateById } from "../../lib/models";
import { WRITE_SCOPES, type WriteScope } from "../../lib/scopes";
import { scopeValues } from "./agentSettings";

interface RawProfile {
  protocol?: string;
  model?: string;
  baseURL?: string;
  apiKey?: string | { helper: string };
  maxTokens?: number;
  headers?: Record<string, string>;
  authentication?: Authentication;
  protocolOptions?: ProtocolOptions;
  capabilities?: ModelCapabilities;
}

const ENV_REFERENCE = /^\$\{([A-Z0-9_]+)\}$/i;
const trimSlash = (url: string) => url.replace(/\/+$/, "");
const hostname = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "自定义端点";
  }
};

function templateFor(protocol: Protocol, baseURL: string) {
  const url = trimSlash(baseURL);
  return (
    TEMPLATES.find((t) => t.id !== "custom" && t.baseURL && (trimSlash(t.baseURL) === url || t.endpoints?.some((e) => trimSlash(e.baseURL) === url))) ??
    (!url ? TEMPLATES.find((t) => t.protocol === protocol && t.category === "官方") : undefined) ??
    templateById("custom")
  );
}

function keyFrom(apiKey: RawProfile["apiKey"], secrets: Record<string, string>, helper = false): KeySource {
  if (!apiKey) return { kind: "none" };
  if (typeof apiKey === "object") return { kind: "helper", command: apiKey.helper };
  if (helper) return { kind: "helper", command: "[redacted]" };
  const ref = ENV_REFERENCE.exec(apiKey.trim())?.[1];
  if (!ref) return { kind: "inline" };
  const stored = Object.keys(secrets).find((name) => secretEnvName(name) === ref);
  if (stored) return { kind: "keychain", name: stored, masked: secrets[stored]! };
  return { kind: "env", name: ref };
}

/** A safe name for a provider's keychain entry and environment variable. */
export const keyName = (providerId: string) =>
  providerId
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "provider";

export function providersFromConfig(config: ConfigSnapshot, secrets: Record<string, string>): ProviderConfig[] {
  const providers: ProviderConfig[] = [];
  const ids = new Set<string>();
  for (const scope of WRITE_SCOPES) {
    const models = (scopeValues(config, scope).models as Record<string, RawProfile> | undefined) ?? {};
    const groups = new Map<string, ProviderConfig>();
    for (const [handle, raw] of Object.entries(models)) {
      if (!raw || typeof raw !== "object" || !raw.model) continue;
      if (!["anthropic", "openai-chat", "openai-responses", "gemini"].includes(raw.protocol ?? "")) continue;
      const protocol = raw.protocol as Protocol;
      const effective = config.models.profiles[handle];
      const baseURL = raw.baseURL ?? "";
      const headers = Object.entries(raw.headers ?? {}).map(([name, value]) => ({ name, value: String(value) }));
      const groupKey = JSON.stringify([protocol, trimSlash(baseURL), raw.apiKey ?? "", headers, raw.authentication, raw.protocolOptions]);
      let provider = groups.get(groupKey);
      if (!provider) {
        const t = templateFor(protocol, baseURL);
        let id = t.id === "custom" ? `custom-${keyName(hostname(baseURL || "http://custom"))}` : t.id;
        if (scope !== "user") id = `${id}-${scope}`;
        while (ids.has(id)) id = `${id}-2`;
        ids.add(id);
        provider = {
          id,
          templateId: t.id,
          name: t.id === "custom" ? (baseURL ? hostname(baseURL) : "自定义服务商") : t.name,
          icon: t.icon,
          protocol,
          baseURL: baseURL || t.baseURL,
          key: keyFrom(raw.apiKey, secrets, effective?.credentialSource === "helper"),
          enabled: true,
          headers,
          ...(raw.authentication ? { authentication: raw.authentication } : {}),
          ...(raw.protocolOptions ? { protocolOptions: raw.protocolOptions } : {}),
          ...(protocol === "openai-chat" || protocol === "openai-responses" ? { promptCacheKey: raw.protocolOptions?.[protocol]?.promptCacheKey } : {}),
          ...(protocol === "anthropic" ? { countTokens: raw.protocolOptions?.anthropic?.countTokens } : {}),
          models: [],
          scope,
        };
        groups.set(groupKey, provider);
        providers.push(provider);
      }
      const known = templateById(provider.templateId).catalog.find((m) => m.model === raw.model);
      const entry: ModelEntry = {
        handle,
        model: raw.model,
        name: known?.name ?? raw.model,
        contextWindow: effective?.metadata.contextWindow ?? raw.capabilities?.contextWindow ?? 32_000,
        contextWindowSource: effective?.metadata.contextWindowSource ?? (raw.capabilities?.contextWindow ? "profile" : "estimate"),
        maxOutput: raw.maxTokens ?? 0,
        capabilities: {
          tools: effective?.metadata.tools ?? raw.capabilities?.tools ?? true,
          vision: effective?.metadata.vision ?? raw.capabilities?.vision ?? false,
          reasoning: effective?.metadata.reasoning ?? raw.capabilities?.reasoning ?? false,
          cache: effective?.metadata.cache ?? raw.capabilities?.cache ?? false,
        },
        ...(raw.capabilities ? { capabilityOverrides: raw.capabilities } : {}),
        enabled: true,
        ...(effective?.metadata.pricing ? { price: effective.metadata.pricing } : {}),
        ...(effective?.metadata.contextWindowSource === "estimate" ? { note: "上下文窗口为估算；价格未知时不计作零成本" } : {}),
      };
      provider.models.push(entry);
    }
  }
  return providers;
}

/** The `models` map a settings file holds for the providers saved to it. */
export function modelsMapFor(providers: ProviderConfig[], scope: WriteScope): Record<string, RawProfile> {
  const out: Record<string, RawProfile> = {};
  for (const p of providers) {
    if (p.scope !== scope || !p.enabled) continue;
    const apiKey = apiKeyEntry(p.key);
    for (const m of p.models) {
      if (!m.enabled || !m.model.trim()) continue;
      const entry: RawProfile = { protocol: p.protocol, model: m.model.trim() };
      if (p.baseURL.trim()) entry.baseURL = p.baseURL.trim();
      if (apiKey) entry.apiKey = apiKey;
      if (p.key.kind === "helper") entry.apiKey = p.key.command === "[redacted]" ? "[redacted]" : { helper: p.key.command };
      if (p.authentication) entry.authentication = p.authentication;
      if (m.capabilityOverrides) entry.capabilities = m.capabilityOverrides;
      if (m.maxOutput > 0) entry.maxTokens = m.maxOutput;
      const headers = p.headers.filter((h) => h.name.trim());
      if (headers.length) entry.headers = Object.fromEntries(headers.map((h) => [h.name.trim(), h.value]));
      const options = { ...p.protocolOptions };
      if (p.promptCacheKey !== undefined && (p.protocol === "openai-chat" || p.protocol === "openai-responses"))
        options[p.protocol] = { ...options[p.protocol], promptCacheKey: p.promptCacheKey };
      if (p.countTokens !== undefined && p.protocol === "anthropic") options.anthropic = { ...options.anthropic, countTokens: p.countTokens };
      if (Object.keys(options).length) entry.protocolOptions = options;
      out[m.handle] = entry;
    }
  }
  return out;
}

/**
 * Keep each provider's identity across reloads. Grouping is derived from the
 * profiles, so changing a provider's endpoint would otherwise turn it into a
 * different one; a provider that keeps any of its models keeps its id,
 * template, and name.
 */
/** A changed endpoint needs its own credential declaration and protocol metadata. */
export function changeProviderConnection(p: ProviderConfig, protocol: Protocol, baseURL: string): ProviderConfig {
  if (protocol === p.protocol && trimSlash(baseURL) === trimSlash(p.baseURL)) return p;
  const changedProtocol = protocol !== p.protocol;
  return {
    ...p,
    protocol,
    baseURL,
    key: { kind: "none" },
    authentication: p.authentication?.type === "none" ? { type: "none" } : { type: "default" },
    headers: [],
    ...(changedProtocol
      ? {
          protocolOptions: undefined,
          promptCacheKey: undefined,
          countTokens: undefined,
          models: p.models.map((m) => ({
            ...m,
            capabilityOverrides: undefined,
            capabilities: { tools: true, vision: false, reasoning: false, cache: false },
            contextWindow: 32_000,
            contextWindowSource: "estimate",
            maxOutput: 0,
            price: undefined,
          })),
        }
      : {}),
  };
}

export function reconcileProviders(previous: ProviderConfig[], next: ProviderConfig[]): ProviderConfig[] {
  const taken = new Set<string>();
  return next.map((p) => {
    const handles = new Set(p.models.map((m) => m.handle));
    const match = previous.find((old) => old.scope === p.scope && !taken.has(old.id) && old.models.some((m) => handles.has(m.handle)));
    if (!match) return p;
    taken.add(match.id);
    const catalog = templateById(match.templateId).catalog;
    const models = p.models.map((m) => {
      const known = catalog.find((c) => c.model === m.model);
      return known && m.name === m.model ? { ...m, name: known.name } : m;
    });
    return { ...p, id: match.id, templateId: match.templateId, name: match.name, icon: match.icon, models };
  });
}
