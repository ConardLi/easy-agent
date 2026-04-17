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
  return false;
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
function InlineToolCard({
  name,
  input,
  result,
}: {
  name: string;
  input: Record<string, unknown> | undefined;
  result: ToolResultInfo;
}): React.ReactNode {
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
