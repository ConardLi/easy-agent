#!/usr/bin/env tsx
/**
 * Stage 27 verification — error handling & resilience, with NO real LLM calls.
 *
 * Coverage:
 *   [1] Error classification — 429 / 529 / 5xx / 401 / 404 / 413 / timeout /
 *       connection / prompt-too-long / credit / abort each map correctly
 *   [2] Retryability — transient retried, deterministic not retried, abort never
 *   [3] Backoff — exponential growth + jitter band; Retry-After overrides
 *   [4] 529 split — foreground retries (bounded by MAX_529_RETRIES); background
 *       bails immediately
 *   [5] prompt-too-long parsing — token counts extracted
 *   [6] callWithRetry — actually re-invokes after a transient failure, gives up
 *       on a deterministic one, and respects max attempts
 *
 * Everything is deterministic and offline. Exits non-zero on any failed
 * assertion.
 */

import { APIError, APIConnectionError } from "@anthropic-ai/sdk";
import {
  classifyAPIError,
  isRetryableError,
  is529Error,
  isPromptTooLongError,
  parsePromptTooLongTokenCounts,
  getRetryAfterMs,
  getUserFacingErrorMessage,
} from "../services/api/errors.js";
import {
  getRetryDelay,
  shouldRetry529,
  decideRetry,
  callWithRetry,
  getMaxRetries,
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  MAX_529_RETRIES,
  DEFAULT_MAX_RETRIES,
} from "../services/api/withRetry.js";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  \u2713 ${msg}`);
  else {
    console.error(`  \u2717 ${msg}`);
    failures++;
  }
}
function section(title: string): void {
  console.log(`\n${title}`);
}

/** Build a fake APIError with a given status + headers without a live call. */
function apiError(status: number, message: string, headers?: Record<string, string>): APIError {
  const h = new Headers(headers ?? {});
  // The SDK's APIError constructor: (status, error, message, headers)
  return new APIError(status, undefined, message, h);
}

function abortError(): Error {
  const e = new Error("Request was aborted.");
  e.name = "AbortError";
  return e;
}

async function main(): Promise<void> {
  section("[1] Error classification");
  assert(classifyAPIError(apiError(429, "rate limited")) === "rate_limit", "429 → rate_limit");
  assert(classifyAPIError(apiError(529, "overloaded")) === "server_overload", "529 → server_overload");
  assert(
    classifyAPIError(apiError(500, '{"type":"overloaded_error"}')) === "server_overload",
    "overloaded_error body → server_overload (even with 500)",
  );
  assert(classifyAPIError(apiError(503, "bad gateway")) === "server_error", "503 → server_error");
  assert(classifyAPIError(apiError(401, "x-api-key invalid")) === "auth_error", "401 → auth_error");
  assert(classifyAPIError(apiError(403, "forbidden")) === "auth_error", "403 → auth_error");
  assert(classifyAPIError(apiError(404, "no model")) === "model_not_found", "404 → model_not_found");
  assert(
    classifyAPIError(apiError(413, "request too large")) === "prompt_too_long",
    "413 → prompt_too_long",
  );
  assert(
    classifyAPIError(apiError(400, "prompt is too long: 200000 tokens > 199000 maximum")) ===
      "prompt_too_long",
    "400 'prompt is too long' → prompt_too_long",
  );
  assert(
    classifyAPIError(new Error("Your credit balance is too low")) === "credit_balance",
    "credit balance → credit_balance",
  );
  assert(classifyAPIError(new APIConnectionError({ message: "ECONNRESET" })) === "connection_error", "conn error → connection_error");
  assert(classifyAPIError(abortError()) === "aborted", "AbortError → aborted");
  assert(classifyAPIError(new Error("weird")) === "unknown", "unknown → unknown");

  section("[2] Retryability");
  assert(isRetryableError(apiError(429, "x")) === true, "429 retryable");
  assert(isRetryableError(apiError(529, "x")) === true, "529 retryable");
  assert(isRetryableError(apiError(500, "x")) === true, "500 retryable");
  assert(isRetryableError(apiError(408, "x")) === true, "408 retryable");
  assert(isRetryableError(apiError(409, "x")) === true, "409 retryable");
  assert(isRetryableError(new APIConnectionError({ message: "down" })) === true, "connection retryable");
  assert(isRetryableError(apiError(401, "x")) === false, "401 NOT retryable");
  assert(isRetryableError(apiError(400, "bad")) === false, "400 NOT retryable");
  assert(isRetryableError(apiError(404, "x")) === false, "404 NOT retryable");
  assert(isRetryableError(apiError(413, "prompt is too long")) === false, "413 prompt-too-long NOT retryable");
  assert(isRetryableError(abortError()) === false, "abort NEVER retryable");

  section("[3] Backoff (exponential + jitter, Retry-After override)");
  // attempt 1 → base 500, jitter ≤ 125 → [500, 625]
  let inBand = true;
  for (let i = 0; i < 200; i++) {
    const d = getRetryDelay(1);
    if (d < BASE_DELAY_MS || d > BASE_DELAY_MS * 1.25) inBand = false;
  }
  assert(inBand, "attempt 1 delay in [500, 625] across 200 samples");
  // growth: attempt 4 base = 500*2^3 = 4000
  let growthOk = true;
  for (let i = 0; i < 200; i++) {
    const d = getRetryDelay(4);
    if (d < 4000 || d > 4000 * 1.25) growthOk = false;
  }
  assert(growthOk, "attempt 4 delay in [4000, 5000] (exponential growth)");
  // ceiling: very high attempt clamps base to MAX_DELAY_MS before jitter
  let capped = true;
  for (let i = 0; i < 50; i++) {
    const d = getRetryDelay(20);
    if (d > MAX_DELAY_MS * 1.25) capped = false;
  }
  assert(capped, `attempt 20 delay capped near MAX_DELAY_MS (${MAX_DELAY_MS})`);
  // Retry-After header wins verbatim
  assert(getRetryDelay(1, 7000) === 7000, "Retry-After (7000ms) overrides backoff");
  assert(getRetryAfterMs(apiError(429, "x", { "retry-after": "3" })) === 3000, "getRetryAfterMs parses '3' → 3000ms");
  assert(getRetryAfterMs(apiError(429, "x")) === null, "no Retry-After → null");

  section("[4] Foreground / background 529 split");
  assert(shouldRetry529("foreground") === true, "foreground retries 529");
  assert(shouldRetry529("background") === false, "background drops 529");
  assert(shouldRetry529(undefined) === true, "undefined defaults to retry (foreground)");
  // decideRetry: background 529 → no retry immediately
  const bg = decideRetry(apiError(529, "overloaded"), 1, { maxRetries: 10, querySource: "background" });
  assert(bg.retry === false, "decideRetry: background 529 → retry=false");
  // foreground 529 → retries until MAX_529_RETRIES consecutive
  let consec = 0;
  let fgDecisions: boolean[] = [];
  for (let attempt = 1; attempt <= 5; attempt++) {
    const d = decideRetry(apiError(529, "overloaded"), attempt, {
      maxRetries: 10,
      querySource: "foreground",
      consecutive529: consec,
    });
    consec = d.consecutive529;
    fgDecisions.push(d.retry);
  }
  // first (MAX_529_RETRIES - 1) retry true, then false once count hits the cap
  const trueCount = fgDecisions.filter(Boolean).length;
  assert(trueCount === MAX_529_RETRIES - 1, `foreground 529 retries ${MAX_529_RETRIES - 1}× then bails (cap ${MAX_529_RETRIES})`);
  // deterministic error → never retried regardless of source
  assert(decideRetry(apiError(401, "x"), 1, { maxRetries: 10 }).retry === false, "decideRetry: 401 → no retry");
  // exhausted attempts
  assert(decideRetry(apiError(500, "x"), 11, { maxRetries: 10 }).retry === false, "decideRetry: attempt > maxRetries → no retry");
  assert(decideRetry(apiError(500, "x"), 1, { maxRetries: 10 }).retry === true, "decideRetry: 500 within budget → retry");

  section("[5] prompt-too-long parsing");
  assert(isPromptTooLongError(apiError(400, "prompt is too long: 5 tokens > 4 maximum")), "isPromptTooLongError true for 400 msg");
  assert(isPromptTooLongError(apiError(413, "too big")), "isPromptTooLongError true for 413");
  const parsed = parsePromptTooLongTokenCounts("prompt is too long: 137500 tokens > 135000 maximum");
  assert(parsed.actualTokens === 137500 && parsed.limitTokens === 135000, "parse token counts 137500 > 135000");
  const unparsed = parsePromptTooLongTokenCounts("prompt is too long");
  assert(unparsed.actualTokens === undefined, "unparseable → undefined token counts");

  section("[6] is529 helpers + friendly messages");
  assert(is529Error(apiError(529, "x")) === true, "is529Error true for status 529");
  assert(is529Error(apiError(500, '{"type":"overloaded_error"}')) === true, "is529Error true for overloaded body");
  assert(is529Error(apiError(429, "x")) === false, "is529Error false for 429");
  assert(getUserFacingErrorMessage(apiError(401, "x-api-key")).includes("API key"), "auth message mentions API key");
  assert(getUserFacingErrorMessage(apiError(404, "x"), "claude-foo").includes("claude-foo"), "model_not_found message includes model");
  assert(getUserFacingErrorMessage(apiError(529, "x")).includes("overloaded"), "529 message mentions overloaded");

  section("[7] callWithRetry — real re-invocation behavior");
  process.env.EASY_AGENT_MAX_RETRIES = "5"; // fast + deterministic
  // (a) fails twice with 500, then succeeds → returns the success value
  {
    let calls = 0;
    const retries: number[] = [];
    const result = await callWithRetry(
      async () => {
        calls++;
        if (calls <= 2) throw apiError(500, "transient");
        return "ok";
      },
      { onRetry: (info) => retries.push(info.attempt) },
    );
    assert(result === "ok" && calls === 3, "callWithRetry: succeeds on 3rd attempt after 2 transient failures");
    assert(retries.length === 2, "callWithRetry: fired onRetry twice");
  }
  // (b) deterministic 401 → throws immediately, no retry
  {
    let calls = 0;
    let threw = false;
    try {
      await callWithRetry(async () => {
        calls++;
        throw apiError(401, "bad key");
      });
    } catch {
      threw = true;
    }
    assert(threw && calls === 1, "callWithRetry: 401 throws on first attempt (no retry)");
  }
  // (c) always-500 → gives up after maxRetries+1 attempts
  {
    let calls = 0;
    let threw = false;
    try {
      await callWithRetry(
        async () => {
          calls++;
          throw apiError(500, "always down");
        },
        { maxRetries: 3 },
      );
    } catch {
      threw = true;
    }
    assert(threw && calls === 4, "callWithRetry: exhausts after maxRetries+1 (=4) attempts");
  }
  // (d) background 529 → bails on first attempt
  {
    let calls = 0;
    let threw = false;
    try {
      await callWithRetry(
        async () => {
          calls++;
          throw apiError(529, "overloaded");
        },
        { querySource: "background" },
      );
    } catch {
      threw = true;
    }
    assert(threw && calls === 1, "callWithRetry: background 529 bails on first attempt");
  }
  delete process.env.EASY_AGENT_MAX_RETRIES;

  section("[8] getMaxRetries env override");
  assert(getMaxRetries() === DEFAULT_MAX_RETRIES, `default maxRetries = ${DEFAULT_MAX_RETRIES}`);
  process.env.EASY_AGENT_MAX_RETRIES = "2";
  assert(getMaxRetries() === 2, "EASY_AGENT_MAX_RETRIES overrides default");
  delete process.env.EASY_AGENT_MAX_RETRIES;

  console.log(
    failures === 0
      ? "\n\x1b[32mAll Stage 27 resilience checks passed.\x1b[0m"
      : `\n\x1b[31m${failures} check(s) failed.\x1b[0m`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
