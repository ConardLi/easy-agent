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
import type { ConfigSnapshot } from "../../../shared/agent";
import { apiKeyEntry, type KeySource, type ModelEntry, type Protocol, type ProviderConfig, TEMPLATES, templateById } from "../../lib/models";
import { WRITE_SCOPES, type WriteScope } from "../../lib/scopes";
import { scopeValues } from "./agentSettings";

interface RawProfile {
  protocol?: string;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  maxTokens?: number;
  headers?: Record<string, string>;
  promptCacheKey?: boolean;
}

const ENV_REFERENCE = /^\$\{([A-Z0-9_]+)\}$/i;
const trimSlash = (url: string) => url.replace(/\/+$/, "");

function templateFor(protocol: Protocol, baseURL: string) {
  const url = trimSlash(baseURL);
  return (
    TEMPLATES.find((t) => t.id !== "custom" && t.baseURL && (trimSlash(t.baseURL) === url || t.endpoints?.some((e) => trimSlash(e.baseURL) === url))) ??
    (!url ? TEMPLATES.find((t) => t.protocol === protocol && t.category === "官方") : undefined) ??
    templateById("custom")
  );
}

function keyFrom(apiKey: string | undefined, secrets: Record<string, string>): KeySource {
  if (!apiKey) return { kind: "none" };
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
      const protocol = (raw.protocol ?? "anthropic") as Protocol;
      const baseURL = raw.baseURL ?? "";
      const headers = Object.entries(raw.headers ?? {}).map(([name, value]) => ({ name, value: String(value) }));
      const groupKey = JSON.stringify([protocol, trimSlash(baseURL), raw.apiKey ?? "", headers, raw.promptCacheKey]);
      let provider = groups.get(groupKey);
      if (!provider) {
        const t = templateFor(protocol, baseURL);
        let id = t.id === "custom" ? `custom-${keyName(new URL(baseURL || "http://custom").hostname)}` : t.id;
        if (scope !== "user") id = `${id}-${scope}`;
        while (ids.has(id)) id = `${id}-2`;
        ids.add(id);
        provider = {
          id,
          templateId: t.id,
          name: t.id === "custom" ? (baseURL ? new URL(baseURL).hostname : "自定义服务商") : t.name,
          icon: t.icon,
          protocol,
          baseURL: baseURL || t.baseURL,
          key: keyFrom(raw.apiKey, secrets),
          enabled: true,
          headers,
          ...(raw.promptCacheKey !== undefined ? { promptCacheKey: raw.promptCacheKey } : {}),
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
        contextWindow: known?.contextWindow ?? 128_000,
        maxOutput: raw.maxTokens ?? 0,
        capabilities: known?.capabilities ?? { tools: true, vision: false, reasoning: false, cache: false },
        enabled: true,
        ...(known?.price ? { price: known.price } : {}),
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
      if (m.maxOutput > 0) entry.maxTokens = m.maxOutput;
      const headers = p.headers.filter((h) => h.name.trim());
      if (headers.length) entry.headers = Object.fromEntries(headers.map((h) => [h.name.trim(), h.value]));
      if (p.promptCacheKey !== undefined && p.protocol.startsWith("openai")) entry.promptCacheKey = p.promptCacheKey;
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
      return known && m.name === m.model ? { ...m, name: known.name, contextWindow: known.contextWindow, capabilities: known.capabilities } : m;
    });
    return { ...p, id: match.id, templateId: match.templateId, name: match.name, icon: match.icon, models };
  });
}
