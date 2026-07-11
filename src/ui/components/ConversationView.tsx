import React from "react";
import { Box, Text, useStdout } from "ink";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { computeCollapsedCounts, type ToolResultInfo } from "../utils/toolCardFormat.js";
import { classifyToolForCollapse, getCollapsedSummaryText } from "../utils/toolClassify.js";
import { Markdown } from "../markdown/Markdown.js";
import { ResultLine } from "./ToolCard.js";
import { renderInlineToolCard } from "./toolRenderers.js";
import {
  AssistantThinkingMessage,
  AssistantRedactedThinkingMessage,
} from "./AssistantThinkingMessage.js";
import { theme, glyph } from "../theme.js";

// Re-exported for back-compat: ToolResultInfo now lives (React-free) in
// toolCardFormat so the renderer registry and the string transcript can share
// it. Existing importers (transcriptLines, etc.) keep importing it from here.
export type { ToolResultInfo };

/**
 * Full-width grey bar behind a user prompt. We set an EXPLICIT pixel width
 * (terminal columns minus the root's paddingX) rather than `width: "100%"`:
 * inside <Static>, `100%` resolves to the full terminal width and ignores the
 * root padding, making the bar ~2 cols too wide so its background wrapped onto
 * a stray extra line. A concrete width fills the content line with no overflow.
 * The caret intentionally starts at column 0 of the content area so it aligns
 * with assistant/tool status dots below.
 */
function UserMessageBar({
  caret,
  text,
  textColor,
}: {
  caret: string;
  text: string;
  textColor: string;
}): React.ReactNode {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  // Root Box uses paddingX={1} → 1 column reserved on each side.
  const width = Math.max(8, columns - 2);
  return (
    <Box marginTop={1}>
      <Box width={width} backgroundColor={theme.userBarBg}>
        <Text color={theme.brand} bold>{`${caret} `}</Text>
        <Text color={textColor}>{text}</Text>
      </Box>
    </Box>
  );
}

interface ConversationViewProps {
  messages: MessageParam[];
}

export function isInternalMessage(message: MessageParam): boolean {
  const content = typeof message.content === "string" ? message.content : "";
  if (content.startsWith("[CompactBoundary]")) return true;
  if (content.startsWith("This session is being continued from a previous conversation")) return true;
  if (content.startsWith("[plan_mode_attachment]")) return true;
  if (content.startsWith("[plan_mode_exit]")) return true;
  // `/<skill-name>` invocations expand into TWO user messages (mirroring
  // source's processSlashCommand pattern): a visible "command bubble"
  // marker (handled by extractCommandMarker below) and a hidden body
  // tagged with this prefix. The model receives the body as the real
  // prompt, but the user already sees the bubble + the assistant's
  // streaming reply, so the raw SKILL.md dump would just be noise here.
  if (content.startsWith("[skill_invocation:")) return true;
  // Stage 34: the hidden ultrathink meta message (model-only nudge).
  if (content.startsWith("[ultrathink]")) return true;
  // Stage 23: user-command invocations follow the same two-message pattern
  // as skills — a visible `<command-name>` bubble plus this hidden body that
  // carries the substituted prompt template to the model.
  if (content.startsWith("[command_invocation:")) return true;
  return false;
}

/**
 * Stage 20 — pull the human-relevant fields out of a `[task-notification]`
 * user message so the conversation can render a one-line status pill
 * instead of the raw XML the model gets. Returns null if the message is
 * not a task notification.
 *
 * Format reference: state/notificationStore.ts `formatTaskNotification`
 * (which mirrors source code's `<task-notification>` body).
 */
export interface TaskNotificationView {
  status: "completed" | "failed" | "killed" | "unknown";
  agentType: string;
  description?: string;
  /** Pre-formatted usage line (e.g. "5 tools · 1.2k tokens · 4.3s"). */
  usage?: string;
}

