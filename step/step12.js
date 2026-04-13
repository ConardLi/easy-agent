/**
 * Step 12 - Token budget management: multi-tier thresholds, circuit breaker,
 *           tool result truncation, and output token optimization
 *
 * Goal:
 * - parameterize context window by model (+ env override)
 * - adaptive buffer scaling for small windows
 * - four-state warning system: normal → warning → error → blocking
 * - circuit breaker to stop retrying failed auto-compaction
 * - escape condition to prevent compaction-triggers-compaction loops
 * - truncate oversized tool results before they enter the message history
 * - split max_tokens into three tiers (daily / retry / compact)
 * - invalidate usage anchor after compaction to avoid stale estimates
 *
 * Builds on step11.js — token estimation and compaction primitives are imported.
 */

import {
  estimateMessagesTokens,
  tokenCountWithEstimation,
  microCompactMessages,
  compactMessages,
} from "./step11.js";

// ─── Model Context Window ──────────────────────────────────────────

const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000;
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;

const MODEL_CONTEXT_WINDOWS = {
  "claude-opus-4-20250514": 200_000,
  "claude-sonnet-4-20250514": 200_000,
  "claude-3-5-sonnet-20241022": 200_000,
};

export function getContextWindowForModel(model) {
  const envOverride = process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  if (envOverride) {
    const parsed = parseInt(envOverride, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return MODEL_CONTEXT_WINDOWS[model] ?? MODEL_CONTEXT_WINDOW_DEFAULT;
}

/**
 * Effective window = context window minus space reserved for summary output.
 * For small windows (<100K) use 20% instead of a fixed 20K to avoid
 * the reserved portion exceeding the window itself.
 */
export function getEffectiveContextWindowSize(model) {
  const contextWindow = getContextWindowForModel(model);
  const reserved = Math.min(MAX_OUTPUT_TOKENS_FOR_SUMMARY, Math.floor(contextWindow * 0.2));
  return contextWindow - reserved;
}

// ─── Adaptive Buffer Scaling ───────────────────────────────────────

const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000;
const MANUAL_COMPACT_BUFFER_TOKENS = 3_000;

const REFERENCE_WINDOW = 180_000;

/**
 * When effective window < 180K, scale the buffer proportionally.
 * A 30K window gets roughly 30/180 ≈ 17% of the original buffer,
 * keeping the trigger ratio consistent across window sizes.
 */
function scaleBuffer(buffer, effectiveWindow) {
  if (effectiveWindow >= REFERENCE_WINDOW) return buffer;
  return Math.round(buffer * (effectiveWindow / REFERENCE_WINDOW));
}

function getAutoCompactThreshold(model) {
  const effective = getEffectiveContextWindowSize(model);
  return Math.max(0, effective - scaleBuffer(AUTOCOMPACT_BUFFER_TOKENS, effective));
}

function getBlockingLimit(model) {
  const effective = getEffectiveContextWindowSize(model);
  return Math.max(0, effective - scaleBuffer(MANUAL_COMPACT_BUFFER_TOKENS, effective));
}

function getWarningThreshold(model) {
  const effective = getEffectiveContextWindowSize(model);
  return Math.max(0, effective - scaleBuffer(WARNING_THRESHOLD_BUFFER_TOKENS, effective));
}

// ─── Four-State Warning System ─────────────────────────────────────

export function calculateTokenWarningState(estimatedTokens, model) {
  const contextWindow = getContextWindowForModel(model);
  const blockingLimit = getBlockingLimit(model);
  const autoCompactThreshold = getAutoCompactThreshold(model);
  const warningThreshold = getWarningThreshold(model);

  let state = "normal";
  if (estimatedTokens >= blockingLimit) {
    state = "blocking";
  } else if (estimatedTokens >= autoCompactThreshold) {
    state = "error";
  } else if (estimatedTokens >= warningThreshold) {
    state = "warning";
  }

  return { state, estimatedTokens, threshold: autoCompactThreshold, blockingLimit, contextWindow };
}

// ─── Circuit Breaker ───────────────────────────────────────────────

const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;

let consecutiveAutoCompactFailures = 0;

export function resetAutoCompactFailures() {
  consecutiveAutoCompactFailures = 0;
}

/**
 * Decide whether auto-compaction should fire.
 * Returns false when:
 *  1. The request itself is a compaction call (escape condition)
 *  2. Circuit breaker is open (too many consecutive failures)
 *  3. Token usage is below the threshold
 */
export function shouldAutoCompact(estimatedTokens, model, querySource) {
  if (querySource === "compact" || querySource === "session_memory") {
    return false;
  }
  if (consecutiveAutoCompactFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
    return false;
  }
  return estimatedTokens >= getAutoCompactThreshold(model);
}

export async function autoCompactIfNeeded(messages, model, callModel, options = {}) {
  const estimatedTokens = tokenCountWithEstimation(messages, options);

  if (!shouldAutoCompact(estimatedTokens, model, options.querySource)) {
    return { result: { messages, didCompact: false, didMicroCompact: false }, didAutoCompact: false };
  }

  try {
    const result = await compactMessages(messages, callModel, { ...options, force: true });
    consecutiveAutoCompactFailures = 0;
    return { result, didAutoCompact: result.didCompact };
  } catch {
    consecutiveAutoCompactFailures++;
    return { result: { messages, didCompact: false, didMicroCompact: false }, didAutoCompact: false };
  }
}

// ─── Tool Result Truncation ────────────────────────────────────────

const DEFAULT_MAX_RESULT_SIZE_CHARS = 100_000;

export function truncateToolResult(content, maxChars = DEFAULT_MAX_RESULT_SIZE_CHARS) {
  if (content.length <= maxChars) return content;
  const truncated = content.slice(0, maxChars);
  return `${truncated}\n\n[Output truncated: ${content.length} chars total, showing first ${maxChars}]`;
}

// ─── Output Token Tiers ────────────────────────────────────────────

export const CAPPED_DEFAULT_MAX_TOKENS = 8_000;
export const ESCALATED_MAX_TOKENS = 64_000;
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000;

/**
 * Simulates the truncation-recovery flow:
 * 1. Send request with 8K max_tokens
 * 2. If response is truncated (stopReason === "max_tokens"), retry with 64K
 */
export async function streamMessageWithRetry(callModel, messages, options = {}) {
  const maxTokens = options.maxTokens ?? CAPPED_DEFAULT_MAX_TOKENS;
  const result = await callModel(messages, { maxTokens });

  if (result.stopReason === "max_tokens" && maxTokens < ESCALATED_MAX_TOKENS) {
    return callModel(messages, { maxTokens: ESCALATED_MAX_TOKENS });
  }

  return result;
}

// ─── Usage Anchor Invalidation ─────────────────────────────────────

/**
 * Manages the usage anchor lifecycle.
 * After compaction the message array is restructured; the old anchor
 * index and usage become stale. Failing to invalidate causes
 * tokenCountWithEstimation to return pre-compaction values, which
 * triggers an immediate re-compaction loop.
 */
export class UsageAnchor {
  constructor() {
    this.index = -1;
    this.usage = null;
  }

  update(index, usage) {
    this.index = index;
    this.usage = usage;
  }

  invalidate() {
    this.index = -1;
    this.usage = null;
  }

  getEstimationOptions() {
    if (this.index < 0 || !this.usage) return {};
    return { usage: this.usage, usageAnchorIndex: this.index };
  }
}

// ─── MicroCompact Enhancements (v2) ───────────────────────────────

const COMPACTABLE_TOOLS_V2 = new Set(["Read", "Grep", "Glob", "Bash", "Edit", "Write"]);

/**
 * Detect binary-only content blocks (images, documents) in tool results
 * and replace them with a lightweight placeholder.
 */
function microCompactToolResultContent(content) {
  if (Array.isArray(content)) {
    const hasOnlyBinary = content.every(
      (b) => b.type === "image" || b.type === "document",
    );
    if (hasOnlyBinary) return "[image]";
  }
  return null;
}

export function microCompactMessageV2(message) {
  if (!Array.isArray(message.content)) return { message, cleared: false };

  let cleared = false;
  const content = message.content.map((block) => {
    if (block.type !== "tool_result") return block;

    // Handle binary content blocks (image, document)
    const binaryReplacement = microCompactToolResultContent(block.content);
    if (binaryReplacement) {
      cleared = true;
      return { ...block, content: binaryReplacement };
    }

    if (typeof block.content !== "string") return block;

    const toolName = block.content.match(/^([A-Za-z0-9_-]+):/)?.[1];
    if (!toolName || !COMPACTABLE_TOOLS_V2.has(toolName)) return block;

    cleared = true;
    return { ...block, content: "[Old tool result content cleared]" };
  });

  return { message: { ...message, content }, cleared };
}

// ─── Compact Message Filtering (UI) ───────────────────────────────

export function isCompactMessage(message) {
  const content = typeof message.content === "string" ? message.content : "";
  return (
    content.startsWith("[CompactBoundary]") ||
    content.startsWith("This session is being continued from a previous conversation")
  );
}

// ─── Demo ──────────────────────────────────────────────────────────

function main() {
  const model = "claude-sonnet-4-20250514";

  console.log("=== Model Context Window ===");
  console.log(`Default window: ${getContextWindowForModel(model)}`);
  console.log(`Effective window: ${getEffectiveContextWindowSize(model)}`);

  console.log("\n=== Threshold System (200K window) ===");
  console.log(`  Warning threshold:     ${getWarningThreshold(model)}`);
  console.log(`  AutoCompact threshold: ${getAutoCompactThreshold(model)}`);
  console.log(`  Blocking limit:        ${getBlockingLimit(model)}`);

  // Simulate a small window via manual calculation
  const smallModel = "test-small";
  process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = "30000";
  console.log("\n=== Threshold System (30K window, env override) ===");
  console.log(`  Context window:        ${getContextWindowForModel(smallModel)}`);
  console.log(`  Effective window:      ${getEffectiveContextWindowSize(smallModel)}`);
  console.log(`  Warning threshold:     ${getWarningThreshold(smallModel)}`);
  console.log(`  AutoCompact threshold: ${getAutoCompactThreshold(smallModel)}`);
  console.log(`  Blocking limit:        ${getBlockingLimit(smallModel)}`);
  delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;

  console.log("\n=== Warning State Transitions ===");
  const thresholds = [150_000, 162_000, 170_000, 179_000];
  for (const tokens of thresholds) {
    const result = calculateTokenWarningState(tokens, model);
    const pct = Math.round((tokens / result.contextWindow) * 100);
    console.log(`  ${tokens} tokens (${pct}%) → ${result.state}`);
  }

  console.log("\n=== Circuit Breaker ===");
  resetAutoCompactFailures();
  console.log(`  Should compact at 170K: ${shouldAutoCompact(170_000, model)}`);
  // Simulate 3 failures
  for (let i = 0; i < 3; i++) consecutiveAutoCompactFailures++;
  console.log(`  After 3 failures:      ${shouldAutoCompact(170_000, model)} (circuit open)`);
  resetAutoCompactFailures();
  console.log(`  After reset:           ${shouldAutoCompact(170_000, model)}`);

  console.log("\n=== Escape Condition ===");
  console.log(`  querySource="compact": ${shouldAutoCompact(170_000, model, "compact")}`);
  console.log(`  querySource=undefined: ${shouldAutoCompact(170_000, model)}`);

  console.log("\n=== Tool Result Truncation ===");
  const longOutput = "x".repeat(200_000);
  const truncated = truncateToolResult(longOutput);
  console.log(`  Input:  ${longOutput.length} chars`);
  console.log(`  Output: ${truncated.length} chars`);
  console.log(`  Ends with: ...${truncated.slice(-60)}`);

  console.log("\n=== Output Token Tiers ===");
  console.log(`  Daily:   ${CAPPED_DEFAULT_MAX_TOKENS}`);
  console.log(`  Retry:   ${ESCALATED_MAX_TOKENS}`);
  console.log(`  Compact: ${COMPACT_MAX_OUTPUT_TOKENS}`);

  console.log("\n=== Usage Anchor Invalidation ===");
  const anchor = new UsageAnchor();
  anchor.update(15, { input_tokens: 50000, output_tokens: 2000 });
  console.log(`  After update: index=${anchor.index}`, anchor.getEstimationOptions());
  anchor.invalidate();
  console.log(`  After invalidate: index=${anchor.index}`, anchor.getEstimationOptions());

  console.log("\n=== MicroCompact V2: binary content ===");
  const msgWithImage = {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: "..." }] },
    ],
  };
  const { message: compacted, cleared } = microCompactMessageV2(msgWithImage);
  console.log(`  Cleared: ${cleared}`);
  console.log(`  Result:  ${JSON.stringify(compacted.content[0].content)}`);

  console.log("\n=== Compact Message Filter ===");
  console.log(`  Boundary:  ${isCompactMessage({ content: "[CompactBoundary] type=auto" })}`);
  console.log(`  Summary:   ${isCompactMessage({ content: "This session is being continued from a previous conversation..." })}`);
  console.log(`  Normal:    ${isCompactMessage({ content: "Hello world" })}`);
}

main();
