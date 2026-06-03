import React from "react";
import { Box, Text, useStdout } from "ink";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { extractBashOutput, formatErrorBody, summarizeTool } from "../utils/toolCardFormat.js";
import { Markdown } from "../markdown/Markdown.js";
import { StructuredDiff } from "./StructuredDiff.js";
import { ResultLine, ToolCardHeader, ToolResultSummary } from "./ToolCard.js";
import { theme, glyph } from "../theme.js";

// Safety cap on how many output lines a verbose Bash card prints, so a runaway
// command (npm install, a 50k-line log) can't blow up the frame.
const BASH_VERBOSE_MAX_LINES = 200;

/** First non-empty line of a block of text (the condensed one-liner). */
function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    if (line.trim()) return line;
  }
  return text.split("\n")[0] ?? "";
}

/**
 * Column of output lines (no gutter) — meant to sit inside a <ResultLine>,
 * which supplies the dimmed `⎿` corner. Caps at `max` with a "+N more" footer.
 */
function OutputBody({
  text,
  color,
  max = Infinity,
}: {
  text: string;
  color?: string;
  max?: number;
}): React.ReactNode {
  const lines = text.split("\n");
  const shown = Number.isFinite(max) ? lines.slice(0, max) : lines;
  const hidden = lines.length - shown.length;
  return (
    <>
      {shown.map((line, i) => (
        <Text key={i} color={color ?? theme.muted}>{line || " "}</Text>
      ))}
      {hidden > 0 ? (
        <Text color={theme.muted}>{`… +${hidden} more line${hidden === 1 ? "" : "s"}`}</Text>
      ) : null}
    </>
  );
}

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

export interface ToolResultInfo {
  content: string;
  isError: boolean;
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
          .filter((b) => b?.type === "text" && typeof b.text === "string")
          .map((b) => b.text as string)
          .join("");
      }
      map.set(block.tool_use_id, { content: text, isError: block.is_error === true });
    }
  }
  return map;
}

/**
 * Inline tool-call card rendered from an assistant message's `tool_use`
 * block. Visual styling deliberately mirrors `ToolCallList` so that a card
 * in-flight and the same card archived in history look identical.
 */
/**
 * Pull the human-friendly Agent invocation summary out of a tool_use's
 * raw input. Agent calls always have `prompt` + `description` (required
 * by the schema) and an optional `subagent_type`. The input.prompt
 * itself is the full sub-agent task — usually multi-line and noisy —
 * so we deliberately surface only the short description here.
 */
function summarizeAgentInput(
  input: Record<string, unknown> | undefined,
): { agentType: string; description?: string } | null {
  if (!input || typeof input !== "object") return null;
  const subagent = typeof input["subagent_type"] === "string" ? input["subagent_type"] : "general-purpose";
  const description = typeof input["description"] === "string" ? input["description"] : undefined;
  return { agentType: subagent || "general-purpose", description };
}

