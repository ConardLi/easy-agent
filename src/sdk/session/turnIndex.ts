/**
 * Which user turn added each message of a conversation.
 *
 * The engine rebuilds its message list on every change but keeps the message
 * objects, so the turn of a message is remembered by identity. Messages
 * appended to the list belong to the turn running at the time; messages that
 * appear in a rewritten list (a compaction summary, a restored conversation)
 * belong to no turn. The transcript records the same ids, so a resumed session
 * starts from what was saved.
 */

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";

export class TurnIndex {
  readonly #ids = new WeakMap<MessageParam, string>();
  #known: readonly MessageParam[] = [];

  constructor(messages: readonly MessageParam[] = [], ids: readonly (string | null)[] = []) {
    this.seed(messages, ids);
  }

  /** Start from a conversation whose turn ids are known, e.g. one restored from disk. */
  seed(messages: readonly MessageParam[], ids: readonly (string | null)[]): void {
    messages.forEach((message, index) => {
      const id = ids[index];
      if (id) this.#ids.set(message, id);
    });
    this.#known = [...messages];
  }

  /** Follow the engine's list; messages appended since the last call belong to `turnId`. */
  observe(messages: readonly MessageParam[], turnId: string | null): void {
    const appended =
      this.#known.length <= messages.length && this.#known.every((message, index) => messages[index] === message);
    if (appended && turnId) {
      for (const message of messages.slice(this.#known.length)) {
        if (!this.#ids.has(message)) this.#ids.set(message, turnId);
      }
    }
    this.#known = [...messages];
  }

  /** The list was replaced without new turn content: compaction, `/clear`, a rewind. */
  rebase(messages: readonly MessageParam[]): void {
    this.#known = [...messages];
  }

  idOf(message: MessageParam): string | null {
    return this.#ids.get(message) ?? null;
  }

  idsOf(messages: readonly MessageParam[]): (string | null)[] {
    return messages.map((message) => this.idOf(message));
  }
}
