/**
 * MessageList — Renders the conversation history.
 *
 * Displays user messages, assistant text, and tool call indicators.
 * Each message type gets distinct styling via Ink's Text component.
 */

import React from "react";
import { Box, Text } from "ink";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";

interface MessageListProps {
  messages: MessageParam[];
}

export function MessageList({ messages }: MessageListProps): React.ReactNode {
  return (
    <Box flexDirection="column">
      {messages.map((msg, i) => (
        <MessageItem key={i} message={msg} />
      ))}
    </Box>
  );
}

function MessageItem({ message }: { message: MessageParam }): React.ReactNode {
  if (message.role === "user") {
    // User messages can be string or content blocks (tool_result)
    if (typeof message.content === "string") {
      return (
        <Box marginTop={1}>
          <Text color="cyan" bold>❯ </Text>
          <Text>{message.content}</Text>
        </Box>
      );
    }
    // tool_result blocks — don't render (they're internal)
    return null;
  }

  // Assistant message
  if (typeof message.content === "string") {
    return (
      <Box marginTop={0}>
        <Text color="magenta">▎ </Text>
        <Text>{message.content}</Text>
      </Box>
    );
  }

  // Assistant message with content blocks
  if (Array.isArray(message.content)) {
    return (
      <Box flexDirection="column">
        {(message.content as Array<{ type: string; text?: string; name?: string }>).map((block, j) => {
          if (block.type === "text" && block.text) {
            return (
              <Box key={j}>
                <Text color="magenta">▎ </Text>
                <Text>{block.text}</Text>
              </Box>
            );
          }
          if (block.type === "tool_use") {
            return (
              <Box key={j} marginLeft={2}>
                <Text color="yellow">⚡ Using tool: {block.name}</Text>
              </Box>
            );
          }
          return null;
        })}
      </Box>
    );
  }

  return null;
}
