/**
 * API error classification + user-facing messages.
 *
 * Reference: claude-code-source-code/src/services/api/errors.ts
 *
 * The source file is ~1200 lines because it covers Bedrock/Vertex/OAuth,
 * media-size rejections, subscription tiers, and a dozen provider-specific
 * branches. Easy Agent only talks to the first-party Anthropic API with a
 * static token, so this is the裁剪 core: classify an error into a small set
 * of categories, decide retryability, and render one friendly sentence.
 *
 * The whole point is "error classification drives recovery strategy" — the
 * retry loop, the max_tokens recovery state machine, and the reactive-compact
 * path all key off the category returned here rather than re-parsing errors.
 */

import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from "@anthropic-ai/sdk";

// ─── Categories ────────────────────────────────────────────────────

export type APIErrorCategory =
  | "rate_limit" // 429 — quota / throttling
  | "server_overload" // 529 — capacity overload
  | "server_error" // 5xx
  | "auth_error" // 401 — bad or missing token
  | "permission_denied" // 403 — valid request rejected by provider / gateway policy
  | "prompt_too_long" // 413, or 400 "prompt is too long"
  | "credit_balance" // billing: balance too low
  | "model_not_found" // 404 — unknown / inaccessible model
  | "invalid_request" // other 4xx
  | "api_timeout" // request timed out
  | "connection_error" // network unreachable / reset
  | "aborted" // user/Abort cancelled
  | "unknown";

// ─── User-facing message constants ─────────────────────────────────

export const API_ERROR_MESSAGE_PREFIX = "API Error";
export const INVALID_API_KEY_MESSAGE =
  "Invalid or missing API key. Set ANTHROPIC_AUTH_TOKEN (and ANTHROPIC_BASE_URL if using a custom endpoint) and try again.";
export const CREDIT_BALANCE_TOO_LOW_MESSAGE =
  "Credit balance is too low. Top up your account or switch to a different key.";
export const API_TIMEOUT_MESSAGE =
  "Request timed out. This is usually transient — try again.";
export const PROMPT_TOO_LONG_MESSAGE = "Prompt is too long";
export const SERVER_OVERLOAD_MESSAGE =
  "The API is temporarily overloaded (529). Please try again in a moment.";

// ─── Predicates ────────────────────────────────────────────────────

/**
 * 529 capacity overload. The SDK sometimes fails to surface the 529 status
 * during streaming, so we also sniff the overloaded_error type in the body —
 * mirrors source's `is529Error`.
 */
export function is529Error(error: unknown): boolean {
  if (!(error instanceof APIError)) return false;
  return (
    error.status === 529 ||
    (error.message?.includes('"type":"overloaded_error"') ?? false)
  );
}

/**
 * Is this an "input is bigger than the context window" rejection? The
 * first-party API returns 400 with "prompt is too long"; some gateways use
 * 413. Reactive compact keys off this to decide whether to summarize + retry.
 */
export function isPromptTooLongError(error: unknown): boolean {
  if (error instanceof APIError && error.status === 413) return true;
  return (
    error instanceof Error &&
    error.message.toLowerCase().includes("prompt is too long")
  );
}

/**
 * Parse "prompt is too long: 137500 tokens > 135000 maximum" into its two
 * numbers. Lenient on casing / wrapping — mirrors source's
 * `parsePromptTooLongTokenCounts`. Returns undefined fields when unparseable.
 */
export function parsePromptTooLongTokenCounts(rawMessage: string): {
  actualTokens: number | undefined;
  limitTokens: number | undefined;
} {
  const match = rawMessage.match(
    /prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i,
  );
  return {
    actualTokens: match ? parseInt(match[1]!, 10) : undefined,
    limitTokens: match ? parseInt(match[2]!, 10) : undefined,
  };
}

/**
 * Pull the `Retry-After` header (seconds) off an error and convert to ms.
 * The header is a server directive and should win over local backoff.
 */
