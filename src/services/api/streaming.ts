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
import {
  getAnthropicClient,
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  ESCALATED_MAX_TOKENS,
  MAX_OUTPUT_TOKENS_RECOVERY_LIMIT,
} from "./client.js";
import type {
  AssistantMessage,
  ContentBlock,
  StreamEvent,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  Usage,
} from "../../types/message.js";
import { writeStreamDebug } from "../../utils/streamDebug.js";

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

  // State accumulators — mirrors the pattern in claude.ts.
  //
  // IMPORTANT: tool_use input JSON must be tracked *per content-block index*.
  // A single shared string breaks as soon as two tool_use blocks overlap —
  // e.g. provider emits `content_block_start` for block 1 before the
  // `content_block_stop` of block 0. In that case the shared buffer gets
  // reset / cross-populated and tools end up with empty or swapped inputs.
  const contentBlocks: ContentBlock[] = [];
  const toolInputJsonByIndex = new Map<number, string>();
  let messageId = "";
  let stopReason = "";

  const usage: Usage = {
    input_tokens: 0,
    output_tokens: 0,
  };

  writeStreamDebug("request", {
    model,
    messageCount: params.messages.length,
    toolNames: params.tools?.map((t) => t.name),
  });

  try {
    for await (const event of stream) {
      writeStreamDebug("event", event);
      switch (event.type) {
        // ── Message lifecycle ──────────────────────────────
        case "message_start": {
          messageId = event.message.id;
          // Capture initial usage (input token count + cache tokens)
          if (event.message.usage) {
            usage.input_tokens = event.message.usage.input_tokens;
            usage.output_tokens = event.message.usage.output_tokens;
            const u = event.message.usage as unknown as Record<string, unknown>;
            if (typeof u.cache_creation_input_tokens === "number") {
              usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
            }
            if (typeof u.cache_read_input_tokens === "number") {
              usage.cache_read_input_tokens = u.cache_read_input_tokens;
            }
          }
          yield { type: "message_start", messageId };
          break;
        }

        case "message_delta": {
          // Final usage update + stop reason
          if (event.usage) {
            usage.output_tokens = event.usage.output_tokens;
            // Some providers (e.g. MiniMax) report input_tokens in message_delta
            // rather than message_start — pick it up as a fallback.
            const du = event.usage as unknown as Record<string, unknown>;
            if (typeof du.input_tokens === "number" && du.input_tokens > 0) {
              usage.input_tokens = du.input_tokens;
            }
            if (typeof du.cache_creation_input_tokens === "number") {
              usage.cache_creation_input_tokens = du.cache_creation_input_tokens;
            }
            if (typeof du.cache_read_input_tokens === "number") {
              usage.cache_read_input_tokens = du.cache_read_input_tokens;
            }
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
          const index = event.index;

          if (event.content_block.type === "text") {
            contentBlocks[index] = {
              type: "text",
              text: "",
            };
          } else if (event.content_block.type === "thinking") {
            // Preserve thinking blocks so we can echo them (with their
            // signature) back to the model on the next turn. Some providers
            // (e.g. MiniMax) and Anthropic's extended-thinking mode will
            // behave erratically — duplicating tool calls or emitting empty
            // inputs — if the prior turn's thinking is missing from history.
            const tb = event.content_block as { thinking?: string };
            contentBlocks[index] = {
              type: "thinking",
              thinking: tb.thinking ?? "",
            };
          } else if (event.content_block.type === "tool_use") {
            const block = event.content_block;
            // Some providers pre-populate the full input object on start
            // instead of streaming it via input_json_delta. Preserve whatever
            // is already there so we don't overwrite a valid non-empty input
            // with `{}` at content_block_stop.
            const seedInput =
              block.input && typeof block.input === "object"
                ? (block.input as Record<string, unknown>)
                : {};
            contentBlocks[index] = {
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: seedInput,
            };
            toolInputJsonByIndex.set(index, "");
            yield { type: "tool_use_start", id: block.id, name: block.name };
          }
          break;
        }

        case "content_block_delta": {
          const delta = event.delta;
          const index = event.index;

          if (delta.type === "text_delta") {
            // Accumulate text
            const block = contentBlocks[index] as TextBlock;
            block.text += delta.text;
            yield { type: "text", text: delta.text };
          } else if ((delta as { type: string }).type === "thinking_delta") {
            const block = contentBlocks[index] as ThinkingBlock | undefined;
            if (block && block.type === "thinking") {
              block.thinking += (delta as unknown as { thinking: string }).thinking ?? "";
            }
          } else if ((delta as { type: string }).type === "signature_delta") {
            const block = contentBlocks[index] as ThinkingBlock | undefined;
            if (block && block.type === "thinking") {
              const sig = (delta as unknown as { signature: string }).signature;
              block.signature = (block.signature ?? "") + (sig ?? "");
            }
          } else if (delta.type === "input_json_delta") {
            // Accumulate tool input JSON **per block index** — blocks may
            // overlap on some providers, so we must never share one buffer.
            const prev = toolInputJsonByIndex.get(index) ?? "";
            toolInputJsonByIndex.set(index, prev + delta.partial_json);
            const idBlock = contentBlocks[index];
            if (idBlock && idBlock.type === "tool_use") {
              yield {
                   type: "tool_use_input",
                id: (idBlock as ToolUseBlock).id,
                partial_json: delta.partial_json,
              };
            }
          }
          break;
        }

        case "content_block_stop": {
          const index = event.index;
          const block = contentBlocks[index];
          const accumulated = toolInputJsonByIndex.get(index);
          if (block && block.type === "tool_use" && accumulated) {
            try {
              block.input = JSON.parse(accumulated);
            } catch {
              // Keep the raw string so callers can surface it for debugging
              // rather than silently pretending the call had no input.
              block.input = { _raw: accumulated };
            }
          }
          toolInputJsonByIndex.delete(index);
          break;
        }
      }
    }
  } catch (error) {
    writeStreamDebug("stream_error", { message: error instanceof Error ? error.message : String(error) });
    // Yield the error as a stream event so the caller can handle it
    yield {
      type: "error",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  writeStreamDebug("assembled", {
    stopReason,
    blockCount: contentBlocks.filter(Boolean).length,
    blocks: contentBlocks.filter(Boolean).map((b) => {
      if (b.type === "tool_use") {
        return { type: "tool_use", id: b.id, name: b.name, input: b.input };
      }
      if (b.type === "thinking") {
        return {
          type: "thinking",
          length: (b as ThinkingBlock).thinking.length,
          hasSignature: Boolean((b as ThinkingBlock).signature),
        };
      }
      return { type: "text", length: (b as TextBlock).text.length };
    }),
  });

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

  const usageResult: Usage = {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
  };
  const ru = response.usage as unknown as Record<string, unknown>;
  if (typeof ru.cache_creation_input_tokens === "number") {
    usageResult.cache_creation_input_tokens = ru.cache_creation_input_tokens;
  }
  if (typeof ru.cache_read_input_tokens === "number") {
    usageResult.cache_read_input_tokens = ru.cache_read_input_tokens;
  }

  return {
    content: contentBlocks,
    usage: usageResult,
    stopReason: response.stop_reason ?? "end_turn",
  };
}

/**
 * Stream with automatic escalated retry when output is truncated.
 *
 * If the model hits max_tokens, retries once with ESCALATED_MAX_TOKENS (64k).
 * If still truncated, injects a continuation message up to
 * MAX_OUTPUT_TOKENS_RECOVERY_LIMIT times.
 */
export async function* streamMessageWithRetry(
  params: StreamRequestParams,
): AsyncGenerator<StreamEvent, StreamResult> {
  const stream = streamMessage(params);
  const events: StreamEvent[] = [];

  while (true) {
    const { value, done } = await stream.next();
    if (done) {
      const result = value;
      if (!result) {
        return { assistantMessage: { role: "assistant", content: [] }, usage: { input_tokens: 0, output_tokens: 0 }, stopReason: "error" } as StreamResult;
      }

      if (result.stopReason !== "max_tokens") {
        return result;
      }

      // Escalated retry with 64K
      const escalatedStream = streamMessage({
        ...params,
        maxTokens: ESCALATED_MAX_TOKENS,
      });
      const escalatedEvents: StreamEvent[] = [];
      while (true) {
        const esc = await escalatedStream.next();
        if (esc.done) {
          const escalatedResult = esc.value;
          if (!escalatedResult) {
            return result;
          }
          if (escalatedResult.stopReason !== "max_tokens") {
            for (const ev of escalatedEvents) yield ev;
            return escalatedResult;
          }
          // Still truncated — return what we have, caller can do multi-turn recovery
          for (const ev of escalatedEvents) yield ev;
          return escalatedResult;
        }
        escalatedEvents.push(esc.value);
      }
    }
    events.push(value);
    yield value;
  }
}
