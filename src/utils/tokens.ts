import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { Usage } from "../types/message.js";

export const MODEL_CONTEXT_WINDOW = 200_000;
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000;

const TEXT_CHARS_PER_TOKEN = 4;
const JSON_CHARS_PER_TOKEN = 2;
const MESSAGE_OVERHEAD_TOKENS = 12;
const TOOL_BLOCK_OVERHEAD_TOKENS = 24;
const FIXED_BINARY_BLOCK_TOKENS = 2_000;

function roughTokenCountEstimation(content: string, charsPerToken = TEXT_CHARS_PER_TOKEN): number {
  return Math.max(1, Math.round(content.length / charsPerToken));
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
        const serialized = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
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

export function buildTokenBudgetSnapshot(
  messages: readonly MessageParam[],
  options?: { usage?: Usage; usageAnchorIndex?: number; systemPrompt?: string },
): TokenBudgetSnapshot {
  const estimatedConversationTokens = tokenCountWithEstimation(messages, options);
  const contextWindow = MODEL_CONTEXT_WINDOW;
  const effectiveContextWindow = contextWindow - 20_000;
  return {
    estimatedConversationTokens,
    contextWindow,
    effectiveContextWindow,
    autoCompactThreshold: effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS,
    manualCompactThreshold: effectiveContextWindow - MANUAL_COMPACT_BUFFER_TOKENS,
  };
}
