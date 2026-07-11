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
  getAnthropicClientForProfile,
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
} from "./client.js";
import { resolveProfile } from "./providers/profile.js";
import { streamViaProvider, collectViaProvider } from "./providers/providerStream.js";
import type {
  AssistantMessage,
  ContentBlock,
  RedactedThinkingBlock,
  StreamEvent,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  Usage,
} from "../../types/message.js";
import type { ThinkingConfig, EffortLevel } from "../../utils/thinking.js";
import {
  modelSupportsThinking,
  modelSupportsAdaptiveThinking,
  modelSupportsInterleavedThinking,
  modelSupportsEffort,
  buildDefaultThinkingConfig,
  getSessionEffortLevel,
} from "../../utils/thinking.js";
import { writeStreamDebug } from "../../utils/streamDebug.js";
import {
  classifyAPIError,
  getUserFacingErrorMessage,
  toFriendlyError,
} from "./errors.js";
import {
  callWithRetry,
  decideRetry,
  getMaxRetries,
  sleep,
  type QuerySource,
} from "./withRetry.js";

// ─── Request Parameters ────────────────────────────────────────────

export interface StreamRequestParams {
  messages: MessageParam[];
  model?: string;
  maxTokens?: number;
  system?: string;
  tools?: Anthropic.Tool[];
  /**
   * Forces a particular tool-use behavior (e.g. `{ type: "tool", name }` to
   * make the model emit exactly one structured tool call). Used by internal
   * single-shot callers like the Auto Mode classifier; optional so existing
   * callers (compaction, summaries) are unaffected when omitted.
   */
  toolChoice?: Anthropic.MessageCreateParams["tool_choice"];
  signal?: AbortSignal;
  /**
   * Stage 27: foreground (user waiting) vs background (summary / title).
   * Controls whether a 529 capacity overload is retried. Defaults to
   * foreground when unset — conservative for untagged paths.
   */
  querySource?: QuerySource;
  /**
   * Stage 34: extended thinking configuration.
   * When undefined the layer uses the session/default config
   * (`buildDefaultThinkingConfig()`). Pass `{ type: "disabled" }` to
   * suppress thinking for background / internal calls (compaction, etc.).
   */
  thinking?: ThinkingConfig;
  /**
   * Stage 34: effort level for `output_config.effort`.
   * Only honoured for Anthropic models that support it; ignored otherwise.
   * Source: claude-code-source-code/src/utils/effort.ts
   */
  effortLevel?: EffortLevel;
}

// ─── Streaming Result ──────────────────────────────────────────────

export interface StreamResult {
  assistantMessage: AssistantMessage;
  usage: Usage;
  stopReason: string;
}

// ─── Core Streaming Function ───────────────────────────────────────

/**
 * One streaming attempt. Yields incremental events and returns the assembled
 * message. Unlike the public `streamMessage`, this does NOT swallow errors —
 * it lets them propagate so the retry wrapper can decide whether to re-issue
 * the request. (The retry decision must live above a single attempt.)
 */