function InlineAgentCard({
  input,
  result,
}: {
  input: Record<string, unknown> | undefined;
  result: ToolResultInfo;
}): React.ReactNode {
  const summary = summarizeAgentInput(input);
  const agentType = summary?.agentType ?? "general-purpose";
  const description = summary?.description;
  const color = result.isError ? "red" : "green";
  const glyph = result.isError ? "✗" : "✓";

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Text color={color}>{`  ${glyph} Agent`}</Text>
        <Text bold color={color}>{`[${agentType}]`}</Text>
        {description ? <Text>{`  ${description}`}</Text> : null}
        {result.isError ? <Text color="red">{" — failed"}</Text> : null}
      </Box>
      {result.isError && result.content ? (
        <Box marginLeft={4} flexDirection="column">
          <Text color="red">{formatErrorBody(result.content)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function InlineToolCard({
  name,
  input,
  result,
  verbose,
}: {
  name: string;
  input: Record<string, unknown> | undefined;
  result: ToolResultInfo;
  /** Global Ctrl+O verbose flag: false = condensed `⎿` summary only. */
  verbose: boolean;
}): React.ReactNode {
  // Agent calls get the same dedicated rendering as live SubAgentCard,
  // just without the running spinner — see InlineAgentCard.
  if (name === "Agent") {
    return <InlineAgentCard input={input} result={result} />;
  }

  const line = summarizeTool(name, input, result.content);
  const state = result.isError ? "error" : "ok";

  // Bash: header shows `Bash(command)`. Condensed → first output line + an
  // expand hint; verbose → the full (capped) stdout/stderr under the corner.
  if (name === "Bash") {
    const output = extractBashOutput(result.content);
    const bodyColor = result.isError ? theme.error : undefined;
    if (!output) {
      return (
        <Box flexDirection="column">
          <ToolCardHeader line={line} state={state} />
          <ToolResultSummary line={line} />
        </Box>
      );
    }
    const multiLine = output.includes("\n");
    return (
      <Box flexDirection="column">
        <ToolCardHeader line={line} state={state} />
        {verbose ? (
          <ResultLine>
            <OutputBody text={output} color={bodyColor} max={BASH_VERBOSE_MAX_LINES} />
          </ResultLine>
        ) : (
          <ResultLine>
            <Text>
              <Text color={bodyColor ?? theme.muted}>{firstLine(output)}</Text>
              {multiLine ? <Text color={theme.muted}>{"  (ctrl+o to expand)"}</Text> : null}
            </Text>
          </ResultLine>
        )}
      </Box>
    );
  }

  // Errors (non-Bash): condensed → first error line + hint; verbose → full body.
  if (result.isError) {
    const body = formatErrorBody(result.content);
    const multiLine = body.includes("\n");
    return (
      <Box flexDirection="column">
        <ToolCardHeader line={line} state="error" />
        {result.content ? (
          verbose ? (
            <ResultLine>
              <OutputBody text={body} color={theme.error} />
            </ResultLine>
          ) : (
            <ResultLine>
              <Text>
                <Text color={theme.error}>{firstLine(body)}</Text>
                {multiLine ? <Text color={theme.muted}>{"  (ctrl+o to expand)"}</Text> : null}
              </Text>
            </ResultLine>
          )
        ) : (
          <ToolResultSummary line={line} />
        )}
      </Box>
    );
  }

  // Edit → colored diff of the old/new fragments. Write (new file) → content
  // as all-added green lines. Read/Grep/Glob have no richer body, so they
  // always show just the `⎿` summary. Diff bodies are gated behind verbose.
  const oldStr = typeof input?.old_string === "string" ? (input.old_string as string) : undefined;
  const newStr = typeof input?.new_string === "string" ? (input.new_string as string) : undefined;
  const writeContent = name === "Write" && typeof input?.content === "string" ? (input.content as string) : undefined;
  const hasDiff = (name === "Edit" && oldStr !== undefined && newStr !== undefined) || writeContent !== undefined;

  return (
    <Box flexDirection="column">
      <ToolCardHeader line={line} state="ok" />
      {verbose && name === "Edit" && oldStr !== undefined && newStr !== undefined ? (
        <>
          <ToolResultSummary line={line} />
          <StructuredDiff oldText={oldStr} newText={newStr} />
        </>
      ) : verbose && writeContent !== undefined ? (
        <>
          <ToolResultSummary line={line} />
          <StructuredDiff oldText="" newText={writeContent} />
        </>
      ) : (
        <ToolResultSummary line={line} expandable={hasDiff} />
      )}
    </Box>
  );
}

// Read-only inspection tools whose consecutive runs collapse into one
// summary line. Mirrors source's collapseReadSearch — a turn that reads 6
// files + greps twice shouldn't print 8 separate cards.
const GROUPABLE_TOOLS = new Set(["Read", "Grep", "Glob"]);
const GROUP_MIN = 2;
const GROUP_TARGET_PREVIEW = 4;

interface GroupMember {
  name: string;
  input: Record<string, unknown> | undefined;
  result: ToolResultInfo;
}

/**
 * Collapsed card for a run of consecutive Read/Grep/Glob calls. Header counts
 * each tool kind ("Read 3 · Grep 2"); the `⎿` line lists the first few targets
 * so the paths aren't lost. Full per-call detail still lives in the Ctrl+O
 * transcript.
 */
function GroupedReadSearchCard({ members }: { members: GroupMember[] }): React.ReactNode {
  const counts = new Map<string, number>();
  const targets: string[] = [];
  for (const m of members) {
    counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
    const line = summarizeTool(m.name, m.input, m.result.content);
    if (line.target) targets.push(line.target);
  }
  const label = [...counts.entries()].map(([n, c]) => `${n} ${c}`).join(" · ");
  const preview = targets.slice(0, GROUP_TARGET_PREVIEW);
  const hidden = targets.length - preview.length;
  const summary =
    preview.join(", ") + (hidden > 0 ? `, +${hidden} more` : "");
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
  if (previousKind !== "user") return element;
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
      }
      // Array content = tool_result blocks — surfaced via their tool_use item.
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
          const block = blocks[j];
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

            // Collapse a contiguous run of successful Read/Grep/Glob calls
            // into a single grouped card. The run is bounded by this
            // assistant message, so by the time any result exists all of its
            // results exist too — the grouped item is final on first emit and
            // never mutates (preserving the <Static> append-only invariant).
            if (GROUPABLE_TOOLS.has(block.name) && !result.isError) {
              const run: GroupMember[] = [{ name: block.name, input: block.input, result }];
              let k = j + 1;
              while (k < blocks.length) {
                const next = blocks[k];
                if (
                  next?.type !== "tool_use" ||
                  typeof next.id !== "string" ||
                  typeof next.name !== "string" ||
                  !GROUPABLE_TOOLS.has(next.name)
                )
                  break;
                const nextResult = toolResults.get(next.id);
                if (!nextResult || nextResult.isError) break;
                run.push({ name: next.name, input: next.input, result: nextResult });
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
                <InlineToolCard name={block.name} input={block.input} result={result} verbose={verbose} />,
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
