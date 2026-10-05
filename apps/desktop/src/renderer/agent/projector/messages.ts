import type { MessageParam } from "../../../shared/agent";
import { type ToolFacts, toolCall } from "../tools";
import type { Attachment, Block } from "../viewModel";

/** Context the Agent adds to the conversation on its own; the person never typed it. */
const HIDDEN_PREFIXES = [
  "[session-start]",
  "[plan_mode_attachment]",
  "[plan_mode_exit]",
  "[ultrathink]",
  "[context_update]",
  "[task-notification]",
  "[skill_invocation:",
  "[command_invocation:",
  "[CompactBoundary]",
  "This session is being continued from a previous conversation",
];

/** What the live events know about a tool call beyond the committed messages. */
export interface ToolLive {
  name: string;
  startedAt?: number;
  completedAt?: number;
  input?: Record<string, unknown>;
  result?: { text: string; isError: boolean };
  liveOutput?: string;
}

type ContentBlock = { type: string; [key: string]: unknown };

function contentBlocks(message: MessageParam): ContentBlock[] {
  const content = message.content as unknown;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ContentBlock[])
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("\n");
}

/** The text a person typed, or null for context the Agent added. */
export function visibleUserText(raw: string): string | null {
  const text = raw.trimStart();
  if (!text || HIDDEN_PREFIXES.some((prefix) => text.startsWith(prefix))) return null;
  // A skill or prompt command shows as what was typed: `/name args`.
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1];
  if (name) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1];
    return args ? `${name} ${args}` : name;
  }
  return text.replace(/^\[user-context\][\s\S]*?\n\n/, "").trim() || null;
}

/** Results of every tool call in the conversation, by tool_use id. */
function toolResults(messages: readonly MessageParam[]): Map<string, { text: string; isError: boolean }> {
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const block of contentBlocks(message)) {
      if (block.type === "tool_result") results.set(String(block.tool_use_id), { text: resultText(block.content), isError: block.is_error === true });
    }
  }
  return results;
}

/** Key for remembering how long a thinking block took; committed messages do not carry it. */
export const thinkingKey = (text: string) => `${text.length}:${text.slice(0, 80)}`;

export interface ProjectOptions {
  tools: Record<string, ToolLive>;
  /** A turn is running, so calls without a result are still in progress. */
  busy: boolean;
  cwd?: string;
  thinkingMs?: Record<string, number>;
}

/** A block and the index of the message it came from. */
export interface Projected {
  at: number;
  block: Block;
}

/** Blocks for the committed conversation, in order. Block ids stay stable as messages are appended. */
export function projectMessages(messages: readonly MessageParam[], { tools, busy, cwd, thinkingMs }: ProjectOptions): Projected[] {
  const results = toolResults(messages);
  const out: Projected[] = [];
  messages.forEach((message, mi) => {
    const content = contentBlocks(message);
    if (message.role === "user") {
      const texts: string[] = [];
      const attachments: Attachment[] = [];
      for (const [bi, block] of content.entries()) {
        if (block.type === "text") {
          const text = visibleUserText(String(block.text ?? ""));
          if (text) texts.push(text);
        } else if (block.type === "image") {
          const source = block.source as { type?: string; media_type?: string; data?: string } | undefined;
          if (source?.type === "base64")
            attachments.push({
              id: `m${mi}.${bi}`,
              kind: "image",
              name: "图片",
              preview: `center / cover no-repeat url(data:${source.media_type};base64,${source.data})`,
            });
        }
      }
      if (texts.length > 0 || attachments.length > 0)
        out.push({ at: mi, block: { kind: "user", id: `m${mi}`, text: texts.join("\n\n"), ...(attachments.length ? { attachments } : {}) } });
      return;
    }
    for (const [bi, block] of content.entries()) {
      if (block.type === "thinking" && String(block.thinking ?? "").trim()) {
        const text = String(block.thinking);
        const durationMs = thinkingMs?.[thinkingKey(text)];
        out.push({ at: mi, block: { kind: "thinking", id: `m${mi}.${bi}`, text, ...(durationMs !== undefined ? { durationMs } : {}) } });
      } else if (block.type === "text" && String(block.text ?? "").trim()) {
        out.push({ at: mi, block: { kind: "assistant", id: `m${mi}.${bi}`, text: String(block.text) } });
      } else if (block.type === "tool_use") {
        const id = String(block.id);
        const live = tools[id];
        const facts: ToolFacts = {
          id,
          name: String(block.name),
          input: (block.input as Record<string, unknown>) ?? live?.input ?? {},
          running: busy,
          ...(cwd ? { cwd } : {}),
        };
        const result = results.get(id) ?? live?.result;
        if (result) facts.result = result;
        if (live?.startedAt) facts.startedAt = live.startedAt;
        if (live?.completedAt) facts.completedAt = live.completedAt;
        if (live?.liveOutput && !result) facts.liveOutput = live.liveOutput;
        out.push({ at: mi, block: { kind: "tool", id, tool: toolCall(facts) } });
      }
    }
  });
  return out;
}
