/**
 * OpenAI Responses API — native SSE parsing/assembly.
 *
 * Why the Responses API gets bespoke stream parsing instead of leaning on
 * llm-bridge: llm-bridge's `parseOpenAIResponsesStream` only recognizes
 * `response.output_text.delta` / `response.function_call_arguments.delta` /
 * `response.completed` (+ `response.output_item.added|done` for function
 * calls). It has no case for the reasoning-item lifecycle at all —
 * `response.output_item.added|done` with `item.type === "reasoning"` and
 * `response.reasoning_summary_text.delta|done` — so every reasoning-summary
 * event is silently dropped. That makes `/think` and `/effort` invisible for
 * `openai-responses` models: the request-side param is honored by the API
 * (confirmed against doc/CURL_EXAMPLES.md §2), but the response-side text
 * never reaches the UI, so the toggle looks like a no-op.
 *
 * This module parses the same stream natively and maps the reasoning-summary
 * delta text onto our existing `thinking` pipeline (already wired end-to-end
 * for Anthropic + Gemini), so the "✻ Thinking…" indicator and folded
 * thinking block work for `openai-responses` too.
 */

import type { StreamResult } from "../streaming.js";
import type {
  ContentBlock,
  StreamEvent,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  Usage,
} from "../../../types/message.js";
import { writeStreamDebug } from "../../../utils/streamDebug.js";
import { applyCachedPromptTokens, normalizeStopReason } from "./translateShared.js";

type OpenAIResponsesNativeEvent =
  | { type: "message_start"; id: string; model: string }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; argumentsDelta: string }
  | { type: "tool_call_end"; id: string }
  | {
      type: "message_end";
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number; reasoning_tokens?: number; cached_tokens?: number };
    }
  | { type: "error"; message: string };

/**
 * Parse a `POST /responses` `text/event-stream` body. Covers everything
 * llm-bridge's parser handles (message lifecycle, text deltas, function-call
 * start/delta/end, usage, error) and additionally surfaces the
 * reasoning-summary text stream as `thinking` events.
 */
async function* parseOpenAIResponsesNative(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<OpenAIResponsesNativeEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | undefined;
  let dataLines: string[] = [];
  // output_index → call_id, so a later `function_call_arguments.delta` (which
  // only carries output_index) can be routed to the right tool_call_start.
  const activeFunctionCalls = new Map<number, string>();
  let lastFunctionCallId: string | undefined;

  const handleEvent = function* (
    name: string | undefined,
    payload: string,
  ): Generator<OpenAIResponsesNativeEvent> {
    if (!payload || payload === "[DONE]") return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (name) {
      case "response.created": {
        const response = data.response as Record<string, unknown> | undefined;
        yield {
          type: "message_start",
          id: (response?.id as string) || (data.id as string) || "",
          model: (response?.model as string) || (data.model as string) || "",
        };
        break;
      }
      case "response.output_text.delta": {
        yield { type: "text", text: (data.delta as string) || "" };
        break;
      }
      case "response.reasoning_summary_text.delta": {
        yield { type: "thinking", text: (data.delta as string) || "" };
        break;
      }
      case "response.output_item.added": {
        const item = data.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
          const callId = (item.call_id as string) || (item.id as string) || "";
          const outputIndex = typeof data.output_index === "number" ? data.output_index : activeFunctionCalls.size;
          activeFunctionCalls.set(outputIndex, callId);
          lastFunctionCallId = callId;
          yield { type: "tool_call_start", id: callId, name: (item.name as string) || "" };
        }
        // item.type === "reasoning" needs no start signal — the first
        // `reasoning_summary_text.delta` lazily opens the thinking block,
        // mirroring how the Anthropic/Gemini paths handle it.
        break;
      }
      case "response.function_call_arguments.delta": {
        const outputIndex = typeof data.output_index === "number" ? data.output_index : undefined;
        const callId = (outputIndex !== undefined ? activeFunctionCalls.get(outputIndex) : undefined) || lastFunctionCallId;
        if (callId) {
          yield { type: "tool_call_delta", id: callId, argumentsDelta: (data.delta as string) || "" };
        }
        break;
      }
      case "response.output_item.done": {
        const item = data.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
          const outputIndex = typeof data.output_index === "number" ? data.output_index : undefined;
          const callId =
            (item.call_id as string) ||
            (item.id as string) ||
            (outputIndex !== undefined ? activeFunctionCalls.get(outputIndex) : undefined) ||
            "";
          yield { type: "tool_call_end", id: callId };
          if (outputIndex !== undefined) activeFunctionCalls.delete(outputIndex);
        }
        break;
      }
      case "response.completed": {
        const response = data.response as Record<string, unknown> | undefined;
        const usage = response?.usage as Record<string, unknown> | undefined;
        const details = usage?.output_tokens_details as Record<string, unknown> | undefined;
        const inputDetails = usage?.input_tokens_details as Record<string, unknown> | undefined;
        yield {
          type: "message_end",
          stop_reason: (response?.status as string) || "completed",
          ...(usage
            ? {
                usage: {
                  input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
                  output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
                  reasoning_tokens: typeof details?.reasoning_tokens === "number" ? details.reasoning_tokens : undefined,
                  cached_tokens: typeof inputDetails?.cached_tokens === "number" ? inputDetails.cached_tokens : undefined,
                },
              }
            : {}),
        };
        break;
      }
      case "error": {
        const error = data.error as Record<string, unknown> | undefined;
        yield {
          type: "error",
          message: (error?.message as string) || (data.message as string) || "Unknown error",
        };
        break;
      }
      default:
        // response.reasoning_summary_part.added|done,
        // response.output_item.added (type: "message"), etc. — no-ops.
        break;
    }
  };

  const flushEvent = function* (): Generator<OpenAIResponsesNativeEvent> {
    if (dataLines.length === 0) {
      eventName = undefined;
      return;
    }
    yield* handleEvent(eventName, dataLines.join("\n"));
    eventName = undefined;
    dataLines = [];
  };

  const handleLine = function* (line: string): Generator<OpenAIResponsesNativeEvent> {
    if (line === "") {
      yield* flushEvent();
      return;
    }
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
    // Ignore SSE comment lines (":") and any other field (id:, retry:).
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      yield* handleLine(line);
    }
  }
  if (buffer.trim()) yield* handleLine(buffer.replace(/\r$/, ""));
  yield* flushEvent();
}

