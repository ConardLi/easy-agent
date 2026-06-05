/**
 * Step 27 - Error handling and resilience
 *
 * Goal:
 * - classify API errors before deciding what to do
 * - retry transient failures with exponential backoff + jitter
 * - split foreground/background 529 retry behavior
 * - recover max_tokens and prompt-too-long at the agent-loop level
 */

// -----------------------------------------------------------------------------
// 1. Error classification
// -----------------------------------------------------------------------------

export const API_ERROR = {
  RATE_LIMIT: "rate_limit",
  SERVER_OVERLOAD: "server_overload",
  PROMPT_TOO_LONG: "prompt_too_long",
  AUTH_ERROR: "auth_error",
  MODEL_NOT_FOUND: "model_not_found",
  CREDIT_BALANCE: "credit_balance",
  SERVER_ERROR: "server_error",
  CONNECTION_ERROR: "connection_error",
  API_TIMEOUT: "api_timeout",
  ABORTED: "aborted",
  UNKNOWN: "unknown",
};

export function classifyAPIError(error) {
  const status = error?.status;
  const message = String(error?.message || error || "").toLowerCase();
  const name = String(error?.name || "");

  if (name === "AbortError") return API_ERROR.ABORTED;
  if (status === 401 || status === 403) return API_ERROR.AUTH_ERROR;
  if (status === 404) return API_ERROR.MODEL_NOT_FOUND;
  if (status === 429) return API_ERROR.RATE_LIMIT;
  if (status === 529 || message.includes("overloaded_error")) return API_ERROR.SERVER_OVERLOAD;
  if (status === 413 || message.includes("prompt is too long")) return API_ERROR.PROMPT_TOO_LONG;
  if (message.includes("credit balance")) return API_ERROR.CREDIT_BALANCE;
  if (message.includes("timeout") || status === 408) return API_ERROR.API_TIMEOUT;
  if (message.includes("econn") || message.includes("network") || name.includes("Connection")) {
    return API_ERROR.CONNECTION_ERROR;
  }
  if (typeof status === "number" && status >= 500) return API_ERROR.SERVER_ERROR;
  return API_ERROR.UNKNOWN;
}

export function isPromptTooLongError(error) {
  return classifyAPIError(error) === API_ERROR.PROMPT_TOO_LONG;
}

export function is529Error(error) {
  return classifyAPIError(error) === API_ERROR.SERVER_OVERLOAD;
}

export function parsePromptTooLongTokenCounts(raw) {
  const text = String(raw?.message || raw || "");
  const match = text.match(/([\d,]+)\s+tokens\s*>\s*([\d,]+)\s+maximum/i);
  if (!match) return { actualTokens: undefined, limitTokens: undefined };
  return {
    actualTokens: Number(match[1].replace(/,/g, "")),
    limitTokens: Number(match[2].replace(/,/g, "")),
  };
}

export function getUserFacingErrorMessage(error, model = "current model") {
  switch (classifyAPIError(error)) {
    case API_ERROR.AUTH_ERROR:
      return "Invalid or missing API key. Check ANTHROPIC_AUTH_TOKEN or your provider credentials.";
    case API_ERROR.MODEL_NOT_FOUND:
      return `Model is unavailable or unknown: ${model}.`;
    case API_ERROR.CREDIT_BALANCE:
      return "Your API credit balance is too low.";
    case API_ERROR.SERVER_OVERLOAD:
      return "The API is overloaded. Please retry shortly.";
    case API_ERROR.PROMPT_TOO_LONG:
      return "The prompt is too long. Compact the conversation and retry.";
    case API_ERROR.API_TIMEOUT:
      return "The API request timed out.";
    case API_ERROR.CONNECTION_ERROR:
      return "Network connection failed while contacting the model provider.";
    default:
      return String(error?.message || error || "Unknown API error");
  }
}

// -----------------------------------------------------------------------------
// 2. Retry policy
// -----------------------------------------------------------------------------

export const BASE_DELAY_MS = 500;
export const MAX_DELAY_MS = 32_000;
export const DEFAULT_MAX_RETRIES = 10;
export const MAX_529_RETRIES = 3;

export function getMaxRetries(env = process.env) {
  const raw = env.EASY_AGENT_MAX_RETRIES;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_RETRIES;
}

