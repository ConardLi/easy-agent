/**
 * Streaming — AsyncGenerator wrapper over the Anthropic streaming API.
 *
 * Reference: claude-code-source-code/src/services/api/claude.ts
 * The original iterates `for await (const part of stream)` and switches
 * on `part.type` (message_start, content_block_start, content_block_delta,
 * content_block_stop, message_delta, message_stop). We replicate that
 * pattern but yield our own simplified StreamEvent union.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { getAnthropicClient, DEFAULT_MODEL, DEFAULT_MAX_TOKENS } from "./client.js";
import type {
  AssistantMessage,
  ContentBlock,
  StreamEvent,
  TextBlock,
  ToolUseBlock,
  Usage,
} from "../../types/message.js";

// ─── Request Parameters ────────────────────────────────────────────

export interface StreamRequestParams {
  messages: MessageParam[];
  model?: string;
  maxTokens?: number;
  system?: string;
  tools?: Anthropic.Tool[];
  signal?: AbortSignal;
}

// ─── Streaming Result ──────────────────────────────────────────────

export interface StreamResult {
  assistantMessage: AssistantMessage;
  usage: Usage;
  stopReason: string;
}

// ─── Core Streaming Function ───────────────────────────────────────

/**
 * Send a streaming request to the Anthropic API and yield StreamEvents.
 *
 * This is the main communication primitive — everything else builds on top.
 * The generator yields incremental events as they arrive (text deltas,
 * tool_use blocks, etc.) and accumulates the full response internally.
 *
 * After the generator completes, call `.return()` value is undefined —
 * the final assembled message is yielded as a `message_done` event
 * containing the usage stats.
 */
export async function* streamMessage(
  params: StreamRequestParams,
): AsyncGenerator<StreamEvent, StreamResult> {
  const client = getAnthropicClient();
  const model = params.model ?? DEFAULT_MODEL;
  const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;

  // Build the API request
  const requestParams: Anthropic.MessageCreateParamsStreaming = {
    model,
    max_tokens: maxTokens,
    messages: params.messages,
    stream: true,
    ...(params.system && { system: params.system }),
    ...(params.tools && params.tools.length > 0 && { tools: params.tools }),
  };

  // Initiate the stream
  const stream = client.messages.stream(requestParams, {
    signal: params.signal,
  });

  // State accumulators — mirrors the pattern in claude.ts
  const contentBlocks: ContentBlock[] = [];
  let currentBlockIndex = -1;
  let currentToolInputJson = "";
  let messageId = "";
  let stopReason = "";

  const usage: Usage = {
    input_tokens: 0,
    output_tokens: 0,
  };

  try {
    for await (const event of stream) {
      switch (event.type) {
        // ── Message lifecycle ──────────────────────────────
        case "message_start": {
          messageId = event.message.id;
          // Capture initial usage (input token count)
          if (event.message.usage) {
            usage.input_tokens = event.message.usage.input_tokens;
            usage.output_tokens = event.message.usage.output_tokens;
          }
          yield { type: "message_start", messageId };
          break;
        }

        case "message_delta": {
          // Final usage update + stop reason
          if (event.usage) {
            usage.output_tokens = event.usage.output_tokens;
          }
          stopReason = event.delta.stop_reason ?? "";
          break;
        }

        case "message_stop": {
          // Stream complete — yield the final done event
          yield { type: "message_done", stopReason, usage };
          break;
        }

        // ── Content block lifecycle ────────────────────────
        case "content_block_start": {
          currentBlockIndex = event.index;

          if (event.content_block.type === "text") {
            contentBlocks[currentBlockIndex] = {
              type: "text",
              text: "",
            };
          } else if (event.content_block.type === "tool_use") {
            const block = event.content_block;
            contentBlocks[currentBlockIndex] = {
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: {},
            };
            currentToolInputJson = "";
            yield { type: "tool_use_start", id: block.id, name: block.name };
          }
          break;
        }

        case "content_block_delta": {
          const delta = event.delta;

          if (delta.type === "text_delta") {
            // Accumulate text
            const block = contentBlocks[event.index] as TextBlock;
            block.text += delta.text;
            yield { type: "text", text: delta.text };
          } else if (delta.type === "input_json_delta") {
            // Accumulate tool input JSON
            currentToolInputJson += delta.partial_json;
            yield {
              type: "tool_use_input",
              id: (contentBlocks[event.index] as ToolUseBlock).id,
              partial_json: delta.partial_json,
            };
          }
          break;
        }

        case "content_block_stop": {
          // Parse the accumulated JSON for tool_use blocks
          const block = contentBlocks[event.index];
          if (block && block.type === "tool_use" && currentToolInputJson) {
            try {
              block.input = JSON.parse(currentToolInputJson);
            } catch {
              block.input = { _raw: currentToolInputJson };
            }
            currentToolInputJson = "";
          }
          break;
        }
      }
    }
  } catch (error) {
    // Yield the error as a stream event so the caller can handle it
    yield {
      type: "error",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  // Return the fully assembled assistant message
  return {
    assistantMessage: {
      role: "assistant",
      content: contentBlocks.filter((block): block is ContentBlock => Boolean(block)),
    },
    usage,
    stopReason,
  };
}

// ─── Convenience: Non-streaming single-shot ────────────────────────

/**
 * Simple non-streaming call for quick one-off requests.
 * Useful for internal tasks (compaction, classification) where
 * we don't need incremental output.
 */
export async function createMessage(
  params: Omit<StreamRequestParams, "signal">,
): Promise<{ content: ContentBlock[]; usage: Usage; stopReason: string }> {
  const client = getAnthropicClient();
  const model = params.model ?? DEFAULT_MODEL;
  const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    messages: params.messages,
    ...(params.system && { system: params.system }),
    ...(params.tools && params.tools.length > 0 && { tools: params.tools }),
  });

  const contentBlocks: ContentBlock[] = response.content.map((block) => {
    if (block.type === "text") {
      return { type: "text" as const, text: block.text };
    } else if (block.type === "tool_use") {
      return {
        type: "tool_use" as const,
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      };
    }
    return { type: "text" as const, text: "" };
  });

  return {
    content: contentBlocks,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
    stopReason: response.stop_reason ?? "end_turn",
  };
}
