/**
 * Shared, side-effect-free helpers used by more than one provider translator.
 *
 * Extracted from providerStream.ts (二期 A) so the per-provider translation
 * modules (openaiTranslate / geminiTranslate) and the streaming orchestrator
 * can all depend on them without importing one another. Behavior is unchanged.
 */

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
