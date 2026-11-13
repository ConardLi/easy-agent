/**
 * Where each message of a conversation came from.
 *
 * The orchestration layer marks a message when it creates one (the user's
 * prompt, a plan attachment, a background notification, a context update, a
 * hook's output, ...). The marks live in this table rather than on the
 * message, so `MessageParam` keeps its shape and nothing marked ever reaches
 * the provider. Messages without a mark — restored from a transcript, or
 * created by code that does not mark — are classified by their role, their
 * blocks, and the prefixes the orchestration layer gives hidden messages.
 */

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { CONTEXT_UPDATE_MARKER } from "../constants/systemPromptMarkers.js";

export type MessageSource =
  /** What the user typed, with attached images and a UserPromptSubmit hook's context. */
  | "user_input"
  | "assistant"
  | "tool_result"
  /** A slash command: its visible marker and the prompt a user or built-in command expands to. */
  | "command"
  /** The instructions a `/skill` invocation expands to. */
  | "skill_body"
  | "plan_attachment"
  | "background_notification"
  | "team_message"
  | "context_update"
  /** Context a SessionStart or Stop hook added. */
  | "hook_output"
  /** The summary compaction writes and its boundary marker. */
  | "compaction_summary"
  /** The names of deferred tools, prepended to the copy of the history a request carries. */
  | "deferred_tools"
  /** Hidden nudges such as the ultrathink note and the continuation after an output cut-off. */
  | "meta"
  /** The task a sub-agent starts with. */
  | "subagent_prompt"
  /** The transcript and action the Auto Mode classifier judges. */
  | "classifier_input"
  /** A fetched page and the question WebFetch asks about it. */
  | "web_page"
  /** The conversation a compaction request summarizes. */
  | "compaction_input"
  /** The query a server-side web search runs. */
  | "search_query";

const marks = new WeakMap<object, MessageSource>();
const leadingMarks = new WeakMap<object, { source: MessageSource; text: string }>();

/** Record where `message` came from; returns it for use in an expression. */
export function markMessageSource<T extends MessageParam>(message: T, source: MessageSource): T {
  marks.set(message, source);
  return message;
}

/**
 * Record that the first text of `message` starts with `text` from another
 * source: the context a UserPromptSubmit hook puts before the prompt, or the
 * mail a teammate's task starts with.
 */
export function markLeadingSource<T extends MessageParam>(message: T, source: MessageSource, text: string): T {
  leadingMarks.set(message, { source, text });
  return message;
}

/** Mark `copy`, made from `message` to send, as `message` is marked: its origin and its leading span. */
export function copyMessageSource<T extends MessageParam>(message: MessageParam, copy: T): T {
  marks.set(copy, messageSourceOf(message));
  const leading = leadingMarks.get(message);
  if (leading) leadingMarks.set(copy, leading);
  return copy;
}

/** How `message` was marked when it was created, if it was. */
export function markedMessageSource(message: MessageParam): MessageSource | undefined {
  return marks.get(message);
}

/** Context a UserPromptSubmit hook adds starts the prompt with this line. */
export const USER_CONTEXT_PREFIX = "[user-context]\n";
/** The deferred tool list ToolSearch puts in front of the first message of a request. */
export const DEFERRED_TOOLS_PREFIX = "<available-deferred-tools>";

function firstText(message: MessageParam): string {
  if (typeof message.content === "string") return message.content;
  const first = message.content.find((block) => block.type === "text");
  return first && "text" in first ? first.text : "";
}

/**
 * Length of the hook context a restored prompt starts with. The transcript
 * does not keep where the context ends, so the split is the blank line
 * before a known hidden prefix, or else the last blank line.
 */
function restoredLeadingLength(text: string): number | undefined {
  if (!text.startsWith(USER_CONTEXT_PREFIX)) return undefined;
  let last = -1;
  for (let at = text.indexOf("\n\n", USER_CONTEXT_PREFIX.length); at !== -1; at = text.indexOf("\n\n", at + 1)) {
    const rest = text.slice(at + 2);
    if (USER_PREFIXES.some(([prefix]) => rest.startsWith(prefix))) return at + 2;
    last = at;
  }
  return last === -1 ? text.length : last + 2;
}

