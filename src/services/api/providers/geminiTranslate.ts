/**
 * Gemini translation + native SSE parsing/assembly.
 *
 * Extracted verbatim from providerStream.ts (二期 A1); behavior is unchanged.
 *
 * Why Gemini gets bespoke code instead of leaning on llm-bridge:
 *   - llm-bridge's Gemini `contents` builder replays thinking blocks as
 *     fabricated unsigned `{thought:true}` parts (Gemini-3 rejects those) and
 *     drops/mis-aligns the per-functionCall `thoughtSignature` + call id.
 *   - llm-bridge's Gemini SSE parser discards the `thoughtSignature` that
 *     Gemini-3 requires echoed back on tool continuation.
 * So we build `contents[]` from our own Anthropic-shaped blocks and parse the
 * `streamGenerateContent?alt=sse` stream natively, preserving signatures + ids.
 */

import type { StreamRequestParams, StreamResult } from "../streaming.js";
import type {
  ContentBlock,
  StreamEvent,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  Usage,
} from "../../../types/message.js";
import { writeStreamDebug } from "../../../utils/streamDebug.js";
import { resultToString, normalizeStopReason } from "./translateShared.js";

interface GeminiFunctionCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}
interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: GeminiFunctionCall;
  functionResponse?: { name: string; id?: string; response: { output: string } };
  thoughtSignature?: string;
}
interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/** Build Gemini `contents[]` from our Anthropic-shaped message history. */
export function buildGeminiContents(messages: StreamRequestParams["messages"]): GeminiContent[] {
  const out: GeminiContent[] = [];
  const idToName = new Map<string, string>();

  for (const msg of messages) {
    const role: GeminiContent["role"] = msg.role === "assistant" ? "model" : "user";
    const parts: GeminiPart[] = [];
    const content = msg.content;

    if (typeof content === "string") {
      if (content.length > 0) parts.push({ text: content });
    } else if (Array.isArray(content)) {
      for (const raw of content) {
        const block = raw as {
          type?: string;
          text?: string;
          id?: string;
          name?: string;
          input?: Record<string, unknown>;
          thoughtSignature?: string;
          tool_use_id?: string;
          content?: unknown;
          source?: { type?: string; media_type?: string; data?: string; url?: string };
        };
        if (block.type === "text") {
          if (typeof block.text === "string" && block.text.length > 0) parts.push({ text: block.text });
        } else if (block.type === "image") {
          // Gemini takes inline base64 bytes. URL-sourced images are not
          // inlined here (our local image paths always produce base64).
          const src = block.source;
          if (src && src.type === "base64" && typeof src.data === "string" && src.data.length > 0) {
            parts.push({ inlineData: { mimeType: src.media_type ?? "image/png", data: src.data } });
          }
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          if (block.id) idToName.set(block.id, block.name);
          const part: GeminiPart = {
            functionCall: { name: block.name, args: block.input ?? {}, ...(block.id ? { id: block.id } : {}) },
          };
          // Echo back the exact signature Gemini gave for THIS call (if any).
          if (block.thoughtSignature) part.thoughtSignature = block.thoughtSignature;
          parts.push(part);
        } else if (block.type === "tool_result") {
          const name = (block.tool_use_id && idToName.get(block.tool_use_id)) || "";
          parts.push({
            functionResponse: {
              name,
              ...(block.tool_use_id ? { id: block.tool_use_id } : {}),
              response: { output: resultToString(block.content) },
            },
          });
        }
        // thinking / redacted_thinking blocks are intentionally NOT replayed.
      }
    }

    if (parts.length > 0) out.push({ role, parts });
  }
  return out;
}

function safeJson(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * True when Gemini rejected the request over a thoughtSignature problem. This
 * gateway/Gemini intermittently emits a *corrupted* signature and then refuses
 * it ("Corrupted thought signature"), and a missing one is refused too
 * ("missing thought_signature"). The signature we send is byte-identical to the
 * wire, so this is an upstream defect — we recover rather than retry blindly.
 */
export function isThoughtSignatureError(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes("thought_signature") || t.includes("thought signature");
}

/**
 * Flatten functionCall / functionResponse parts in a Gemini body into plain
 * text. Removes the thoughtSignature requirement entirely while preserving the
 * tool-call context, so a signature-rejected turn can be retried successfully.
 */
export function flattenGeminiToolHistory(body: Record<string, unknown>): void {
  const contents = body.contents;
  if (!Array.isArray(contents)) return;
  for (const content of contents) {
    const parts = (content as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) continue;
    (content as { parts: unknown[] }).parts = parts.map((p) => {
      const part = p as {
        functionCall?: { name?: string; args?: unknown };
        functionResponse?: { name?: string; response?: { output?: unknown } };
        thoughtSignature?: string;
        text?: string;
      };
      if (part.functionCall) {
        return { text: `[Called ${part.functionCall.name ?? "tool"}(${safeJson(part.functionCall.args ?? {})})]` };
      }
      if (part.functionResponse) {
        const output = part.functionResponse.response?.output ?? part.functionResponse.response;
        return { text: `[Result of ${part.functionResponse.name ?? "tool"}: ${safeJson(output)}]` };
      }
      if (part.thoughtSignature) {
        const { thoughtSignature, ...rest } = part;
        void thoughtSignature;
        return rest;
      }
      return part;
    });
  }
}

// ─── Gemini native SSE parsing (captures thoughtSignature; llm-bridge drops it) ──

type GeminiNativeEvent =
  | { type: "message_start"; id: string }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown>; thoughtSignature?: string }
  | { type: "message_end"; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } };

