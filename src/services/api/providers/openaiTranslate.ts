/**
 * OpenAI translation — universal IR → Chat Completions `messages[]` and
 * Responses `input[]`.
 *
 * Extracted verbatim from providerStream.ts (二期 A2); behavior is unchanged.
 *
 * Why we rebuild the request shape by hand instead of trusting llm-bridge:
 *   llm-bridge's universal IR captures tool calls / results correctly (each
 *   tool_result keeps its tool_call_id). But `fromUniversal("openai" | "openai-
 *   responses", …)` mis-emits multi-turn tool history: it leaks the tool_call as
 *   a junk text block and drops the `role:"tool"` / `tool_call_id` pairing (or
 *   the function_call / function_call_output pairing on Responses), so the
 *   upstream rejects the follow-up turn with a 400. We therefore rebuild the
 *   request messages directly from the (correct) universal IR.
 */

import type { UniversalBody } from "llm-bridge";
import { resultToString } from "./translateShared.js";

/** Build a data: URL (or pass an http URL through) from universal media. */
function mediaToImageUrl(media: { url?: string; data?: string; mimeType?: string } | undefined): string | null {
  if (!media) return null;
  if (typeof media.url === "string" && media.url.length > 0) return media.url;
  if (typeof media.data === "string" && media.data.length > 0) {
    return `data:${media.mimeType ?? "image/png"};base64,${media.data}`;
  }
  return null;
}

function systemText(system: UniversalBody["system"]): string {
  if (!system) return "";
  return typeof system === "string" ? system : system.content ?? "";
}

interface OpenAIChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
type OpenAIChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };
interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | OpenAIChatContentPart[];
  tool_call_id?: string;
  tool_calls?: OpenAIChatToolCall[];
}

/** Build OpenAI Chat Completions `messages[]` from the universal IR. */
export function universalToOpenAIChatMessages(universal: UniversalBody): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = [];
  const sys = systemText(universal.system);
  if (sys) out.push({ role: "system", content: sys });

  for (const msg of universal.messages) {
    let text = "";
    const imageUrls: string[] = [];
    const toolCalls: OpenAIChatToolCall[] = [];
    const toolResults: Array<{ id: string; content: string }> = [];
    for (const part of msg.content ?? []) {
      if (part.type === "text" && typeof part.text === "string") {
        text += part.text;
      } else if (part.type === "image") {
        const url = mediaToImageUrl(part.media);
        if (url) imageUrls.push(url);
      } else if (part.type === "tool_call" && part.tool_call) {
        toolCalls.push({
          id: part.tool_call.id,
          type: "function",
          function: {
            name: part.tool_call.name,
            arguments: JSON.stringify(part.tool_call.arguments ?? {}),
          },
        });
      } else if (part.type === "tool_result" && part.tool_result) {
        toolResults.push({
          id: part.tool_result.tool_call_id,
          content: resultToString(part.tool_result.result),
        });
      }
      // thinking parts are intentionally dropped from OpenAI history.
    }

    if (msg.role === "system") {
      if (text) out.push({ role: "system", content: text });
    } else if (msg.role === "assistant") {
      // Assistants never emit images in this pipeline; keep text-only.
      const m: OpenAIChatMessage = {
        role: "assistant",
        content: toolCalls.length > 0 ? (text || null) : text,
      };
      if (toolCalls.length > 0) m.tool_calls = toolCalls;
      out.push(m);
    } else {
      // user (or tool) role: tool results must become standalone `tool`
      // messages answering the previous assistant's tool_calls, in order.
      for (const tr of toolResults) {
        out.push({ role: "tool", tool_call_id: tr.id, content: tr.content });
      }
      // Images ride along in the user turn as `image_url` content parts.
      if (imageUrls.length > 0) {
        const parts: OpenAIChatContentPart[] = [];
        if (text) parts.push({ type: "text", text });
        for (const url of imageUrls) parts.push({ type: "image_url", image_url: { url } });
        out.push({ role: "user", content: parts });
      } else if (text) {
        out.push({ role: "user", content: text });
      }
    }
  }
  return out;
}

type ResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string };
type ResponsesItem =
  | { role: "system" | "user" | "assistant"; content: string | ResponsesContentPart[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

/** Build OpenAI Responses `input[]` from the universal IR. */
export function universalToOpenAIResponsesInput(universal: UniversalBody): ResponsesItem[] {
  const out: ResponsesItem[] = [];
  const sys = systemText(universal.system);
  if (sys) out.push({ role: "system", content: sys });

  for (const msg of universal.messages) {
    let text = "";
    const imageUrls: string[] = [];
    const fnCalls: ResponsesItem[] = [];
    const fnOutputs: ResponsesItem[] = [];
    for (const part of msg.content ?? []) {
      if (part.type === "text" && typeof part.text === "string") {
        text += part.text;
      } else if (part.type === "image") {
        const url = mediaToImageUrl(part.media);
        if (url) imageUrls.push(url);
      } else if (part.type === "tool_call" && part.tool_call) {
        fnCalls.push({
          type: "function_call",
          call_id: part.tool_call.id,
          name: part.tool_call.name,
          arguments: JSON.stringify(part.tool_call.arguments ?? {}),
        });
      } else if (part.type === "tool_result" && part.tool_result) {
        fnOutputs.push({
          type: "function_call_output",
          call_id: part.tool_result.tool_call_id,
          output: resultToString(part.tool_result.result),
        });
      }
    }

    if (msg.role === "system") {
      if (text) out.push({ role: "system", content: text });
    } else if (msg.role === "assistant") {
      if (text) out.push({ role: "assistant", content: text });
      // The function_call item must precede its output and carry the call_id.
      for (const c of fnCalls) out.push(c);
    } else {
      for (const o of fnOutputs) out.push(o);
      if (imageUrls.length > 0) {
        const parts: ResponsesContentPart[] = [];
        if (text) parts.push({ type: "input_text", text });
        for (const url of imageUrls) parts.push({ type: "input_image", image_url: url });
        out.push({ role: "user", content: parts });
      } else if (text) {
        out.push({ role: "user", content: text });
      }
    }
  }
  return out;
}