/** Length of the leading span of `text` that came from another source, with that source. */
function leadingSpan(message: MessageParam, text: string): { source: MessageSource; length: number } | undefined {
  const mark = leadingMarks.get(message);
  if (mark) return text.startsWith(mark.text) ? { source: mark.source, length: mark.text.length } : undefined;
  const length = restoredLeadingLength(text);
  return length === undefined ? undefined : { source: "hook_output", length };
}

/** The first text of `message` without a leading span from another source. */
function leadingText(message: MessageParam): string {
  const text = firstText(message);
  if (message.role !== "user") return text;
  const span = leadingSpan(message, text);
  return span ? text.slice(span.length) : text;
}

/** Prefixes of hidden user messages, checked in order. */
const USER_PREFIXES: ReadonlyArray<[string, MessageSource]> = [
  ["<command-message>", "command"],
  ["<command-name>", "command"],
  ["[command_invocation:", "command"],
  ["[skill_invocation:", "skill_body"],
  ["[plan_mode_attachment]", "plan_attachment"],
  ["[plan_mode_exit]", "plan_attachment"],
  ["[task-notification]", "background_notification"],
  ["<teammate-messages>", "team_message"],
  [CONTEXT_UPDATE_MARKER, "context_update"],
  ["[session-start]", "hook_output"],
  ["[stop-hook]", "hook_output"],
  ["[ultrathink]", "meta"],
  ["This session is being continued from a previous conversation", "compaction_summary"],
  ["<available-deferred-tools>", "deferred_tools"],
];

/** Classify a message nothing marked. */
export function inferMessageSource(message: MessageParam): MessageSource {
  const text = leadingText(message);
  if (message.role === "assistant") return text.startsWith("[CompactBoundary]") ? "compaction_summary" : "assistant";
  if (Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result")) {
    return "tool_result";
  }
  return USER_PREFIXES.find(([prefix]) => text.startsWith(prefix))?.[1] ?? "user_input";
}

/** Where `message` came from: its mark, or what its shape says. */
export function messageSourceOf(message: MessageParam): MessageSource {
  return marks.get(message) ?? inferMessageSource(message);
}

/** A piece of a message from one source. */
export interface MessagePart {
  source: MessageSource;
  /** The text of a text block or of a span of one; the JSON of any other block. */
  content: string;
}

/**
 * Whether `sent` can hold more than one source: a user message that starts
 * with the deferred tool list or with a span from another source. Cheap, so
 * other messages skip `messageParts`.
 */
export function hasMixedSources(sent: MessageParam, original: MessageParam = sent): boolean {
  if (sent.role !== "user") return false;
  const text = firstText(sent);
  return (
    (text.startsWith(DEFERRED_TOOLS_PREFIX) && messageSourceOf(original) !== "deferred_tools") ||
    leadingMarks.has(original) ||
    text.startsWith(USER_CONTEXT_PREFIX)
  );
}

/**
 * `sent` split by source, in order: one part per content block, with the
 * deferred tool list and a leading span from another source (see
 * `markLeadingSource`) as parts of their own. `original` is the message of
 * the conversation `sent` was made from; sending can copy a message to add a
 * cache marker or the deferred tool list.
 */
export function messageParts(sent: MessageParam, original: MessageParam = sent): MessagePart[] {
  const primary = messageSourceOf(original);
  const blocks: ReadonlyArray<{ type: string; text?: string }> =
    typeof sent.content === "string" ? [{ type: "text", text: sent.content }] : sent.content;
  const parts: MessagePart[] = [];
  let spanPending = sent.role === "user";
  for (const block of blocks) {
    if (block.type !== "text" || typeof block.text !== "string") {
      parts.push({ source: block.type === "tool_result" ? "tool_result" : primary, content: JSON.stringify(block) });
      continue;
    }
    const text = block.text;
    if (sent.role === "user" && text.startsWith(DEFERRED_TOOLS_PREFIX)) {
      parts.push({ source: "deferred_tools", content: text });
      continue;
    }
    const span = spanPending ? leadingSpan(original, text) : undefined;
    spanPending = false;
    if (span && span.length > 0) {
      parts.push({ source: span.source, content: text.slice(0, span.length) });
      if (span.length < text.length) parts.push({ source: primary, content: text.slice(span.length) });
      continue;
    }
    parts.push({ source: primary, content: text });
  }
  return parts;
}
