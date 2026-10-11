/**
 * Points a conversation can go back to: the prompts a person typed.
 *
 * Every message carries the id of the user turn that added it (the id file
 * history binds its snapshots to). A turn may add hidden context before the
 * prompt, such as plan-mode reminders, background notifications, or context
 * updates; going back to the prompt drops that context too, so the
 * conversation is cut where the turn began.
 */

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { visiblePromptText } from "./storage.js";

export interface CheckpointPosition {
  /** The turn id. */
  id: string;
  /** Index of the prompt message. */
  index: number;
  /** Index where the turn's messages begin; the conversation before a rewind keeps `messages.slice(0, start)`. */
  start: number;
  /** The prompt as typed. */
  prompt: string;
}

function isHiddenContext(message: MessageParam): boolean {
  if (message.role !== "user") return false;
  const content = message.content;
  if (Array.isArray(content) && content.some((block) => (block as { type?: string }).type === "tool_result")) {
    return false;
  }
  return visiblePromptText(message) === null;
}

/** The first prompt of each turn, oldest first. `ids` is aligned with `messages`. */
export function findCheckpoints(
  messages: readonly MessageParam[],
  ids: readonly (string | null)[],
): CheckpointPosition[] {
  const out: CheckpointPosition[] = [];
  const seen = new Set<string>();
  messages.forEach((message, index) => {
    const id = ids[index];
    if (!id || seen.has(id)) return;
    const prompt = visiblePromptText(message);
    if (prompt === null) return;
    seen.add(id);
    let start = index;
    while (start > 0 && ids[start - 1] === id && isHiddenContext(messages[start - 1]!)) start -= 1;
    // Something else of this turn came first, so the prompt does not open the turn.
    if (start > 0 && ids[start - 1] === id) return;
    out.push({ id, index, start, prompt });
  });
  return out;
}
