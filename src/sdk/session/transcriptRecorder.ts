/**
 * Writes a session's turns to its JSONL transcript.
 *
 * The transcript records what the user typed (not the expanded skill or
 * command body), every assistant message and tool-result message, tool
 * start/finish markers, usage after each turn, local command output, errors,
 * and compaction snapshots. `--resume` rebuilds the conversation from these
 * entries, so the order of writes follows the order of engine events exactly.
 */

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { appendCompactionSnapshot, appendTranscriptEntry, type TranscriptEntry } from "../../session/storage.js";
import type { Usage } from "../../types/message.js";

export class TranscriptRecorder {
  constructor(
    private readonly cwd: string,
    private readonly sessionId: () => string,
  ) {}

  userPrompt(text: string, messageId: string): Promise<void> {
    return this.#append({
      type: "message",
      timestamp: now(),
      role: "user",
      message: { role: "user", content: text },
      messageId,
    });
  }

  assistantMessage(message: MessageParam, messageId: string | null): Promise<void> {
    return this.#append({
      type: "message",
      timestamp: now(),
      role: "assistant",
      message,
      ...(messageId ? { messageId } : {}),
    });
  }

  toolResults(message: MessageParam, messageId: string | null): Promise<void> {
    return this.#append({
      type: "message",
      timestamp: now(),
      role: "user",
      message,
      ...(messageId ? { messageId } : {}),
    });
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

  /**
   * Full compactions store a snapshot of the compacted conversation so a resume
   * starts from it; micro-compactions only leave a marker.
   */
  compacted(trigger: "auto" | "manual" | "micro", messages: MessageParam[]): Promise<void> {
    if (trigger === "micro") return this.system("info", `compaction:${trigger}`);
    return appendCompactionSnapshot(this.cwd, this.sessionId(), trigger, messages);
  }

  #append(entry: TranscriptEntry): Promise<void> {
    return appendTranscriptEntry(this.cwd, this.sessionId(), entry);
  }
}

function now(): string {
  return new Date().toISOString();
}