export function getRetryAfterMs(error: unknown): number | null {
  const headers = (error as { headers?: unknown }).headers;
  let raw: string | null | undefined;
  if (headers && typeof (headers as Headers).get === "function") {
    raw = (headers as Headers).get("retry-after");
  } else if (headers && typeof headers === "object") {
    raw = (headers as Record<string, string>)["retry-after"];
  }
  if (!raw) return null;
  const seconds = parseInt(raw, 10);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

// ─── Classification ────────────────────────────────────────────────

/**
 * Map any thrown error to a single category. Order matters: more specific
 * checks (timeout, 529, prompt-too-long) come before the status-code
 * fallbacks. Mirrors the spirit of source's `classifyAPIError`, trimmed to
 * the categories Easy Agent can actually act on.
 */
export function classifyAPIError(error: unknown): APIErrorCategory {
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  if (
    error instanceof Error &&
    (error.message === "Request was aborted." ||
      error.message.includes("aborted"))
  ) {
    // APIUserAbortError-style messages
    if (error.name.includes("Abort")) return "aborted";
  }

  if (
    error instanceof APIConnectionTimeoutError ||
    (error instanceof APIConnectionError &&
      error.message.toLowerCase().includes("timeout"))
  ) {
    return "api_timeout";
  }

  if (is529Error(error)) return "server_overload";

  if (isPromptTooLongError(error)) return "prompt_too_long";

  if (
    error instanceof Error &&
    error.message.toLowerCase().includes("credit balance is too low")
  ) {
    return "credit_balance";
  }

  if (
    error instanceof Error &&
    error.message.toLowerCase().includes("x-api-key")
  ) {
    return "auth_error";
  }

  if (error instanceof APIError) {
    const status = error.status;
    if (status === 429) return "rate_limit";
    if (status === 401) return "auth_error";
    if (status === 403) return "permission_denied";
    if (status === 404) return "model_not_found";
    if (status !== undefined && status >= 500) return "server_error";
    if (status !== undefined && status >= 400) return "invalid_request";
  }

  if (error instanceof APIConnectionError) return "connection_error";

  return "unknown";
}

/**
 * Should the retry loop attempt this error again? Only transient
 * categories are retryable. 401/403/400/404/prompt-too-long/credit are
 * deterministic — retrying the same request produces the same failure.
 *
 * Note: 529 is retryable here, but the *foreground/background* gate in
 * withRetry decides whether a background source should bail on 529.
 */
export function isRetryableError(error: unknown): boolean {
  // Never retry an aborted request.
  if (classifyAPIError(error) === "aborted") return false;

  if (error instanceof APIConnectionError) return true;

  if (error instanceof APIError) {
    const status = error.status;
    if (is529Error(error)) return true;
    if (status === undefined) return false;
    // 408 request timeout, 409 lock conflict, 429 rate limit, 5xx server.
    if (status === 408 || status === 409 || status === 429) return true;
    if (status >= 500) return true;
    return false;
  }

  return false;
}

/**
 * Render a single human-readable sentence for an error, used both as the
 * notice surfaced to the user and (for the failing-final case) the text the
 * model sees. Maps each category to a concrete, actionable message; falls
 * back to the raw error text prefixed with "API Error".
 */
export function getUserFacingErrorMessage(
  error: unknown,
  model?: string,
): string {
  const category = classifyAPIError(error);
  const rawMessage =
    error instanceof Error ? error.message : String(error);

  switch (category) {
    case "auth_error":
      return INVALID_API_KEY_MESSAGE;
    case "permission_denied":
      // Keep the upstream detail. A generic 403 may be a model entitlement,
      // gateway policy, CDN/WAF block, or organization restriction; calling
      // every one of those an invalid API key hides the actionable cause.
      return `${API_ERROR_MESSAGE_PREFIX}: ${rawMessage}`;
    case "credit_balance":
      return CREDIT_BALANCE_TOO_LOW_MESSAGE;
    case "api_timeout":
      return API_TIMEOUT_MESSAGE;
    case "server_overload":
      return SERVER_OVERLOAD_MESSAGE;
    case "rate_limit":
      return `${API_ERROR_MESSAGE_PREFIX}: Rate limit reached (429). The request was throttled — retry shortly.`;
    case "server_error":
      return `${API_ERROR_MESSAGE_PREFIX}: The server returned an error (5xx). This is usually transient — try again.`;
    case "prompt_too_long":
      return `${PROMPT_TOO_LONG_MESSAGE}. The conversation exceeds the model's context window — use /compact to free space.`;
    case "model_not_found":
      return `${API_ERROR_MESSAGE_PREFIX}: The model${model ? ` "${model}"` : ""} was not found or is not accessible. Use /model to pick a different one.`;
    case "connection_error":
      return `${API_ERROR_MESSAGE_PREFIX}: Could not reach the API (network error). Check your connection${process.env.ANTHROPIC_BASE_URL ? ` and ANTHROPIC_BASE_URL (${process.env.ANTHROPIC_BASE_URL})` : ""}.`;
    case "aborted":
      return rawMessage;
    default:
      return `${API_ERROR_MESSAGE_PREFIX}: ${rawMessage}`;
  }
}

/**
 * Wrap an arbitrary thrown value into an Error whose message is the friendly,
 * category-mapped text. Preserves the original via `cause` for debugging.
 */
export function toFriendlyError(error: unknown, model?: string): Error {
  const friendly = new Error(getUserFacingErrorMessage(error, model));
  if (error instanceof Error) {
    friendly.stack = error.stack;
    (friendly as Error & { cause?: unknown }).cause = error;
  }
  return friendly;
}
