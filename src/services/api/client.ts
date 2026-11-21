/** Anthropic transport. Connection and authentication are supplied by the shared resolver. */
import Anthropic from "@anthropic-ai/sdk";
import { harnessSetting } from "../../harness/active.js";
import { defineRuntimeState } from "../../state/runtimeScope.js";
import { USER_AGENT } from "../../version.js";
import { getProfileBaseURL, resolveProfile, type ModelProfile } from "./providers/profile.js";
import { profileRequestHeaders } from "./providers/authentication.js";

export function getDefaultModel(): string {
  return harnessSetting<string | undefined>("model.main") ?? "";
}
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000;
export const ESCALATED_MAX_TOKENS = 64_000;
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000;
export const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;
export const DEFAULT_MAX_TOKENS = CAPPED_DEFAULT_MAX_TOKENS;
export const CUSTOM_ENDPOINT_USER_AGENT = USER_AGENT;

const state = defineRuntimeState(
  "profileClients",
  () => new Map<string, Anthropic>(),
  (cache) => cache.clear(),
);

export function normalizeAnthropicBaseURL(baseURL: string): string {
  return baseURL.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

export function getAnthropicClientForProfile(profile: ModelProfile): Anthropic {
  const baseURL = getProfileBaseURL(profile);
  const headers = profileRequestHeaders(profile);
  const defaultHeaders = {
    "user-agent": CUSTOM_ENDPOINT_USER_AGENT,
    // Null removes SDK-generated headers. An explicitly empty apiKey below
    // also prevents its ambient credential-provider chain from starting.
    "x-api-key": null,
    authorization: null,
    ...headers,
  };
  const key = JSON.stringify([baseURL, Object.entries(defaultHeaders).sort(([a], [b]) => a.localeCompare(b))]);
  const cache = state();
  const existing = cache.get(key);
  if (existing) return existing;
  const client = new Anthropic({
    apiKey: "",
    authToken: null,
    webhookKey: null,
    baseURL,
    defaultHeaders,
    // All request paths use the shared retry policy.
    maxRetries: 0,
  });
  // Bound retained credentials after helper refreshes.
  if (cache.size >= 16) cache.delete(cache.keys().next().value!);
  cache.set(key, client);
  return client;
}

export async function verifyApiKey(handle?: string): Promise<boolean> {
  try {
    const profile = await resolveProfile(handle ?? getDefaultModel());
    if (profile.protocol !== "anthropic") return false;
    await getAnthropicClientForProfile(profile).messages.create({
      model: profile.model,
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });
    return true;
  } catch {
    return false;
  }
}

export function resetClient(): void {
  state().clear();
}
