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
import {
  buildDefaultThinkingConfig,
  getSessionEffortLevel,
  type EffortLevel,
} from "../../../utils/thinking.js";
import { normalizeStopReason } from "./translateShared.js";
import {
  buildGeminiContents,
  isThoughtSignatureError,
  flattenGeminiToolHistory,
  assembleGemini,
} from "./geminiTranslate.js";
import {
  universalToOpenAIChatMessages,
  universalToOpenAIResponsesInput,
} from "./openaiTranslate.js";

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

/**
 * Map an app effort level to the OpenAI `reasoning_effort` value.
 * App levels are low|medium|high|max; OpenAI accepts
 * minimal|low|medium|high|xhigh, so `max` maps to `xhigh`.
 * Source: doc/CURL_EXAMPLES.md §1–§2.
 */
function toOpenAIReasoningEffort(level: EffortLevel): string {
  return level === "max" ? "xhigh" : level;
}

/**
 * Map an app effort level to the Gemini `thinkingLevel` value.
 * Gemini accepts minimal|low|medium|high (no xhigh/max), so `max` clamps
 * to `high`. Source: doc/CURL_EXAMPLES.md §3.
 */
function toGeminiThinkingLevel(level: EffortLevel): string {
  return level === "max" ? "high" : level;
}

/**
 * Resolve the reasoning-effort string to send to an OpenAI-protocol provider.
 * Precedence mirrors the Anthropic path: an explicit request/session effort
 * wins; otherwise `/think off` (disabled) maps to the lowest ("minimal") so
 * the toggle is observable, and the default (thinking on, no effort) sends
 * nothing so the server applies its own reasoning default.
 */
function resolveOpenAIReasoningEffort(params: StreamRequestParams): string | undefined {
  const effort = params.effortLevel ?? getSessionEffortLevel();
  if (effort) return toOpenAIReasoningEffort(effort);
  const thinkingCfg = params.thinking ?? buildDefaultThinkingConfig();
  if (thinkingCfg.type === "disabled") return "minimal";
  return undefined;
}

interface PreparedRequest {
  provider: ProviderType;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Translate Anthropic-shaped params into a ready-to-fetch provider request. */
export function prepareRequest(profile: ModelProfile, params: StreamRequestParams): PreparedRequest {
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

    // Stage 34: request-side thinking. Gemini expresses thinking via
    // generationConfig.thinkingConfig — includeThoughts surfaces the
    // `thought` parts. The effort level maps to `thinkingLevel`; the legacy
    // numeric `thinkingBudget` is only used when an explicit budget is set
    // (and never alongside thinkingLevel, which 400s per doc §3).
    // Source: doc/CURL_EXAMPLES.md §3.
    const thinkingCfg = params.thinking ?? buildDefaultThinkingConfig();
    if (thinkingCfg.type !== "disabled" && !process.env.CLAUDE_CODE_DISABLE_THINKING) {
      const genConfig =
        (translated.generationConfig as Record<string, unknown>) ?? {};
      const thinkingConfig: Record<string, unknown> = { includeThoughts: true };
      const effort = params.effortLevel ?? getSessionEffortLevel();
      if (effort) {
        thinkingConfig.thinkingLevel = toGeminiThinkingLevel(effort);
      } else if (thinkingCfg.type === "enabled" && thinkingCfg.budgetTokens) {
        thinkingConfig.thinkingBudget = thinkingCfg.budgetTokens;
      }
      genConfig.thinkingConfig = thinkingConfig;
      translated.generationConfig = genConfig;
    }

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
  // Stage 34: request-side reasoning effort. Chat Completions takes a top-level
  // `reasoning_effort` string; the Responses API takes a nested `reasoning.effort`.
  // Source: doc/CURL_EXAMPLES.md §1–§2.
  const reasoningEffort = resolveOpenAIReasoningEffort(params);
  if (profile.protocol === "openai-responses") {
    // Rebuild `input[]` from the universal IR so multi-turn tool calls keep
    // their function_call / function_call_output pairing (llm-bridge drops it).
    body.input = universalToOpenAIResponsesInput(universal);
    if (reasoningEffort) body.reasoning = { effort: reasoningEffort };
  } else {
    // openai-chat: rebuild `messages[]` so tool results become `role:"tool"`
    // messages carrying tool_call_id (llm-bridge mis-emits these).
    body.messages = universalToOpenAIChatMessages(universal);
    // Ask for a final usage chunk so token accounting matches the Anthropic path.
    body.stream_options = { include_usage: true };
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;
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
    hasAuthHeader: Boolean(prepared.headers.authorization || prepared.headers["x-goog-api-key"]),
    // Reasoning/thinking params actually placed on the wire (for /think + /effort verification).
    reasoning_effort: prepared.body.reasoning_effort,
    reasoning: prepared.body.reasoning,
    thinkingConfig: (prepared.body.generationConfig as Record<string, unknown> | undefined)?.thinkingConfig,
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
            yield { type: "thinking_start" };
          }
          const chunk = event.delta.thinking;
          currentThinking.thinking += chunk;
          yield { type: "thinking_delta", thinking: chunk };
        }
        break;
      }
      case "tool_call_start": {
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
