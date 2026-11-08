import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { harnessSetting } from "../harness/active.js";
import type { Usage } from "../types/message.js";

export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000;
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000;
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000;

const TEXT_CHARS_PER_TOKEN = 4;
const JSON_CHARS_PER_TOKEN = 2;
const MESSAGE_OVERHEAD_TOKENS = 12;
const TOOL_BLOCK_OVERHEAD_TOKENS = 24;
const FIXED_BINARY_BLOCK_TOKENS = 2_000;

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-4-20250514": 200_000,
  "claude-sonnet-4-20250514": 200_000,
  "claude-haiku-3-20250307": 200_000,
  "claude-3-5-sonnet-20241022": 200_000,
  "claude-3-5-haiku-20241022": 200_000,
  "claude-3-opus-20240229": 200_000,
};

/** The Agent's `compaction.contextWindow` when set (EASY_AGENT_MAX_CONTEXT_TOKENS), else the model's window. */
export function getContextWindowForModel(model: string): number {
  const configured = harnessSetting<number | undefined>("compaction.contextWindow");
  if (configured !== undefined) return configured;

  if (MODEL_CONTEXT_WINDOWS[model]) {
    return MODEL_CONTEXT_WINDOWS[model];
  }

  for (const [key, value] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (model.includes(key) || key.includes(model)) return value;
  }

  return MODEL_CONTEXT_WINDOW_DEFAULT;
}

export function getEffectiveContextWindowSize(model: string): number {
  const contextWindow = getContextWindowForModel(model);
  const reserved = Math.min(MAX_OUTPUT_TOKENS_FOR_SUMMARY, Math.floor(contextWindow * 0.2));
  return contextWindow - reserved;
}

function roughTokenCountEstimation(content: string, charsPerToken = TEXT_CHARS_PER_TOKEN): number {
  return Math.max(1, Math.round(content.length / charsPerToken));
}

/** Split `total` in proportion to `weights`; the parts are integers that add up to `total`. */
export function distributeTokens(total: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((acc, weight) => acc + Math.max(0, weight), 0);
  if (sum === 0) return weights.map((_, index) => (index === 0 ? total : 0));
  const exact = weights.map((weight) => (Math.max(0, weight) / sum) * total);
  const parts = exact.map(Math.floor);
  let rest = total - parts.reduce((acc, part) => acc + part, 0);
  const order = exact.map((value, index) => ({ index, remainder: value - Math.floor(value) }));
  order.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of order) {
    if (rest <= 0) break;
    parts[index]! += 1;
    rest -= 1;
  }
  return parts;
}

/** Estimated tokens of prompt text, zero for empty text. */
export function estimateTextTokens(text: string): number {
  return Math.max(0, Math.round(text.length / TEXT_CHARS_PER_TOKEN));
}

/** Estimated tokens of serialized JSON such as tool schemas, zero for an empty string. */
export function estimateJsonTokens(json: string): number {
  return Math.max(0, Math.round(json.length / JSON_CHARS_PER_TOKEN));
}

function estimateUnknownObjectTokens(value: unknown): number {
  return roughTokenCountEstimation(JSON.stringify(value ?? ""), JSON_CHARS_PER_TOKEN);
}

function estimateContentBlockTokens(content: MessageParam["content"]): number {
  if (typeof content === "string") {
    return roughTokenCountEstimation(content);
  }

  if (!Array.isArray(content)) {
    return 0;
  }

  return content.reduce((total, block) => {
    switch (block.type) {
      case "text":
        return total + roughTokenCountEstimation(block.text);
      case "tool_use":
        return (
          total +
          TOOL_BLOCK_OVERHEAD_TOKENS +
          roughTokenCountEstimation(block.name) +
          estimateUnknownObjectTokens(block.input)
        );
      case "tool_result": {
        const serialized =
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content?.filter((item) => (item as { type: string }).type !== "tool_reference"));
        return total + TOOL_BLOCK_OVERHEAD_TOKENS + roughTokenCountEstimation(serialized, JSON_CHARS_PER_TOKEN);
      }
      case "image":
      case "document":
        return total + FIXED_BINARY_BLOCK_TOKENS;
      default:
        return total + estimateUnknownObjectTokens(block);
    }
  }, 0);
}