export function extractTaskNotification(text: string): TaskNotificationView | null {
  if (!text.startsWith("[task-notification]")) return null;
  const pickTag = (tag: string): string | undefined => {
    const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
    return m ? m[1]?.trim() : undefined;
  };
  const statusRaw = pickTag("status") ?? "";
  const status =
    statusRaw === "completed" || statusRaw === "failed" || statusRaw === "killed"
      ? statusRaw
      : "unknown";
  const agentType = pickTag("agent_type") ?? "agent";
  const description = pickTag("description");
  const usageRaw = pickTag("usage");
  let usage: string | undefined;
  if (usageRaw) {
    // <usage> is `tokens=N tools=M duration_ms=K` — convert to a humane
    // one-liner. Drop missing pieces silently.
    const kv = new Map<string, string>();
    for (const part of usageRaw.split(/\s+/)) {
      const [k, v] = part.split("=");
      if (k && v) kv.set(k, v);
    }
    const bits: string[] = [];
    if (kv.get("tools")) bits.push(`${kv.get("tools")} tools`);
    if (kv.get("tokens")) {
      const n = Number(kv.get("tokens"));
      bits.push(
        Number.isFinite(n) && n >= 1000
          ? `${(n / 1000).toFixed(1)}k tokens`
          : `${n} tokens`,
      );
    }
    if (kv.get("duration_ms")) {
      const ms = Number(kv.get("duration_ms"));
      if (Number.isFinite(ms)) {
        bits.push(ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
      }
    }
    if (bits.length > 0) usage = bits.join(" · ");
  }
  return {
    status,
    agentType,
    ...(description ? { description } : {}),
    ...(usage ? { usage } : {}),
  };
}

function taskNotificationStyle(
  status: TaskNotificationView["status"],
): { color: string; glyph: string } {
  switch (status) {
    case "completed":
      return { color: "green", glyph: "●" };
    case "failed":
      return { color: "red", glyph: "●" };
    case "killed":
      return { color: "yellow", glyph: "●" };
    default:
      return { color: "gray", glyph: "●" };
  }
}

/**
 * Detect a slash-command marker user message and pull the
 * `<command-name>` + `<command-args>` tags out for rendering. Returns null
 * for plain user text. The format mirrors source's `formatCommandInputTags`
 * in claude-code-source-code/src/utils/messages.ts so we stay
 * source-compatible (matters once we add /resume).
 */
export function extractCommandMarker(
  message: MessageParam,
): { name: string; args: string } | null {
  if (typeof message.content !== "string") return null;
  const text = message.content;
  if (!text.includes("<command-name>")) return null;
  const nameMatch = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (!nameMatch) return null;
  const argsMatch = text.match(/<command-args>([^<]*)<\/command-args>/);
  return {
    name: nameMatch[1] ?? "",
    args: (argsMatch?.[1] ?? "").trim(),
  };
}

/**
 * Scan the message history once and index every tool_result by the id of
 * its parent tool_use. The assistant's tool_use blocks are then rendered
 * inline (see below) with their matching result pulled from this map.
 */
export function buildToolResultMap(messages: MessageParam[]): Map<string, ToolResultInfo> {
  const map = new Map<string, ToolResultInfo>();
  for (const msg of messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<{
      type?: string;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    }>) {
      if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      let text = "";
      if (typeof block.content === "string") {
        text = block.content;
      } else if (Array.isArray(block.content)) {
        text = (block.content as Array<{ type?: string; text?: string }>)
          .map((b) => {
            if (b?.type === "text" && typeof b.text === "string") return b.text;
            if (b?.type === "image") return "[image]";
            return "";
          })
          .join("");
      }
      map.set(block.tool_use_id, { content: text, isError: block.is_error === true });
    }
  }
  return map;
}

// Minimum run length before a sequence of read/search calls collapses, and
// how many targets to preview under the `⎿` corner.
const GROUP_MIN = 2;
const GROUP_TARGET_PREVIEW = 4;

interface GroupMember {
  name: string;
  input: Record<string, unknown> | undefined;
  result: ToolResultInfo;
}

/** True when a committed tool use can fold into a read/search summary group. */
function isCollapsibleMember(
  name: string | undefined,
  input: Record<string, unknown> | undefined,
  result: ToolResultInfo | undefined,
): boolean {
  if (!name || !result || result.isError) return false;
  return classifyToolForCollapse(name, input) !== null;
}

/**
 * Collapsed card for a run of consecutive read/search/list/MCP/memory calls.
 * The header is a semantic one-liner ("Searched 5 patterns · Read 12 files ·
 * Listed 3 directories"); the `⎿` line previews the first few targets so the
 * paths/patterns aren't lost. Full per-call detail still lives in the Ctrl+O
 * transcript. Mirrors source's collapseReadSearch — a turn that reads 6 files
 * + greps twice + lists a dir shouldn't print 9 separate cards.
 */
function GroupedReadSearchCard({ members }: { members: GroupMember[] }): React.ReactNode {
  const { counts, targets } = computeCollapsedCounts(
    members.map((m) => ({ name: m.name, input: m.input, result: m.result.content })),
  );
  // History group is always finalized → past-tense summary.
  const label = getCollapsedSummaryText(counts, false);

  const preview = targets.slice(0, GROUP_TARGET_PREVIEW);
  const hidden = targets.length - preview.length;
  const summary = preview.join(", ") + (hidden > 0 ? `, +${hidden} more` : "");
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.ok}>{`${glyph.toolDot} `}</Text>
        <Text bold>{label}</Text>
      </Box>
      {summary ? (
        <ResultLine>
          <Text color={theme.muted} wrap="truncate-end">{summary}</Text>
        </ResultLine>
      ) : null}
    </Box>
  );
}

