/**
 * Provider streaming — the non-Anthropic edge.
 *
 * Strategy: keep the entire upper stack speaking Anthropic. For a profile whose
 * protocol is OpenAI (Chat or Responses) or Gemini, we:
 *
 *   1. Build an Anthropic request from the (already Anthropic-shaped) params and
 *      translate it to the target protocol with `llm-bridge` (zero-dependency,
 *      handles messages / tools / thinking / multimodal).
 *   2. `fetch` the provider's streaming endpoint directly — so retries, abort,
 *      and error classification stay under our control (reused from streaming.ts).
 *   3. Parse the provider SSE stream back into `llm-bridge` universal events and
 *      map them onto our normalized `StreamEvent` union + assembled message.
 *
 * The output is byte-for-byte the same `StreamEvent` sequence + `StreamResult`
 * the Anthropic path produces, so agenticLoop / tools / UI need zero changes.
 */

import {
  toUniversal,
  fromUniversal,
  parseOpenAIStream,
  parseOpenAIResponsesStream,
  parseGoogleStream,
  type ProviderType,
  type UniversalStreamEvent,
  type UniversalBody,
  type AnthropicBody,
} from "llm-bridge";
import { APIError } from "@anthropic-ai/sdk";

import { DEFAULT_MAX_TOKENS } from "../client.js";
import type { StreamRequestParams, StreamResult } from "../streaming.js";
import type { ModelProfile } from "./profile.js";
import type {
  ContentBlock,
  StreamEvent,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  Usage,
} from "../../../types/message.js";
import { writeStreamDebug } from "../../../utils/streamDebug.js";

// ─── Protocol → llm-bridge provider + endpoint defaults ────────────────────

const LLM_BRIDGE_PROVIDER: Record<
  Exclude<ModelProfile["protocol"], "anthropic">,
  ProviderType
> = {
  "openai-chat": "openai",
  "openai-responses": "openai-responses",
  gemini: "google",
};

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

interface PreparedRequest {
  provider: ProviderType;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

// ─── Tool-aware message rebuild (works around llm-bridge emitter bugs) ──────
//
// llm-bridge's universal IR captures tool calls / results correctly (each
// tool_result keeps its tool_call_id). But `fromUniversal("openai" | "openai-
// responses", …)` mis-emits multi-turn tool history: it leaks the tool_call as
// a junk text block and drops the `role:"tool"` / `tool_call_id` pairing, so the
// upstream rejects the follow-up turn with a 400. We therefore rebuild the
// OpenAI request messages directly from the (correct) universal IR.

/** Flatten a tool result (string | content-block array | object) to text. */
function resultToString(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    return result
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return JSON.stringify(part);
      })
      .join("\n");
  }
  return JSON.stringify(result);
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
interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: OpenAIChatToolCall[];
}

/** Build OpenAI Chat Completions `messages[]` from the universal IR. */
function universalToOpenAIChatMessages(universal: UniversalBody): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = [];
  const sys = systemText(universal.system);
  if (sys) out.push({ role: "system", content: sys });

  for (const msg of universal.messages) {
    let text = "";
    const toolCalls: OpenAIChatToolCall[] = [];
    const toolResults: Array<{ id: string; content: string }> = [];
    for (const part of msg.content ?? []) {
      if (part.type === "text" && typeof part.text === "string") {
        text += part.text;
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
      // thinking / media parts are intentionally dropped from OpenAI history.
    }

    if (msg.role === "system") {
      if (text) out.push({ role: "system", content: text });
    } else if (msg.role === "assistant") {
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
      if (text) out.push({ role: "user", content: text });
    }
  }
  return out;
}