/**
 * Parse a Gemini `streamGenerateContent?alt=sse` stream. Unlike llm-bridge's
 * parser, this preserves the per-functionCall `thoughtSignature` (mandatory for
 * Gemini-3 tool continuation) and the model-supplied call id.
 */
async function* parseGeminiNative(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<GeminiNativeEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let started = false;
  let stopReason: string | undefined;
  let usage: { input_tokens?: number; output_tokens?: number } | undefined;

  const handleLine = function* (line: string): Generator<GeminiNativeEvent> {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!started) {
      started = true;
      const id = typeof json.responseId === "string" ? json.responseId : `gemini-${Date.now()}`;
      yield { type: "message_start", id };
    }
    const candidate = (json.candidates as Array<Record<string, unknown>> | undefined)?.[0];
    const parts = ((candidate?.content as Record<string, unknown> | undefined)?.parts) as
      | Array<Record<string, unknown>>
      | undefined;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        const fc = part.functionCall as { name?: string; args?: Record<string, unknown>; id?: string } | undefined;
        if (fc && typeof fc.name === "string") {
          yield {
            type: "tool_call",
            id: typeof fc.id === "string" && fc.id ? fc.id : `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: fc.name,
            args: fc.args ?? {},
            thoughtSignature: typeof part.thoughtSignature === "string" ? part.thoughtSignature : undefined,
          };
        } else if (typeof part.text === "string" && part.text.length > 0) {
          yield part.thought === true ? { type: "thinking", text: part.text } : { type: "text", text: part.text };
        }
      }
    }
    if (typeof candidate?.finishReason === "string") stopReason = candidate.finishReason;
    const um = json.usageMetadata as Record<string, unknown> | undefined;
    if (um) {
      usage = {
        input_tokens: typeof um.promptTokenCount === "number" ? um.promptTokenCount : usage?.input_tokens,
        output_tokens: typeof um.candidatesTokenCount === "number" ? um.candidatesTokenCount : usage?.output_tokens,
      };
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      yield* handleLine(line);
    }
  }
  if (buffer.trim()) yield* handleLine(buffer);
  yield { type: "message_end", stop_reason: stopReason, usage };
}

/**
 * Assemble a Gemini native stream into our StreamEvent sequence + StreamResult,
 * capturing each functionCall's thoughtSignature onto the tool_use block.
 */
export async function* assembleGemini(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent, StreamResult> {
  const contentBlocks: ContentBlock[] = [];
  let currentText: TextBlock | null = null;
  let currentThinking: ThinkingBlock | null = null;
  let messageId = "";
  let rawStopReason: string | undefined;
  const usage: Usage = { input_tokens: 0, output_tokens: 0 };

  for await (const event of parseGeminiNative(body)) {
    writeStreamDebug("provider_event", event);
    switch (event.type) {
      case "message_start": {
        messageId = event.id;
        yield { type: "message_start", messageId };
        break;
      }
      case "text": {
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
      case "tool_call": {
        if (currentThinking) {
          yield {
            type: "thinking_done",
            thinking: currentThinking.thinking,
            signature: currentThinking.signature,
          };
        }
        currentText = null;
        currentThinking = null;
        const block: ToolUseBlock = {
          type: "tool_use",
          id: event.id,
          name: event.name,
          input: event.args,
        };
        if (event.thoughtSignature) block.thoughtSignature = event.thoughtSignature;
        contentBlocks.push(block);
        yield { type: "tool_use_start", id: event.id, name: event.name };
        yield { type: "tool_use_input", id: event.id, partial_json: JSON.stringify(event.args ?? {}) };
        break;
      }
      case "message_end": {
        if (currentThinking) {
          yield {
            type: "thinking_done",
            thinking: currentThinking.thinking,
            signature: currentThinking.signature,
          };
          currentThinking = null;
        }
        rawStopReason = event.stop_reason;
        if (event.usage) {
          if (typeof event.usage.input_tokens === "number") usage.input_tokens = event.usage.input_tokens;
          if (typeof event.usage.output_tokens === "number") usage.output_tokens = event.usage.output_tokens;
        }
        break;
      }
    }
  }

  const hasToolUse = contentBlocks.some((b) => b.type === "tool_use");
  const stopReason = hasToolUse ? "tool_use" : normalizeStopReason(rawStopReason);
  yield { type: "message_done", stopReason, usage };

  writeStreamDebug("provider_assembled", {
    protocol: "gemini",
    stopReason,
    blockCount: contentBlocks.length,
  });

  return {
    assistantMessage: { role: "assistant", content: contentBlocks },
    usage,
    stopReason,
  };
}