/**
 * A single, independently-renderable unit of conversation history. Each
 * item carries a STABLE key and is only ever produced once it's final —
 * this is what lets us feed the history into Ink's `<Static>` (append-only,
 * never-repainted) without losing tool cards that gain their result later.
 *
 * Stage 24 foundation: previously the whole `messages` array was rendered
 * inside the live React frame, so every streaming tick repainted the entire
 * conversation — that's the root cause of the terminal "refusing to scroll".
 * Flattening to append-only items lets the committed history move into
 * `<Static>` and stay out of the repaint loop entirely.
 */
export interface ConversationItem {
  key: string;
  element: React.ReactNode;
}

type VisibleItemKind = "user" | "assistantText" | "tool";

function withToolLeadSpacing(
  element: React.ReactNode,
  previousKind: VisibleItemKind | null,
): React.ReactNode {
  // One blank line above every card (after a prompt/text reply AND between
  // consecutive tool cards) so the history reads as a spaced activity stream
  // instead of a dense log wall. Only the very first item of the turn hugs
  // the top.
  if (!previousKind) return element;
  return <Box marginTop={1}>{element}</Box>;
}

function renderUserBubble(content: string): React.ReactNode {
  // Background sub-agent finished — compact one-line status pill.
  const taskNotif = extractTaskNotification(content);
  if (taskNotif) {
    const { color, glyph } = taskNotificationStyle(taskNotif.status);
    return (
      <Box marginTop={1}>
        <Text color={color}>{glyph}</Text>
        <Text>{` Sub-agent `}</Text>
        <Text bold color={color}>{taskNotif.agentType}</Text>
        <Text>{` ${taskNotif.status}`}</Text>
        {taskNotif.description ? <Text dimColor>{`  ${taskNotif.description}`}</Text> : null}
        {taskNotif.usage ? <Text dimColor>{`  · ${taskNotif.usage}`}</Text> : null}
      </Box>
    );
  }
  return <UserMessageBar caret={glyph.userCaret} text={content} textColor={theme.userBarText} />;
}

/**
 * Flatten the message log into an append-only list of display items.
 *
 * Invariant (required by `<Static>`): the returned list only grows — an
 * item, once emitted, never changes content or key. We achieve this by:
 *   - keying user/assistant text by message index (committed text is final)
 *   - keying tool cards by the tool_use `id` (stable) and emitting them ONLY
 *     after the matching tool_result lands, so a card never appears in a
 *     half-finished state and never mutates afterwards.
 * The single exception is wholesale replacement (`/clear`, `/compact`,
 * resume), which shrinks the array — the caller detects that and remounts
 * `<Static>` via a key bump.
 */