async function* streamOnce(
  params: StreamRequestParams,
): AsyncGenerator<StreamEvent, StreamResult> {
  // Stage 30: resolve the model handle into a profile. Non-Anthropic protocols
  // (OpenAI Chat/Responses, Gemini) are translated at the edge via llm-bridge;
  // the Anthropic path below is unchanged except it sources its client/model
  // from the (possibly synthetic) profile.
  const profile = await resolveProfile(params.model ?? DEFAULT_MODEL);
  if (profile.protocol !== "anthropic") {
    return yield* streamViaProvider(profile, params);
  }

  const client = getAnthropicClientForProfile(profile);
  const model = profile.model;
  const maxTokens = profile.maxTokens ?? params.maxTokens ?? DEFAULT_MAX_TOKENS;

  // ─── Stage 34: thinking + interleaved beta + effort ───────────────
  const thinkingCfg: ThinkingConfig =
    params.thinking ?? buildDefaultThinkingConfig();
  const hasThinking =
    thinkingCfg.type !== "disabled" &&
    !process.env.CLAUDE_CODE_DISABLE_THINKING &&
    modelSupportsThinking(model);

  let thinkingParam: Record<string, unknown> | undefined;
  if (hasThinking) {
    if (
      !process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING &&
      modelSupportsAdaptiveThinking(model)
    ) {
      thinkingParam = { type: "adaptive" };
    } else {
      let budget =
        thinkingCfg.type === "enabled" && thinkingCfg.budgetTokens
          ? thinkingCfg.budgetTokens
          : maxTokens - 1;
      budget = Math.min(maxTokens - 1, budget);
      thinkingParam = { type: "enabled", budget_tokens: budget };
    }
  }

  const betaHeaders: string[] = [];
  if (hasThinking && modelSupportsInterleavedThinking(model) && !process.env.DISABLE_INTERLEAVED_THINKING) {
    betaHeaders.push("interleaved-thinking-2025-05-14");
  }

  const effortLevel = params.effortLevel ?? getSessionEffortLevel();
  let outputConfig: Record<string, unknown> | undefined;
  if (effortLevel && modelSupportsEffort(model)) {
    outputConfig = { effort: effortLevel };
    betaHeaders.push("effort-2025-11-24");
  }

  // Build the API request
  // When thinking is active, temperature must NOT be set (API requirement).
  // Endpoint identity = baseURL + model; thinking signatures are bound to the
  // endpoint that issued them, so a change strips them (mirrors source's
  // stripSignatureBlocks on credential change).
  const endpointKey = `${profile.baseURL ?? ""}|${model}`;
  const normalizedMessages = normalizeMessagesForAPI(
    params.messages,
    model,
    thinkingParam !== undefined,
    endpointKey,
  );
  const baseParams = {
    model,
    max_tokens: maxTokens,
    messages: normalizedMessages,
    stream: true as const,
    ...(params.system && { system: params.system }),
    ...(params.tools && params.tools.length > 0 && { tools: params.tools }),
    ...(params.toolChoice && { tool_choice: params.toolChoice }),
  };
  // Pass thinking / output_config as extra body entries to avoid strict-SDK
  // type conflicts (they are new beta params not yet in the SDK types in all
  // versions). The SDK forwards unknown top-level keys as-is.
  const requestParams: Anthropic.MessageCreateParamsStreaming = baseParams as unknown as Anthropic.MessageCreateParamsStreaming;
  const extraBody: Record<string, unknown> = {};
  if (thinkingParam) extraBody.thinking = thinkingParam;
  if (outputConfig) extraBody.output_config = outputConfig;
  Object.assign(requestParams, extraBody);

  // Beta features are enabled via the `anthropic-beta` request header
  // (comma-joined), NOT a body field. Merge with any profile headers.
  const requestHeaders: Record<string, string> = {};
  if (betaHeaders.length > 0) {
    requestHeaders["anthropic-beta"] = betaHeaders.join(",");
  }

  // Log the thinking/effort params actually placed on the wire so `/think`
  // and `/effort` can be verified (EASY_AGENT_DEBUG_STREAM=1 → stream-debug.log).
  writeStreamDebug("anthropic_request", {
    model,
    baseURL: profile.baseURL,
    thinking: thinkingParam,
    output_config: outputConfig,
    betas: betaHeaders,
    hasApiKey: Boolean(profile.apiKey || process.env.ANTHROPIC_AUTH_TOKEN),
  });

  // Initiate the stream
  const stream = client.messages.stream(requestParams, {
    signal: params.signal,
    ...(Object.keys(requestHeaders).length > 0 ? { headers: requestHeaders } : {}),
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
            yield { type: "thinking_start" };
          } else if ((event.content_block.type as string) === "redacted_thinking") {
            const rtb = event.content_block as { data?: string };
            const rtBlock: RedactedThinkingBlock = {
              type: "redacted_thinking",
              data: rtb.data ?? "",
            };
            contentBlocks[index] = rtBlock;
            yield { type: "redacted_thinking", data: rtBlock.data };
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
              const chunk = (delta as unknown as { thinking: string }).thinking ?? "";
              block.thinking += chunk;
              yield { type: "thinking_delta", thinking: chunk };
            }
          } else if ((delta as { type: string }).type === "signature_delta") {
            const block = contentBlocks[index] as ThinkingBlock | undefined;
            if (block && block.type === "thinking") {
              const sig = (delta as unknown as { signature: string }).signature ?? "";
              block.signature = (block.signature ?? "") + sig;
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
          if (block && block.type === "thinking") {
            yield {
              type: "thinking_done",
              thinking: (block as ThinkingBlock).thinking,
              signature: (block as ThinkingBlock).signature,
            };
          }
          toolInputJsonByIndex.delete(index);
          break;
        }
      }
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

// ─── Public Streaming Function (with retry) ────────────────────────

/**
 * Send a streaming request to the Anthropic API and yield StreamEvents,
 * transparently retrying transient failures (429 / 5xx / network) with
 * exponential backoff before any content is surfaced.
 *
 * This is the main communication primitive — everything else builds on top.
 *
 * Retry safety: an attempt is only retried while it has NOT yet yielded any
 * content (text / tool_use). The first-party API surfaces transient errors at
 * connection time — on the first pull of the underlying SSE stream, before our
 * own events flow — so in practice the retry happens cleanly. If an error
 * arrives mid-stream (after content), we don't replay; we surface it, because
 * silently re-running would duplicate already-shown output.
 *
 * On a non-retryable error, or once retries are exhausted, we yield a single
 * `error` event carrying a friendly, category-tagged message (matching the
 * pre-Stage-27 contract: the caller sees one `error` event and stops).
 */
export async function* streamMessage(
  params: StreamRequestParams,
): AsyncGenerator<StreamEvent, StreamResult> {
  const maxRetries = getMaxRetries();
  const model = params.model ?? DEFAULT_MODEL;
  let attempt = 0;
  let consecutive529 = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    const inner = streamOnce(params);
    let hasYieldedContent = false;

    try {
      while (true) {
        const { value, done } = await inner.next();
        if (done) {
          return value;
        }
        if (
          value.type === "text" ||
          value.type === "tool_use_start" ||
          value.type === "tool_use_input"
        ) {
          hasYieldedContent = true;
        }
        yield value;
      }
    } catch (error) {
      writeStreamDebug("stream_error", {
        attempt,
        message: error instanceof Error ? error.message : String(error),
      });

      // Aborted requests are never retried — surface the original error and
      // stop, preserving the pre-Stage-27 abort behavior.
      if (params.signal?.aborted) {
        yield {
          type: "error",
          error: error instanceof Error ? error : new Error(String(error)),
          category: "aborted",
        };
        return errorStreamResult();
      }

      const decision = decideRetry(error, attempt, {
        maxRetries,
        querySource: params.querySource,
        consecutive529,
      });
      consecutive529 = decision.consecutive529;

      // Only retry if the decision allows it AND nothing has been streamed yet
      // (re-running after partial output would duplicate visible content).
      if (decision.retry && !hasYieldedContent) {
        yield {
          type: "retry",
          attempt,
          maxRetries,
          delayMs: decision.delayMs,
          errorMessage: getUserFacingErrorMessage(error, model),
          category: classifyAPIError(error),
        };
        await sleep(decision.delayMs, params.signal);
        continue;
      }

      // Non-retryable, exhausted, or mid-stream failure → surface friendly.
      yield {
        type: "error",
        error: toFriendlyError(error, model),
        category: classifyAPIError(error),
      };
      return errorStreamResult();
    }
  }
}

