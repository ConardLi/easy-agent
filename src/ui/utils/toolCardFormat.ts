/**
 * Shared formatting helpers for tool-call cards.
 *
 * Used by both the live `ToolCallList` (in-flight cards) and the
 * `ConversationView` (inline cards rendered from committed assistant
 * messages). Keeping them in one place ensures the two views look
 * identical once an in-flight card transitions into history.
 */

const MAX_ERROR_LINES = 12;
const MAX_ERROR_CHARS = 2000;

/**
 * Clamp a (potentially long) error message to a bounded number of lines
 * and characters so it stays readable in the terminal without scrolling
 * off everything else.
 */
export function formatErrorBody(raw: string): string {
  let text = raw.trim();
  if (text.length > MAX_ERROR_CHARS) {
    text = `${text.slice(0, MAX_ERROR_CHARS)}\n… (truncated, ${raw.length} chars total)`;
  }
  const lines = text.split("\n");
  if (lines.length > MAX_ERROR_LINES) {
    const keep = lines.slice(0, MAX_ERROR_LINES);
    keep.push(`… (+${lines.length - MAX_ERROR_LINES} more lines)`);
    return keep.join("\n");
  }
  return text;
}

/**
 * Build a compact one-line preview of a tool's input for debug display.
 * Keeps the first ~120 characters of each value and truncates long strings.
 */
export function formatToolInputPreview(
  input: Record<string, unknown> | undefined | null,
): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const entries = Object.entries(input);
  if (entries.length === 0) return undefined;
  const parts: string[] = [];
  for (const [key, value] of entries) {
    let rendered: string;
    if (typeof value === "string") {
      rendered = value.length > 120 ? `${value.slice(0, 120)}…` : value;
      rendered = rendered.replace(/\s+/g, " ");
      rendered = JSON.stringify(rendered);
    } else if (value === null || value === undefined) {
      rendered = String(value);
    } else if (typeof value === "object") {
      const json = JSON.stringify(value);
      rendered = json.length > 120 ? `${json.slice(0, 120)}…` : json;
    } else {
      rendered = String(value);
    }
    parts.push(`${key}=${rendered}`);
  }
  const joined = parts.join(", ");
  return joined.length > 200 ? `${joined.slice(0, 200)}…` : joined;
}