export function flattenConversation(
  messages: MessageParam[],
  verbose = false,
): ConversationItem[] {
  const toolResults = buildToolResultMap(messages);
  const items: ConversationItem[] = [];
  let lastVisibleKind: VisibleItemKind | null = null;

  // Stage 34: only the *current round's* thinking is shown; historical
  // thinking is folded away (mirrors source's hidePastThinking /
  // lastThinkingBlockId in Messages.tsx:455-477). We find the index of the
  // last assistant message that carries a thinking/redacted_thinking block —
  // thinking blocks in any earlier assistant message are hidden entirely
  // (unless verbose, which shows everything for the Ctrl+O transcript).
  let lastThinkingMessageIndex = -1;
  messages.forEach((message, index) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return;
    const hasThinking = (message.content as Array<{ type?: string }>).some(
      (b) => b?.type === "thinking" || b?.type === "redacted_thinking",
    );
    if (hasThinking) lastThinkingMessageIndex = index;
  });

  messages.forEach((message, index) => {
    if (isInternalMessage(message)) return;

    if (message.role === "user") {
      if (typeof message.content === "string") {
        const marker = extractCommandMarker(message);
        if (marker) {
          const display = `/${marker.name.replace(/^\//, "")}` + (marker.args ? ` ${marker.args}` : "");
          items.push({
            key: `u${index}`,
            element: (
              <UserMessageBar caret={glyph.userCaret} text={display} textColor={theme.brandLight} />
            ),
          });
          lastVisibleKind = "user";
          return;
        }
        items.push({ key: `u${index}`, element: renderUserBubble(message.content) });
        lastVisibleKind = "user";
      } else if (Array.isArray(message.content)) {
        // A user array is either tool_result blocks (surfaced via their
        // tool_use item) or an image-attachment turn (text + image blocks).
        const blocks = message.content as Array<{ type?: string; text?: string }>;
        const hasToolResult = blocks.some((b) => b?.type === "tool_result");
        if (!hasToolResult) {
          const text = blocks
            .filter((b) => b?.type === "text" && typeof b.text === "string")
            .map((b) => b.text as string)
            .join("");
          const imageCount = blocks.filter((b) => b?.type === "image").length;
          if (text || imageCount > 0) {
            const suffix = imageCount > 0 ? `  [图片 ×${imageCount}]` : "";
            items.push({
              key: `u${index}`,
              element: (
                <UserMessageBar
                  caret={glyph.userCaret}
                  text={`${text}${suffix}`}
                  textColor={theme.userBarText}
                />
              ),
            });
            lastVisibleKind = "user";
          }
        }
      }
      return;
    }

    if (message.role === "assistant") {
      if (typeof message.content === "string") {
        if (!message.content) return;
        items.push({
          key: `a${index}`,
            element: (
              <Box marginTop={1}>
                <Text color={theme.assistant}>{`${glyph.assistant} `}</Text>
                <Markdown content={message.content} />
              </Box>
            ),
          });
          lastVisibleKind = "assistantText";
          return;
        }

      if (Array.isArray(message.content)) {
        const blocks = message.content as Array<{
          type?: string;
          text?: string;
          id?: string;
          name?: string;
          input?: Record<string, unknown>;
        }>;
        for (let j = 0; j < blocks.length; j++) {
          const block = blocks[j] as {
            type?: string;
            text?: string;
            thinking?: string;
            id?: string;
            name?: string;
            input?: Record<string, unknown>;
          };
          // Stage 34: thinking / redacted_thinking blocks. Only the current
          // round is shown by default; historical thinking is hidden unless
          // verbose (Ctrl+O transcript) is on.
          if (block?.type === "thinking") {
            const showThinking = verbose || index === lastThinkingMessageIndex;
            if (showThinking) {
              items.push({
                key: `a${index}-th${j}`,
                element: (
                  <AssistantThinkingMessage
                    thinking={block.thinking ?? ""}
                    verbose={verbose}
                  />
                ),
              });
              lastVisibleKind = "assistantText";
            }
            continue;
          }
          if (block?.type === "redacted_thinking") {
            const showThinking = verbose || index === lastThinkingMessageIndex;
            if (showThinking) {
              items.push({
                key: `a${index}-rth${j}`,
                element: <AssistantRedactedThinkingMessage verbose={verbose} />,
              });
              lastVisibleKind = "assistantText";
            }
            continue;
          }
          if (block?.type === "text" && block.text) {
            items.push({
              key: `a${index}-t${j}`,
                element: (
                  <Box marginTop={1}>
                    <Text color={theme.assistant}>{`${glyph.assistant} `}</Text>
                    <Markdown content={block.text} />
                  </Box>
                ),
              });
              lastVisibleKind = "assistantText";
              continue;
            }
          if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
            const result = toolResults.get(block.id);
            // Only emit once the result is committed — keeps the list
            // append-only (the live ToolCallList shows the in-flight card).
            if (!result) continue;

            // Collapse a contiguous run of successful read/search/list/MCP/
            // memory calls into a single grouped card. This covers Read/Grep/
            // Glob, Bash inspection commands (ls/cat/rg/grep/find/tree/du…),
            // MCP queries, and memory writes. The run is bounded by this
            // assistant message, so by the time any result exists all of its
            // results exist too — the grouped item is final on first emit and
            // never mutates (preserving the <Static> append-only invariant).
            if (isCollapsibleMember(block.name, block.input, result)) {
              const run: GroupMember[] = [{ name: block.name, input: block.input, result }];
              let k = j + 1;
              while (k < blocks.length) {
                const next = blocks[k];
                if (next?.type !== "tool_use" || typeof next.id !== "string" || typeof next.name !== "string")
                  break;
                const nextResult = toolResults.get(next.id);
                if (!isCollapsibleMember(next.name, next.input, nextResult)) break;
                run.push({ name: next.name, input: next.input, result: nextResult! });
                k++;
              }
              if (run.length >= GROUP_MIN) {
                items.push({
                  key: `tug${block.id}`,
                  element: withToolLeadSpacing(
                    <GroupedReadSearchCard members={run} />,
                    lastVisibleKind,
                  ),
                });
                lastVisibleKind = "tool";
                j = k - 1; // skip the consumed blocks
                continue;
              }
            }

            items.push({
              key: `tu${block.id}`,
              element: withToolLeadSpacing(
                <>{renderInlineToolCard({ name: block.name, input: block.input, result, verbose })}</>,
                lastVisibleKind,
              ),
            });
            lastVisibleKind = "tool";
          }
        }
      }
    }
  });

  return items;
}

export function ConversationView({ messages }: ConversationViewProps): React.ReactNode {
  const items = flattenConversation(messages);
  return (
    <>
      {items.map((item) => (
        <React.Fragment key={item.key}>{item.element}</React.Fragment>
      ))}
    </>
  );
}
