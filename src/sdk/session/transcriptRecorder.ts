/**
 * Writes a session's turns to its JSONL transcript.
 *
 * The transcript holds the conversation exactly as the model sees it, so a
 * resumed session continues from the same context: user prompts as sent
 * (skill and command expansions included), assistant messages, tool results,
 * and the hidden messages the engine adds — plan-mode reminders, background
 * notifications, context updates, hook context. Alongside them it records
 * tool start/finish markers, usage after each turn, local command output, and
 * errors.
 *
 * Messages are written by following the engine's message list: anything
 * appended since the last write is appended to the file. When the list is
 * rewritten instead (compaction, `/clear`, a plan approved with a context
 * clear), a boundary entry is written followed by the new list, and resume
 * starts after the last boundary.
 */

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { appendCompactionSnapshot, appendTranscriptEntry, type TranscriptEntry } from "../../session/storage.js";
import type { Usage } from "../../types/message.js";

export class TranscriptRecorder {
  /** The engine messages already in the file, by identity. */
  #recorded: readonly MessageParam[];
  /** A rewritten list seen before the event that explains the rewrite. */
  #pendingRewrite: readonly MessageParam[] | null = null;

  constructor(
    private readonly cwd: string,
    private readonly sessionId: () => string,
    recorded: readonly MessageParam[] = [],
  ) {
    this.#recorded = [...recorded];
  }

  /**
   * Follow the engine's message list. Appended messages are written now; a
   * list that no longer starts with the recorded messages is held until the
   * rewrite is explained by `compacted()` / `cleared()`, or flushed at the end
   * of the turn.
   */
  async sync(messages: readonly MessageParam[], messageId: string | null): Promise<void> {
    if (!startsWith(messages, this.#recorded)) {
      this.#pendingRewrite = [...messages];
      return;
    }
    const appended = messages.slice(this.#recorded.length);
    this.#recorded = [...messages];
    this.#pendingRewrite = null;
    for (const message of appended) {
      await this.#append({
        type: "message",
        timestamp: now(),
        role: message.role === "assistant" ? "assistant" : "user",
        message,
        ...(messageId ? { messageId } : {}),
      });
    }
  }

  /**
   * Full compactions start a new segment with the compacted conversation;
   * micro-compactions only trim old tool output in memory, so the file keeps
   * the original messages and a marker.
   */
  async compacted(trigger: "auto" | "manual" | "micro", messages: readonly MessageParam[]): Promise<void> {
    if (trigger === "micro") {
      this.#rebase(messages);
      return this.system("info", `compaction:${trigger}`);
    }
    await this.#rewrite(trigger, messages);
  }

  /** The conversation was emptied (`/clear`, or a plan implemented in a fresh context). */
  async cleared(): Promise<void> {
    await this.#rewrite("manual", [], "clear");
  }

  /** The session now continues a conversation whose messages are already on disk. */
  rebase(messages: readonly MessageParam[]): void {
    this.#rebase(messages);
  }

  /** Persist a rewrite no event explained, e.g. a compaction inside the agentic loop. */
  async flush(): Promise<void> {
    if (this.#pendingRewrite) await this.#rewrite("auto", this.#pendingRewrite);
  }

  toolStarted(name: string): Promise<void> {
    return this.#append({ type: "tool_event", timestamp: now(), name, phase: "start" });
  }

  toolCompleted(name: string, resultLength: number, isError: boolean | undefined): Promise<void> {
    return this.#append({
      type: "tool_event",
      timestamp: now(),
      name,
      phase: "done",
      resultLength,
      isError,
    });
  }

  usage(turn: Usage, total: Usage): Promise<void> {
    return this.#append({ type: "usage", timestamp: now(), turn, total });
  }

  system(level: "info" | "error", message: string): Promise<void> {
    return this.#append({ type: "system", timestamp: now(), level, message });
  }

  async #rewrite(trigger: "auto" | "manual", messages: readonly MessageParam[], reason?: "clear"): Promise<void> {
    this.#rebase(messages);
    await appendCompactionSnapshot(this.cwd, this.sessionId(), trigger, [...messages], reason ? { reason } : {});
  }

  #rebase(messages: readonly MessageParam[]): void {
    this.#recorded = [...messages];
    this.#pendingRewrite = null;
  }

  #append(entry: TranscriptEntry): Promise<void> {
    return appendTranscriptEntry(this.cwd, this.sessionId(), entry);
  }
}

function startsWith(messages: readonly MessageParam[], prefix: readonly MessageParam[]): boolean {
  return prefix.length <= messages.length && prefix.every((message, index) => messages[index] === message);
}

function now(): string {
  return new Date().toISOString();
}
