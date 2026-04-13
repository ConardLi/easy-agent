import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { compactMessages, type CompactionResult } from "./compaction.js";
import {
  tokenCountWithEstimation,
  getContextWindowForModel,
  getEffectiveContextWindowSize,
  AUTOCOMPACT_BUFFER_TOKENS,
  WARNING_THRESHOLD_BUFFER_TOKENS,
  MANUAL_COMPACT_BUFFER_TOKENS,
} from "../utils/tokens.js";
import { debugLog } from "../utils/log.js";
import type { Usage } from "../types/message.js";

export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;

export type TokenWarningState = "normal" | "warning" | "error" | "blocking";

export interface TokenWarningResult {
  state: TokenWarningState;
  estimatedTokens: number;
  threshold: number;
  blockingLimit: number;
  contextWindow: number;
}

let consecutiveAutoCompactFailures = 0;

export function resetAutoCompactFailures(): void {
  consecutiveAutoCompactFailures = 0;
}

function scaleBuffer(buffer: number, effectiveWindow: number): number {
  // For large windows (>=200K), use the original fixed buffer.
  // For smaller windows, scale proportionally so ratios stay sensible.
  const referenceWindow = 180_000; // effectiveContextWindow at 200K
  if (effectiveWindow >= referenceWindow) return buffer;
  return Math.round(buffer * (effectiveWindow / referenceWindow));
}

export function getAutoCompactThreshold(model: string): number {
  const effective = getEffectiveContextWindowSize(model);
  return Math.max(0, effective - scaleBuffer(AUTOCOMPACT_BUFFER_TOKENS, effective));
}

export function getBlockingLimit(model: string): number {
  const effective = getEffectiveContextWindowSize(model);
  return Math.max(0, effective - scaleBuffer(MANUAL_COMPACT_BUFFER_TOKENS, effective));
}

export function calculateTokenWarningState(
  estimatedTokens: number,
  model: string,
): TokenWarningResult {
  const contextWindow = getContextWindowForModel(model);
  const effective = getEffectiveContextWindowSize(model);
  const blockingLimit = getBlockingLimit(model);
  const autoCompactThreshold = getAutoCompactThreshold(model);
  const warningThreshold = Math.max(0, effective - scaleBuffer(WARNING_THRESHOLD_BUFFER_TOKENS, effective));

  let state: TokenWarningState = "normal";
  if (estimatedTokens >= blockingLimit) {
    state = "blocking";
  } else if (estimatedTokens >= autoCompactThreshold) {
    state = "error";
  } else if (estimatedTokens >= warningThreshold) {
    state = "warning";
  }

  return {
    state,
    estimatedTokens,
    threshold: autoCompactThreshold,
    blockingLimit,
    contextWindow,
  };
}

export function isAtBlockingLimit(estimatedTokens: number, model: string): boolean {
  return estimatedTokens >= getBlockingLimit(model);
}

export function shouldAutoCompact(
  estimatedTokens: number,
  model: string,
  querySource?: string,
): boolean {
  if (querySource === "compact" || querySource === "session_memory") {
    return false;
  }
  if (consecutiveAutoCompactFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
    debugLog("autoCompact", "circuit_breaker", {
      consecutiveFailures: consecutiveAutoCompactFailures,
    });
    return false;
  }
  return estimatedTokens >= getAutoCompactThreshold(model);
}

export async function autoCompactIfNeeded(
  messages: MessageParam[],
  model: string,
  options: {
    usage?: Usage;
    usageAnchorIndex?: number;
    systemPrompt?: string;
    querySource?: string;
  },
): Promise<{ result: CompactionResult; didAutoCompact: boolean }> {
  const estimatedTokens = tokenCountWithEstimation(messages, options);

  if (!shouldAutoCompact(estimatedTokens, model, options.querySource)) {
    return {
      result: { messages, didCompact: false, didMicroCompact: false },
      didAutoCompact: false,
    };
  }

  debugLog("autoCompact", "triggering", {
    estimatedTokens,
    threshold: getAutoCompactThreshold(model),
    consecutiveFailures: consecutiveAutoCompactFailures,
  });

  try {
    const result = await compactMessages(messages, undefined, {
      usage: options.usage,
      usageAnchorIndex: options.usageAnchorIndex,
      systemPrompt: options.systemPrompt,
      force: true,
    });
    consecutiveAutoCompactFailures = 0;
    return { result, didAutoCompact: result.didCompact };
  } catch (error) {
    consecutiveAutoCompactFailures++;
    debugLog("autoCompact", "failure", {
      error: error instanceof Error ? error.message : String(error),
      consecutiveFailures: consecutiveAutoCompactFailures,
    });
    return {
      result: { messages, didCompact: false, didMicroCompact: false },
      didAutoCompact: false,
    };
  }
}