/**
 * Assemble a native Responses stream into our `StreamEvent` sequence +
 * `StreamResult`, mirroring `streamViaProvider`'s generic loop but with
 * reasoning-summary text folded onto `ThinkingBlock`s.
 */
export async function* assembleOpenAIResponses(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent, StreamResult> {
  const contentBlocks: ContentBlock[] = [];
  const toolInputJsonById = new Map<string, string>();
  const toolBlockById = new Map<string, ToolUseBlock>();
  let currentText: TextBlock | null = null;
  let currentThinking: ThinkingBlock | null = null;
  let messageId = "";
  let rawStopReason: string | undefined;
  const usage: Usage = { input_tokens: 0, output_tokens: 0 };

  const finalizeToolInput = (block: ToolUseBlock | undefined, accumulated: string | undefined): void => {
    if (!block || !accumulated || accumulated.trim().length === 0) return;
    try {
      block.input = JSON.parse(accumulated);
    } catch {
      block.input = { _raw: accumulated };
    }
  };

  for await (const event of parseOpenAIResponsesNative(body)) {
    writeStreamDebug("provider_event", event);
    switch (event.type) {
      case "message_start": {
        messageId = event.id;
        yield { type: "message_start", messageId };
        break;
      }
      case "text": {
        if (!event.text) break;
        if (!currentText) {
          currentText = { type: "text", text: "" };
          contentBlocks.push(currentText);
          currentThinking = null;
        }
        currentText.text += event.text;
        yield { type: "text", text: event.text };
        break;
      }
      case "thinking": {
        if (!event.text) break;
        if (!currentThinking) {
          currentThinking = { type: "thinking", thinking: "" };
          contentBlocks.push(currentThinking);
          currentText = null;
          yield { type: "thinking_start" };
        }
        currentThinking.thinking += event.text;
        yield { type: "thinking_delta", thinking: event.text };
        break;
      }
      case "tool_call_start": {
        if (currentThinking) {
          yield { type: "thinking_done", thinking: currentThinking.thinking, signature: currentThinking.signature };
          currentThinking = null;
        }
        currentText = null;
        const block: ToolUseBlock = { type: "tool_use", id: event.id, name: event.name, input: {} };
        contentBlocks.push(block);
        toolBlockById.set(event.id, block);
        toolInputJsonById.set(event.id, "");
        yield { type: "tool_use_start", id: event.id, name: event.name };
        break;
      }
      case "tool_call_delta": {
        const prev = toolInputJsonById.get(event.id) ?? "";
        toolInputJsonById.set(event.id, prev + event.argumentsDelta);
        yield { type: "tool_use_input", id: event.id, partial_json: event.argumentsDelta };
        break;
      }
      case "tool_call_end": {
        finalizeToolInput(toolBlockById.get(event.id), toolInputJsonById.get(event.id));
        break;
      }
      case "message_end": {
        if (currentThinking) {
          yield { type: "thinking_done", thinking: currentThinking.thinking, signature: currentThinking.signature };
          currentThinking = null;
        }
        rawStopReason = event.stop_reason;
        if (event.usage) {
          if (typeof event.usage.input_tokens === "number") usage.input_tokens = event.usage.input_tokens;
          if (typeof event.usage.output_tokens === "number") usage.output_tokens = event.usage.output_tokens;
          applyCachedPromptTokens(usage, event.usage.cached_tokens);
        }
        break;
      }
      case "error": {
        throw new Error(event.message || "Provider stream error");
      }
    }
  }

  for (const [id, block] of toolBlockById) {
    finalizeToolInput(block, toolInputJsonById.get(id));
  }

  const hasToolUse = contentBlocks.some((b) => b.type === "tool_use");
  const stopReason = hasToolUse ? "tool_use" : normalizeStopReason(rawStopReason);

  yield { type: "message_done", stopReason, usage };

  writeStreamDebug("provider_assembled", {
    protocol: "openai-responses",
    stopReason,
    blockCount: contentBlocks.length,
  });

  return {
    assistantMessage: { role: "assistant", content: contentBlocks },
    usage,
    stopReason,
  };
}
