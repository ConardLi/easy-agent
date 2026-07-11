/**
 * API Client — Creates and manages the Anthropic API client instance.
 *
 * Mirrors the pattern in claude-code-source-code/src/services/api/client.ts:
 * - Reads API key from environment
 * - Configurable model and max tokens
 * - Single shared client instance (lazy init)
 *
 * We keep this intentionally simple — no Bedrock/Vertex/OAuth,
 * just direct Anthropic API via SDK.
 */

import Anthropic from "@anthropic-ai/sdk";

// ─── Default Configuration ─────────────────────────────────────────

export const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000;
export const ESCALATED_MAX_TOKENS = 64_000;
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000;
export const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;
export const DEFAULT_MAX_TOKENS = CAPPED_DEFAULT_MAX_TOKENS;

// ─── Client Singleton ──────────────────────────────────────────────

let clientInstance: Anthropic | null = null;

/**
 * Get or create the Anthropic client instance.
 *
 * The SDK automatically reads `ANTHROPIC_AUTH_TOKEN` from the environment.
 * Optionally pass `apiKey` to override.
 */
export function getAnthropicClient(options?: {
  apiKey?: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
}): Anthropic {
  if (clientInstance && !options) {
    return clientInstance;
  }

  const client = new Anthropic({
    apiKey: options?.apiKey ?? process.env.ANTHROPIC_AUTH_TOKEN,
    baseURL: options?.baseURL ?? process.env.ANTHROPIC_BASE_URL,
    ...(options?.defaultHeaders ? { defaultHeaders: options.defaultHeaders } : {}),
  });

  if (!options) {
    clientInstance = client;
  }

  return client;
}

// ─── Per-profile clients ───────────────────────────────────────────
//
// Stage 30: an Anthropic-protocol model profile may carry its own baseURL /
// apiKey (e.g. a self-hosted Anthropic-compatible gateway). Build (and cache)
// a dedicated client per distinct baseURL|apiKey so we don't re-instantiate on
// every request. Profiles with neither override fall back to the env singleton.

const profileClientCache = new Map<string, Anthropic>();

/**
 * Custom gateways should see Easy Agent as the caller, rather than inheriting
 * the Anthropic SDK's `Anthropic/JS ...` user agent. Some compatible gateways
 * route or block traffic based on that SDK-specific fingerprint even though
 * they accept the same `/v1/messages` request and `x-api-key` via curl.
 *
 * A profile-level `headers.user-agent` value still wins, so gateways with a
 * stricter contract remain fully configurable.
 */
export const CUSTOM_ENDPOINT_USER_AGENT = "easy-agent/0.1.0";

function buildProfileDefaultHeaders(
  baseURL: string | undefined,
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const normalized = new Map<string, string>();
  if (baseURL) normalized.set("user-agent", CUSTOM_ENDPOINT_USER_AGENT);
  for (const [name, value] of Object.entries(headers ?? {})) {
    normalized.set(name.toLowerCase(), value);
  }
  return normalized.size > 0 ? Object.fromEntries(normalized) : undefined;
}

function headersCacheKey(headers: Record<string, string> | undefined): string {
  return JSON.stringify(Object.entries(headers ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Normalize a custom Anthropic baseURL for the SDK.
 *
 * The SDK builds request URLs by CONCATENATING `baseURL + "/v1/messages"`
 * (see @anthropic-ai/sdk client `buildURL`). So a baseURL that already ends in
 * `/v1` — common when the same gateway host is reused across protocols, e.g.
 * `https://host/v1` for OpenAI — would produce `https://host/v1/v1/messages`.
 * We strip a single trailing `/v1` (and any trailing slashes) so the SDK's
 * appended path lands on the correct `/v1/messages`.
 */
export function normalizeAnthropicBaseURL(baseURL: string): string {
  return baseURL.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

export function getAnthropicClientForProfile(profile: {
  baseURL?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}): Anthropic {
  if (!profile.baseURL && !profile.apiKey && !profile.headers) {
    return getAnthropicClient();
  }
  const baseURL = profile.baseURL ? normalizeAnthropicBaseURL(profile.baseURL) : undefined;
  const defaultHeaders = buildProfileDefaultHeaders(baseURL, profile.headers);
  // A custom endpoint may not require auth (self-hosted / gateway). The SDK
  // throws at construction when neither apiKey nor ANTHROPIC_AUTH_TOKEN is
  // present, so supply a placeholder for a keyless custom endpoint — mirroring
  // the OpenAI/Gemini paths, which simply omit the auth header. The env token
  // still wins when set; a real api.anthropic.com target (no baseURL) keeps the
  // strict behavior and surfaces the friendly missing-key error.
  const apiKey =
    profile.apiKey ??
    process.env.ANTHROPIC_AUTH_TOKEN ??
    (baseURL ? "not-required" : undefined);
  const key = `${baseURL ?? ""}|${apiKey ?? ""}|${headersCacheKey(defaultHeaders)}`;
  const cached = profileClientCache.get(key);
  if (cached) return cached;
  const client = getAnthropicClient({
    ...(apiKey ? { apiKey } : {}),
    ...(baseURL ? { baseURL } : {}),
    ...(defaultHeaders ? { defaultHeaders } : {}),
  });
  profileClientCache.set(key, client);
  return client;
}

/**
 * Verify the API key is valid by making a lightweight request.
 */
export async function verifyApiKey(apiKey?: string): Promise<boolean> {
  try {
    const client = getAnthropicClient(apiKey ? { apiKey } : undefined);
    await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reset the cached client instance.
 * Useful when the API key changes at runtime.
 */
export function resetClient(): void {
  clientInstance = null;
  profileClientCache.clear();
}
