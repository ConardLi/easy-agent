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
}): Anthropic {
  if (clientInstance && !options) {
    return clientInstance;
  }

  const client = new Anthropic({
    apiKey: options?.apiKey ?? process.env.ANTHROPIC_AUTH_TOKEN,
    baseURL: options?.baseURL ?? process.env.ANTHROPIC_BASE_URL,
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

export function getAnthropicClientForProfile(profile: {
  baseURL?: string;
  apiKey?: string;
}): Anthropic {
  if (!profile.baseURL && !profile.apiKey) {
    return getAnthropicClient();
  }
  const key = `${profile.baseURL ?? ""}|${profile.apiKey ?? ""}`;
  const cached = profileClientCache.get(key);
  if (cached) return cached;
  const client = getAnthropicClient({
    ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
    ...(profile.baseURL ? { baseURL: profile.baseURL } : {}),
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
