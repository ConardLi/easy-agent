/**
 * Shared, side-effect-free helpers used by more than one provider translator.
 *
 * Kept in their own module so the per-provider translation modules
 * (openaiTranslate / geminiTranslate) and the streaming orchestrator
 * (providerStream.ts) can all depend on them without importing one another.
 */

import type { Usage } from "../../../types/message.js";

/**
 * Flatten a tool result (string | content-block array | object) to text.
 * Image blocks collapse to a `[image]` marker: neither the OpenAI `tool`
 * role nor the Gemini `functionResponse` part can carry image bytes, so a
 * tool that returns an image degrades gracefully on those providers (the
 * Anthropic path keeps the real image — see the native pass-through).
 */
export function resultToString(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    return result
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const obj = part as { type?: string; text?: unknown };
          if (typeof obj.text === "string") return obj.text;
          if (obj.type === "image") return "[image]";
        }
        return JSON.stringify(part);
      })
      .join("\n");
  }
  return JSON.stringify(result);
}

/**
 * OpenAI and Gemini count cache hits inside the prompt total
 * (`cached_tokens`, `cachedContentTokenCount`); Anthropic reports them next
 * to an uncached `input_tokens`. Move the cached share into
 * `cache_read_input_tokens` so every protocol reports usage the same way.
 * Totals and context-window accounting are unchanged.
 */
export function applyCachedPromptTokens(usage: Usage, cachedTokens: number | undefined): void {
  if (typeof cachedTokens !== "number" || !Number.isFinite(cachedTokens) || cachedTokens <= 0) return;
  const cached = Math.min(Math.floor(cachedTokens), usage.input_tokens);
  if (cached <= 0) return;
  usage.input_tokens -= cached;
  usage.cache_read_input_tokens = cached;
}

/**
 * Pass an OpenAI Chat Completions SSE body through unchanged while reading
 * `usage.prompt_tokens_details.cached_tokens` from the final usage chunk
 * (the shared stream parser drops that field).
 */
export function observeOpenAIChatCachedTokens(body: ReadableStream<Uint8Array>): {
  stream: ReadableStream<Uint8Array>;
  cachedTokens: () => number | undefined;
} {
  const decoder = new TextDecoder();
  let pending = "";
  let cached: number | undefined;
  const scan = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:") || !trimmed.includes("cached_tokens")) return;
    try {
      const value = (JSON.parse(trimmed.slice(5)) as { usage?: { prompt_tokens_details?: { cached_tokens?: unknown } } })
        .usage?.prompt_tokens_details?.cached_tokens;
      if (typeof value === "number") cached = value;
    } catch {
      /* not a JSON data line */
    }
  };
  const stream = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      pending += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        scan(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    },
    flush() {
      scan(pending + decoder.decode());
    },
  }));
  return { stream, cachedTokens: () => cached };
}

/** Normalize a provider/universal stop reason to the Anthropic vocabulary. */
export function normalizeStopReason(raw: string | undefined): string {
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