/** Empty result returned after a surfaced error (callers stop on the event). */
function errorStreamResult(): StreamResult {
  return {
    assistantMessage: { role: "assistant", content: [] },
    usage: { input_tokens: 0, output_tokens: 0 },
    stopReason: "error",
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
  const profile = await resolveProfile(params.model ?? DEFAULT_MODEL);

  // Non-Anthropic profiles have no native non-streaming primitive here; drain
  // the translated provider stream into a single result, with the same
  // transient-failure resilience as the Anthropic branch below.
  if (profile.protocol !== "anthropic") {
    return await callWithRetry(() => collectViaProvider(profile, params), {
      querySource: params.querySource ?? "background",
      onRetry: ({ attempt, delayMs, category }) =>
        writeStreamDebug("createMessage_retry", { attempt, delayMs, category }),
    });
  }

  const client = getAnthropicClientForProfile(profile);
  const model = profile.model;
  const maxTokens = profile.maxTokens ?? params.maxTokens ?? DEFAULT_MAX_TOKENS;

  // Single-shot calls (compaction summaries, etc.) get the same transient-
  // failure resilience as streaming, via the shared backoff policy. These are
  // background work — nobody is blocking on the result — so a 529 capacity
  // overload bails fast instead of amplifying load.
  // Background single-shot calls never enable thinking, so normalize the
  // history with thinkingOn=false: this strips signatures + trailing/orphan
  // thinking blocks that would otherwise 400 a thinking-disabled request.
  const bgMessages = normalizeMessagesForAPI(params.messages, model, false);
  const response = await callWithRetry(
    () =>
      client.messages.create({
        model,
        max_tokens: maxTokens,
        messages: bgMessages,
        ...(params.system && { system: params.system }),
        ...(params.tools && params.tools.length > 0 && { tools: params.tools }),
        ...(params.toolChoice && { tool_choice: params.toolChoice }),
      }),
    {
      querySource: params.querySource ?? "background",
      onRetry: ({ attempt, delayMs, category }) =>
        writeStreamDebug("createMessage_retry", { attempt, delayMs, category }),
    },
  );

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
    } else if (block.type === "thinking") {
      const tb = block as unknown as { thinking: string; signature?: string };
      return { type: "thinking" as const, thinking: tb.thinking, signature: tb.signature };
    } else if ((block.type as string) === "redacted_thinking") {
      const rtb = block as unknown as { data: string };
      return { type: "redacted_thinking" as const, data: rtb.data };
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

// ─── Stage 34: Historical normalization pipeline ──────────────────────
//
// Mirrors the post-processing chain in source's normalizeMessagesForAPI
// (claude-code-source-code/src/utils/messages.ts:2008-2348) that prevents
// 400 errors when thinking blocks are in the conversation history.
//
// We only implement the subset needed to prevent the common errors:
//   1. Strip trailing thinking/redacted_thinking blocks from the last
//      assistant message (API rejects them if they trail the content).
//   2. Filter out "orphan" thinking-only assistant messages (a message
//      that contains ONLY thinking/redacted_thinking blocks and no text
//      or tool_use — the API treats this as empty and errors).
//   3. When thinking is disabled in the current turn, strip signatures
//      from thinking blocks so the API doesn't try to validate them.

function isThinkingOnlyContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  if (content.length === 0) return false;
  return content.every(
    (b: unknown) =>
      typeof b === "object" &&
      b !== null &&
      ((b as { type?: string }).type === "thinking" ||
        (b as { type?: string }).type === "redacted_thinking"),
  );
}

// Module-level memo of the endpoint identity that issued the thinking
// signatures currently in history. When the active endpoint changes
// (different baseURL / model), the stored signatures are invalid — the API
// rejects them with a 400 — so we strip them. Mirrors source's
// stripSignatureBlocks-on-credential-change behavior.
let lastEndpointKey: string | undefined;

/**
 * Normalize the conversation history before sending to the Anthropic API.
 *
 * @param messages     Raw MessageParam array from the session store.
 * @param model        The target model (unused today, kept for future routing).
 * @param thinkingOn   Whether thinking is enabled in the current request.
 *                     When false we strip signature fields from thinking blocks
 *                     to avoid the API rejecting stale cryptographic signatures.
 * @param endpointKey  Identity of the active endpoint (baseURL + model). When it
 *                     differs from the previous request, thinking signatures are
 *                     stripped because they're bound to the issuing endpoint.
 */
export function normalizeMessagesForAPI(
  messages: MessageParam[],
  _model: string,
  thinkingOn: boolean,
  endpointKey?: string,
): MessageParam[] {
  let normalized = messages.slice();

  // Detect an endpoint switch: signatures from the previous endpoint are
  // invalid on the new one, so strip them this request.
  const endpointChanged =
    endpointKey !== undefined &&
    lastEndpointKey !== undefined &&
    endpointKey !== lastEndpointKey;
  if (endpointKey !== undefined) {
    lastEndpointKey = endpointKey;
  }
  const stripSignatures = !thinkingOn || endpointChanged;

  // 1) Filter orphan thinking-only assistant messages
  normalized = normalized.filter((msg) => {
    if (msg.role !== "assistant") return true;
    if (isThinkingOnlyContent(msg.content)) return false;
    return true;
  });

  // 2) Strip trailing thinking/redacted_thinking blocks from the last
  //    assistant message. The API rejects an assistant turn if its last
  //    content block is a thinking block with no following text/tool_use.
  const last = normalized[normalized.length - 1];
  if (last && last.role === "assistant" && Array.isArray(last.content)) {
    const content = last.content as unknown as Array<{ type?: string }>;
    let trimIndex = content.length - 1;
    while (
      trimIndex >= 0 &&
      (content[trimIndex]?.type === "thinking" ||
        content[trimIndex]?.type === "redacted_thinking")
    ) {
      trimIndex--;
    }
    if (trimIndex < content.length - 1) {
      const trimmed = trimIndex >= 0
        ? content.slice(0, trimIndex + 1)
        : [{ type: "text", text: "[No message content]" }];
      normalized = [
        ...normalized.slice(0, -1),
        { ...last, content: trimmed as unknown as MessageParam["content"] },
      ];
    }
  }

  // 3) Strip signatures from history thinking blocks when thinking is off
  //    OR the endpoint changed — the API validates signatures against the
  //    issuing endpoint/key and rejects stale ones with a 400.
  if (stripSignatures) {
    normalized = normalized.map((msg) => {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) return msg;
      const blocks = msg.content as unknown as Array<Record<string, unknown>>;
      const newContent = blocks.map((block) => {
        if (block["type"] === "thinking" && block["signature"] !== undefined) {
          const { signature: _sig, ...rest } = block;
          return rest;
        }
        return block;
      });
      return { ...msg, content: newContent as unknown as MessageParam["content"] };
    });
  }

  return normalized;
}