type ResponsesItem =
  | { role: "system" | "user" | "assistant"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

/** Build OpenAI Responses `input[]` from the universal IR. */
function universalToOpenAIResponsesInput(universal: UniversalBody): ResponsesItem[] {
  const out: ResponsesItem[] = [];
  const sys = systemText(universal.system);
  if (sys) out.push({ role: "system", content: sys });

  for (const msg of universal.messages) {
    let text = "";
    const fnCalls: ResponsesItem[] = [];
    const fnOutputs: ResponsesItem[] = [];
    for (const part of msg.content ?? []) {
      if (part.type === "text" && typeof part.text === "string") {
        text += part.text;
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
      if (text) out.push({ role: "user", content: text });
    }
  }
  return out;
}

// ─── Gemini-3 contents builder (1:1 from our blocks; llm-bridge is unreliable) ──
//
// llm-bridge's Gemini translation has two history-breaking defects:
//   1. It replays a captured thinking block as a `{thought:true,text}` part with
//      NO thoughtSignature — Gemini-3 rejects unsigned/fabricated thought parts.
//   2. Its functionCall parts omit the call id, and re-attaching signatures by
//      global index drifts (parallel calls often sign only the first call).
//
// So for Gemini we build `contents` directly from our own message blocks: drop
// thinking from history, and attach each tool_use block's OWN thoughtSignature
// and id to its OWN functionCall part (no index alignment, no fabrication).

interface GeminiFunctionCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}
interface GeminiPart {
  text?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: { name: string; id?: string; response: { output: string } };
  thoughtSignature?: string;
}
interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/** Build Gemini `contents[]` from our Anthropic-shaped message history. */
function buildGeminiContents(messages: StreamRequestParams["messages"]): GeminiContent[] {
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
        };
        if (block.type === "text") {
          if (typeof block.text === "string" && block.text.length > 0) parts.push({ text: block.text });
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
function isThoughtSignatureError(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes("thought_signature") || t.includes("thought signature");
}

/**
 * Flatten functionCall / functionResponse parts in a Gemini body into plain
 * text. Removes the thoughtSignature requirement entirely while preserving the
 * tool-call context, so a signature-rejected turn can be retried successfully.
 */
function flattenGeminiToolHistory(body: Record<string, unknown>): void {
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
async function* assembleGemini(
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
        }
        currentThinking.thinking += event.text;
        break;
      }
      case "tool_call": {
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

/** Translate Anthropic-shaped params into a ready-to-fetch provider request. */
function prepareRequest(profile: ModelProfile, params: StreamRequestParams): PreparedRequest {
  if (profile.protocol === "anthropic") {
    // Defensive: callers route anthropic elsewhere. Keep the type total.
    throw new Error("prepareRequest called with anthropic profile");
  }
  const provider = LLM_BRIDGE_PROVIDER[profile.protocol];

  const anthropicBody = {
    model: profile.model,
    max_tokens: profile.maxTokens ?? params.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: params.messages,
    ...(params.system ? { system: params.system } : {}),
    ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
    ...(params.toolChoice ? { tool_choice: params.toolChoice } : {}),
  } as unknown as AnthropicBody;

  const universal = toUniversal("anthropic", anthropicBody);
  const translated = fromUniversal(provider, universal) as unknown as Record<string, unknown>;

  const extraHeaders = profile.headers ?? {};

  if (profile.protocol === "gemini") {
    // Rebuild `contents` from our own blocks so each functionCall keeps its
    // exact thoughtSignature + id and thinking parts are not fabricated back
    // (llm-bridge mishandles both, breaking Gemini-3 multi/parallel tool turns).
    translated.contents = buildGeminiContents(params.messages);
    const base = stripTrailingSlash(profile.baseURL ?? DEFAULT_GEMINI_BASE_URL);
    const url = `${base}/models/${encodeURIComponent(profile.model)}:streamGenerateContent?alt=sse`;
    return {
      provider,
      url,
      headers: {
        "content-type": "application/json",
        ...(profile.apiKey ? { "x-goog-api-key": profile.apiKey } : {}),
        ...extraHeaders,
      },
      body: translated,
    };
  }

  // OpenAI Chat Completions / Responses
  const base = stripTrailingSlash(profile.baseURL ?? DEFAULT_OPENAI_BASE_URL);
  const path = profile.protocol === "openai-responses" ? "/responses" : "/chat/completions";
  const body: Record<string, unknown> = { ...translated, stream: true };
  if (profile.protocol === "openai-responses") {
    // Rebuild `input[]` from the universal IR so multi-turn tool calls keep
    // their function_call / function_call_output pairing (llm-bridge drops it).
    body.input = universalToOpenAIResponsesInput(universal);
  } else {
    // openai-chat: rebuild `messages[]` so tool results become `role:"tool"`
    // messages carrying tool_call_id (llm-bridge mis-emits these).
    body.messages = universalToOpenAIChatMessages(universal);
    // Ask for a final usage chunk so token accounting matches the Anthropic path.
    body.stream_options = { include_usage: true };
  }
  return {
    provider,
    url: base + path,
    headers: {
      "content-type": "application/json",
      ...(profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}),
      ...extraHeaders,
    },
    body,
  };
}

/** Parse accumulated tool-call argument JSON into a block's `input`. */
function finalizeToolInput(block: ToolUseBlock | undefined, accumulated: string | undefined): void {
  if (!block || !accumulated || accumulated.trim().length === 0) return;
  try {
    block.input = JSON.parse(accumulated);
  } catch {
    block.input = { _raw: accumulated };
  }
}

function parserFor(provider: ProviderType): (s: ReadableStream) => AsyncGenerator<UniversalStreamEvent> {
  switch (provider) {
    case "openai":
      return parseOpenAIStream;
    case "openai-responses":
      return parseOpenAIResponsesStream;
    case "google":
      return parseGoogleStream;
    default:
      // "anthropic" never reaches here.
      return parseOpenAIStream;
  }
}

/** Normalize a provider/universal stop reason to the Anthropic vocabulary. */
function normalizeStopReason(raw: string | undefined): string {
  // Providers disagree on casing — Gemini emits uppercase (STOP, MAX_TOKENS),
  // OpenAI lowercase (stop, length). Fold to lowercase before matching.
  switch (raw?.toLowerCase()) {
    case "tool_use":
    case "tool_calls":
      return "tool_use";
    case "max_tokens":
    case "length":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    case "end_turn":
    case "stop":
    case undefined:
    case "":
      return "end_turn";
    default:
      return raw ?? "end_turn";
  }
}

// ─── Core: one streaming attempt against a non-Anthropic provider ──────────

/**
 * One streaming attempt. Yields the same `StreamEvent`s as the Anthropic path
 * and returns the assembled `StreamResult`. Errors propagate (NOT swallowed) so
 * the shared retry wrapper in streaming.ts can decide whether to re-issue.
 */
export async function* streamViaProvider(
  profile: ModelProfile,
  params: StreamRequestParams,
): AsyncGenerator<StreamEvent, StreamResult> {
  const prepared = prepareRequest(profile, params);

  writeStreamDebug("provider_request", {
    protocol: profile.protocol,
    model: profile.model,
    url: prepared.url,
    messageCount: params.messages.length,
    toolNames: params.tools?.map((t) => t.name),
  });

  let response = await fetch(prepared.url, {
    method: "POST",
    headers: prepared.headers,
    body: JSON.stringify(prepared.body),
    signal: params.signal,
  });

  // Gemini-3 self-heal: when the upstream rejects the request over a
  // thoughtSignature (corrupted/missing — see isThoughtSignatureError), retry
  // once with the tool history flattened to text. Without this, the signature
  // error surfaces as a 429 and the generic retry loop re-issues the SAME bad
  // request up to 10× (the "Rate limit" retry storm the user saw).
  if (prepared.provider === "google" && !response.ok) {
    const errText = await response.text().catch(() => "");
    if (isThoughtSignatureError(errText)) {
      writeStreamDebug("gemini_signature_recovery", { status: response.status });
      flattenGeminiToolHistory(prepared.body);
      response = await fetch(prepared.url, {
        method: "POST",
        headers: prepared.headers,
        body: JSON.stringify(prepared.body),
        signal: params.signal,
      });
    } else {
      // Unrelated failure — surface it through the normal APIError path.
      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = errText ? (JSON.parse(errText) as Record<string, unknown>) : undefined;
      } catch {
        /* keep raw text */
      }
      throw APIError.generate(response.status, parsed, errText || response.statusText, response.headers);
    }
  }

  if (!response.ok || !response.body) {
    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch {
      /* ignore */
    }
    let parsedBody: Record<string, unknown> | undefined;
    try {
      parsedBody = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : undefined;
    } catch {
      /* keep raw text */
    }
    // Reuse the Anthropic SDK's APIError so the existing classify/retry logic
    // (429/5xx retryable, 401/404 deterministic, etc.) works unchanged.
    throw APIError.generate(
      response.status,
      parsedBody,
      bodyText || response.statusText,
      response.headers,
    );
  }

  // Guard: a 200 that is NOT an SSE stream is almost always a misrouted request
  // — e.g. an OpenAI-compatible gateway whose baseURL is missing its "/v1" path
  // returns the gateway's HTML homepage with a 200. The SSE parser would then
  // silently yield nothing, producing empty output and zero usage with no error.
  // Surface it loudly with an actionable hint instead.
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("event-stream")) {
    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch {
      /* ignore */
    }
    const snippet = bodyText.replace(/\s+/g, " ").trim().slice(0, 160);
    const hint =
      profile.protocol === "gemini"
        ? 'the Gemini baseURL usually ends in "/v1beta"'
        : 'OpenAI-compatible baseURLs usually end in "/v1"';
    // Status 400 → classified as a deterministic "invalid_request" (not retried),
    // so the user sees the message once instead of after pointless retries.
    throw APIError.generate(
      400,
      undefined,
      `Expected a streaming response from ${prepared.url} but received "${
        contentType || "an unknown content type"
      }". This usually means the model's baseURL is wrong — ${hint}.${
        snippet ? ` Response began: ${snippet}` : ""
      }`,
      response.headers,
    );
  }

  // Gemini gets a dedicated assembler that preserves thoughtSignature (which
  // llm-bridge's parser discards) — see assembleGemini / parseGeminiNative.
  if (prepared.provider === "google") {
    return yield* assembleGemini(response.body);
  }

  const parse = parserFor(prepared.provider);

  // Accumulators — mirror streaming.ts so the assembled message is identical.
  const contentBlocks: ContentBlock[] = [];
  const toolInputJsonById = new Map<string, string>();
  const toolBlockById = new Map<string, ToolUseBlock>();
  let currentText: TextBlock | null = null;
  let currentThinking: ThinkingBlock | null = null;
  let messageId = "";
  let rawStopReason: string | undefined;
  const usage: Usage = { input_tokens: 0, output_tokens: 0 };

  for await (const event of parse(response.body)) {
    writeStreamDebug("provider_event", event);
    switch (event.type) {
      case "message_start": {
        messageId = event.id;
        yield { type: "message_start", messageId };
        break;
      }
      case "content_delta": {
        if (event.delta.text) {
          if (!currentText) {
            currentText = { type: "text", text: "" };
            contentBlocks.push(currentText);
            currentThinking = null;
          }
          currentText.text += event.delta.text;
          yield { type: "text", text: event.delta.text };
        }
        if (event.delta.thinking) {
          if (!currentThinking) {
            currentThinking = { type: "thinking", thinking: "" };
            contentBlocks.push(currentThinking);
            currentText = null;
          }
          currentThinking.thinking += event.delta.thinking;
        }
        break;
      }
      case "tool_call_start": {
        currentText = null;
        currentThinking = null;
        const block: ToolUseBlock = {
          type: "tool_use",
          id: event.tool_call.id,
          name: event.tool_call.name,
          input: {},
        };
        contentBlocks.push(block);
        toolBlockById.set(event.tool_call.id, block);
        toolInputJsonById.set(event.tool_call.id, "");
        yield { type: "tool_use_start", id: event.tool_call.id, name: event.tool_call.name };
        break;
      }
      case "tool_call_delta": {
        const prev = toolInputJsonById.get(event.tool_call.id) ?? "";
        toolInputJsonById.set(event.tool_call.id, prev + event.tool_call.arguments_delta);
        yield {
          type: "tool_use_input",
          id: event.tool_call.id,
          partial_json: event.tool_call.arguments_delta,
        };
        break;
      }
      case "tool_call_end": {
        finalizeToolInput(toolBlockById.get(event.tool_call.id), toolInputJsonById.get(event.tool_call.id));
        break;
      }
      case "message_end": {
        rawStopReason = event.stop_reason;
        if (event.usage) {
          if (typeof event.usage.input_tokens === "number") {
            usage.input_tokens = event.usage.input_tokens;
          }
          if (typeof event.usage.output_tokens === "number") {
            usage.output_tokens = event.usage.output_tokens;
          }
        }
        break;
      }
      case "error": {
        throw new Error(event.error.message || "Provider stream error");
      }
    }
  }

  // Authoritative finalize: some providers/parsers don't emit `tool_call_end`,
  // so parse every tool block's accumulated argument JSON here regardless.
  for (const [id, block] of toolBlockById) {
    finalizeToolInput(block, toolInputJsonById.get(id));
  }

  // The agentic loop only executes tools when stopReason === "tool_use".
  // Provider finish reasons are unreliable here (OpenAI may say "stop" while
  // emitting tool_calls; Gemini says "STOP"), so derive it from the assembled
  // content: any tool_use block forces a tool-execution turn.
  const hasToolUse = contentBlocks.some((b) => b.type === "tool_use");
  const stopReason = hasToolUse ? "tool_use" : normalizeStopReason(rawStopReason);

  yield { type: "message_done", stopReason, usage };

  writeStreamDebug("provider_assembled", {
    protocol: profile.protocol,
    stopReason,
    blockCount: contentBlocks.length,
  });

  return {
    assistantMessage: { role: "assistant", content: contentBlocks },
    usage,
    stopReason,
  };
}

/**
 * Drain a provider stream into a single non-streaming result. Used by the
 * `createMessage` fast path (compaction summaries, classifier) when the active
 * profile is non-Anthropic.
 */
export async function collectViaProvider(
  profile: ModelProfile,
  params: StreamRequestParams,
): Promise<{ content: ContentBlock[]; usage: Usage; stopReason: string }> {
  const gen = streamViaProvider(profile, params);
  let next = await gen.next();
  while (!next.done) {
    next = await gen.next();
  }
  const result = next.value;
  return {
    content: result.assistantMessage.content as ContentBlock[],
    usage: result.usage,
    stopReason: result.stopReason,
  };
}