export function getRetryAfterMs(error) {
  const value =
    error?.headers?.get?.("retry-after") ??
    error?.headers?.["retry-after"] ??
    error?.retryAfter;
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

export function isRetryableError(error) {
  if (error?.headers?.get?.("x-should-retry") === "false") return false;
  switch (classifyAPIError(error)) {
    case API_ERROR.RATE_LIMIT:
    case API_ERROR.SERVER_OVERLOAD:
    case API_ERROR.SERVER_ERROR:
    case API_ERROR.CONNECTION_ERROR:
    case API_ERROR.API_TIMEOUT:
      return true;
    default:
      return false;
  }
}

export function getRetryDelay(attempt, retryAfterMs = null) {
  if (typeof retryAfterMs === "number") return retryAfterMs;
  const base = Math.min(BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), MAX_DELAY_MS);
  return Math.round(base + Math.random() * base * 0.25);
}

export function shouldRetry529(querySource = "foreground") {
  return querySource !== "background";
}

export function decideRetry(error, attempt, options = {}) {
  const maxRetries = options.maxRetries ?? getMaxRetries();
  const consecutive529 = options.consecutive529 ?? 0;

  if (!isRetryableError(error)) {
    return { retry: false, delayMs: 0, consecutive529 };
  }
  if (attempt > maxRetries) {
    return { retry: false, delayMs: 0, consecutive529 };
  }
  if (is529Error(error)) {
    if (!shouldRetry529(options.querySource)) {
      return { retry: false, delayMs: 0, consecutive529: consecutive529 + 1 };
    }
    const next529 = consecutive529 + 1;
    if (next529 >= MAX_529_RETRIES) {
      return { retry: false, delayMs: 0, consecutive529: next529 };
    }
    return {
      retry: true,
      delayMs: getRetryDelay(attempt, getRetryAfterMs(error)),
      consecutive529: next529,
    };
  }

  return {
    retry: true,
    delayMs: getRetryDelay(attempt, getRetryAfterMs(error)),
    consecutive529: 0,
  };
}

export async function callWithRetry(operation, options = {}) {
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10))));
  let consecutive529 = 0;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      const decision = decideRetry(error, attempt, {
        ...options,
        consecutive529,
        maxRetries: options.maxRetries ?? getMaxRetries(),
      });
      consecutive529 = decision.consecutive529;
      if (!decision.retry) throw error;
      options.onRetry?.({ attempt, delayMs: decision.delayMs, error });
      await sleep(decision.delayMs);
    }
  }
}

// -----------------------------------------------------------------------------
// 3. Loop-level recovery
// -----------------------------------------------------------------------------

export const ESCALATED_MAX_TOKENS = 64_000;
export const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;

export function createLoopRecoveryState() {
  return {
    maxOutputTokensOverride: undefined,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
  };
}

export function handleMaxTokensStop(state) {
  if (!state.maxOutputTokensOverride) {
    state.maxOutputTokensOverride = ESCALATED_MAX_TOKENS;
    return { action: "retry_same_request", state };
  }

  if (state.maxOutputTokensRecoveryCount >= MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
    return { action: "fail", reason: "max_output_tokens_recovery_limit", state };
  }

  state.maxOutputTokensRecoveryCount += 1;
  return {
    action: "append_recovery_prompt",
    message:
      "Output token limit hit. Resume directly - no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.",
    state,
  };
}

export async function handlePromptTooLong(error, state, compactConversation) {
  if (!isPromptTooLongError(error)) return { action: "unhandled", state };
  if (state.hasAttemptedReactiveCompact) {
    return { action: "fail", reason: "prompt_too_long_after_compact", state };
  }
  state.hasAttemptedReactiveCompact = true;
  const tokenCounts = parsePromptTooLongTokenCounts(error);
  const compactedMessages = await compactConversation(tokenCounts);
  return { action: "retry_with_compacted_messages", messages: compactedMessages, state };
}

// -----------------------------------------------------------------------------
// 4. Demo
// -----------------------------------------------------------------------------

export async function demoStep27() {
  let calls = 0;
  const result = await callWithRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw { status: 500, message: "temporary server error" };
      return "ok";
    },
    { maxRetries: 5, sleep: async () => undefined },
  );

  const recovery = createLoopRecoveryState();
  const firstCut = handleMaxTokensStop(recovery);
  const secondCut = handleMaxTokensStop(recovery);
  const compact = await handlePromptTooLong(
    { status: 400, message: "prompt is too long: 200000 tokens > 190000 maximum" },
    recovery,
    async (counts) => [`summary for ${counts.actualTokens} tokens`],
  );

  return {
    result,
    calls,
    classified429: classifyAPIError({ status: 429, message: "rate limit" }),
    background529: decideRetry({ status: 529, message: "overloaded" }, 1, { querySource: "background" }).retry,
    firstCut: firstCut.action,
    secondCut: secondCut.action,
    compact: compact.action,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await demoStep27(), null, 2));
}