export function estimateMessageTokens(message: MessageParam): number {
  return MESSAGE_OVERHEAD_TOKENS + estimateContentBlockTokens(message.content);
}

export function roughTokenCountEstimationForMessages(messages: readonly MessageParam[]): number {
  const rawEstimate = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  return Math.ceil((rawEstimate * 4) / 3);
}

export function estimateSystemPromptTokens(systemPrompt: string): number {
  return roughTokenCountEstimation(systemPrompt) + MESSAGE_OVERHEAD_TOKENS;
}

export function getTokenCountFromUsage(usage: Usage): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    usage.output_tokens
  );
}

/** Share of prompt input tokens served from the prompt cache, or null without cache activity. */
export function getCacheHitRate(usage: Usage): number | null {
  const read = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  if (read === 0 && write === 0) return null;
  return read / (usage.input_tokens + read + write);
}

/** `/cost` body. Cache lines appear only once the provider reports cache activity. */
export function formatSessionUsage(usage: Usage): string {
  const lines = ["Session usage", `- Input tokens: ${usage.input_tokens}`];
  const hitRate = getCacheHitRate(usage);
  if (hitRate !== null) {
    lines.push(
      `- Cache read tokens: ${usage.cache_read_input_tokens ?? 0}`,
      `- Cache write tokens: ${usage.cache_creation_input_tokens ?? 0}`,
      `- Cache hit rate: ${Math.round(hitRate * 100)}%`,
    );
  }
  lines.push(`- Output tokens: ${usage.output_tokens}`, `- Total tokens: ${getTokenCountFromUsage(usage)}`);
  return lines.join("\n");
}

export function tokenCountWithEstimation(
  messages: readonly MessageParam[],
  options?: { usage?: Usage; usageAnchorIndex?: number; systemPrompt?: string },
): number {
  const systemPromptTokens = options?.systemPrompt ? estimateSystemPromptTokens(options.systemPrompt) : 0;

  if (options?.usage && options.usageAnchorIndex !== undefined && options.usageAnchorIndex >= 0) {
    const suffix = messages.slice(options.usageAnchorIndex + 1);
    return getTokenCountFromUsage(options.usage) + roughTokenCountEstimationForMessages(suffix) + systemPromptTokens;
  }

  return roughTokenCountEstimationForMessages(messages) + systemPromptTokens;
}

export interface TokenBudgetSnapshot {
  estimatedConversationTokens: number;
  contextWindow: number;
  effectiveContextWindow: number;
  autoCompactThreshold: number;
  manualCompactThreshold: number;
}

function scaleBuffer(buffer: number, effectiveWindow: number): number {
  const referenceWindow = 180_000;
  if (effectiveWindow >= referenceWindow) return buffer;
  return Math.round(buffer * (effectiveWindow / referenceWindow));
}

/** Conversation size at which a request is refused as too long for the window. */
export function getBlockingLimit(model: string): number {
  const effective = getEffectiveContextWindowSize(model);
  return Math.max(0, effective - scaleBuffer(MANUAL_COMPACT_BUFFER_TOKENS, effective));
}

/**
 * Conversation size at which auto-compaction starts: the Agent's
 * `compaction.autoThreshold` share of the effective window (never past the
 * blocking limit), or a fixed buffer below the effective window.
 */
export function getAutoCompactThreshold(model: string): number {
  const effective = getEffectiveContextWindowSize(model);
  const fraction = harnessSetting<number | undefined>("compaction.autoThreshold");
  if (fraction !== undefined) return Math.min(Math.floor(effective * fraction), getBlockingLimit(model));
  return Math.max(0, effective - scaleBuffer(AUTOCOMPACT_BUFFER_TOKENS, effective));
}

export function buildTokenBudgetSnapshot(
  messages: readonly MessageParam[],
  options?: { usage?: Usage; usageAnchorIndex?: number; systemPrompt?: string; model?: string },
): TokenBudgetSnapshot {
  const estimatedConversationTokens = tokenCountWithEstimation(messages, options);
  const model = options?.model ?? harnessSetting<string>("model.main");
  return {
    estimatedConversationTokens,
    contextWindow: getContextWindowForModel(model),
    effectiveContextWindow: getEffectiveContextWindowSize(model),
    autoCompactThreshold: getAutoCompactThreshold(model),
    manualCompactThreshold: getBlockingLimit(model),
  };
}
