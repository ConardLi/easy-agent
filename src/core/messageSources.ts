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

/** Record where `message` came from; returns it for use in an expression. */
export function markMessageSource<T extends MessageParam>(message: T, source: MessageSource): T {
  marks.set(message, source);
  return message;
}

/** How `message` was marked when it was created, if it was. */
export function markedMessageSource(message: MessageParam): MessageSource | undefined {
  return marks.get(message);
}

function leadingText(message: MessageParam): string {
  if (typeof message.content === "string") return message.content;
  const first = message.content.find((block) => block.type === "text");
  return first && "text" in first ? first.text : "";
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
