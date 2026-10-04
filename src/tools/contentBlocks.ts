/**
 * Helpers for working with tool-result content that may be either a plain
 * string or an array of content blocks (text + image). These keep the
 * agentic loop's hook-context plumbing agnostic to which form a tool
 * returned: appending/prepending text works the same way for both.
 */

import type { ContentBlock } from "../types/message.js";

/** Append `text` to content, preserving any non-text (image) blocks. */
export function appendTextToContent(content: string | ContentBlock[], text: string): string | ContentBlock[] {
  if (typeof content === "string") return content + text;
  return [...content, { type: "text" as const, text }];
}

/** Prepend `text` to content, preserving any non-text (image) blocks. */
export function prependTextToContent(content: string | ContentBlock[], text: string): string | ContentBlock[] {
  if (typeof content === "string") return text + content;
  return [{ type: "text" as const, text }, ...content];
}
