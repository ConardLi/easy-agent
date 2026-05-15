import React from "react";
import { Box, Text } from "ink";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { formatErrorBody, formatToolInputPreview } from "../utils/toolCardFormat.js";

interface ConversationViewProps {
  messages: MessageParam[];
}

interface ToolResultInfo {
  content: string;
  isError: boolean;
}

function isInternalMessage(message: MessageParam): boolean {
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
function extractCommandMarker(
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
function buildToolResultMap(messages: MessageParam[]): Map<string, ToolResultInfo> {
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
}: {
  name: string;
  input: Record<string, unknown> | undefined;
  result: ToolResultInfo;
}): React.ReactNode {
  // Agent calls get the same dedicated rendering as live SubAgentCard,
  // just without the running spinner — see InlineAgentCard.
  if (name === "Agent") {
    return <InlineAgentCard input={input} result={result} />;
  }

  const inputPreview = formatToolInputPreview(input);

  if (result.isError) {
    return (
      <Box marginLeft={2} flexDirection="column">
        <Text color="red">
          {"  \u2717 "}{name}
          {inputPreview ? <Text dimColor>{"  "}({inputPreview})</Text> : null}
          <Text color="red">{" — error"}</Text>
        </Text>
        {result.content ? (
          <Box marginLeft={4} flexDirection="column">
            <Text color="red">{formatErrorBody(result.content)}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  return (
    <Box marginLeft={2}>
      <Text>
        <Text color="green">{"  \u2713 "}{name}</Text>
        {inputPreview ? (
          <Text dimColor>{"  "}({inputPreview})</Text>
        ) : (
          <Text dimColor> ({result.content.length} chars)</Text>
        )}
      </Text>
    </Box>
  );
}

export function ConversationView({ messages }: ConversationViewProps): React.ReactNode {
  const toolResults = buildToolResultMap(messages);

  return (
    <>
      {messages.map((message, index) => {
        if (isInternalMessage(message)) {
          return null;
        }

        if (message.role === "user") {
          if (typeof message.content === "string") {
            // Stage 20: background sub-agent finished. The QueryEngine
            // injects the raw `<task-notification>...</task-notification>`
            // XML into the conversation as a `[task-notification]\n…`
            // user message — perfect for the model, ugly for humans.
            // Render a compact one-line status mirroring source's
            // `UserAgentNotificationMessage`.
            const taskNotif = extractTaskNotification(message.content);
            if (taskNotif) {
              const { color, glyph } = taskNotificationStyle(taskNotif.status);
              return (
                <Box key={`u${index}`} marginTop={1}>
                  <Text color={color}>{glyph}</Text>
                  <Text>{` Sub-agent `}</Text>
                  <Text bold color={color}>{taskNotif.agentType}</Text>
                  <Text>{` ${taskNotif.status}`}</Text>
                  {taskNotif.description ? (
                    <Text dimColor>{`  ${taskNotif.description}`}</Text>
                  ) : null}
                  {taskNotif.usage ? (
                    <Text dimColor>{`  · ${taskNotif.usage}`}</Text>
                  ) : null}
                </Box>
              );
            }
            // Slash-command marker (`<command-name>/skill</command-name>` …):
            // render as a styled "❯ /name args" command bubble. Mirrors
            // source's UserCommandMessage component so users see the same
            // breadcrumb whether the command was a built-in or a skill.
            const marker = extractCommandMarker(message);
            if (marker) {
              const display = `/${marker.name.replace(/^\//, "")}` +
                (marker.args ? ` ${marker.args}` : "");
              return (
                <Box key={`u${index}`} marginTop={1}>
                  <Text color="cyan" dimColor>{"❯ "}</Text>
                  <Text color="cyan">{display}</Text>
                </Box>
              );
            }
            return (
              <Box key={`u${index}`} marginTop={1}>
                <Text color="green" bold>{"❯ "}</Text>
                <Text>{message.content}</Text>
              </Box>
            );
          }
          // Array content = tool_result blocks — already rendered inline
          // alongside their parent tool_use above.
          return null;
        }

        if (message.role === "assistant") {
          if (typeof message.content === "string") {
            if (!message.content) return null;
            return (
              <Box key={`a${index}`}>
                <Text color="magenta">{"\u258E "}</Text>
                <Text>{message.content}</Text>
              </Box>
            );
          }

          if (Array.isArray(message.content)) {
            const blocks = message.content as Array<{
              type?: string;
              text?: string;
              id?: string;
              name?: string;
              input?: Record<string, unknown>;
            }>;
            const items: React.ReactNode[] = [];
            blocks.forEach((block, j) => {
              if (block?.type === "text" && block.text) {
                items.push(
                  <Box key={`t${j}`}>
                    <Text color="magenta">{"\u258E "}</Text>
                    <Text>{block.text}</Text>
                  </Box>,
                );
                return;
              }
              if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
                const result = toolResults.get(block.id);
                // Pending tool calls (no result yet) are handled by the
                // live ToolCallList; we only render inline once the result
                // has been committed to the message history.
                if (!result) return;
                items.push(
                  <InlineToolCard
                    key={`tu${j}`}
                    name={block.name}
                    input={block.input}
                    result={result}
                  />,
                );
              }
            });
            if (items.length === 0) return null;
            return (
              <Box key={`a${index}`} flexDirection="column">
                {items}
              </Box>
            );
          }
        }

        return null;
      })}
    </>
  );
}
