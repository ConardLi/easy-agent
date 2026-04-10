import React from "react";
import { Box, Text } from "ink";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";

interface ConversationViewProps {
  messages: MessageParam[];
}

export function ConversationView({ messages }: ConversationViewProps): React.ReactNode {
  return (
    <>
      {messages.map((message, index) => {
        if (message.role === "user" && typeof message.content === "string") {
          return (
            <Box key={`u${index}`} marginTop={1}>
              <Text color="green" bold>{"❯ "}</Text>
              <Text>{message.content}</Text>
            </Box>
          );
        }

        if (message.role === "assistant") {
          const text = typeof message.content === "string"
            ? message.content
            : Array.isArray(message.content)
              ? (message.content as Array<{ type: string; text?: string }>)
                  .filter((block) => block.type === "text" && block.text)
                  .map((block) => block.text)
                  .join("")
              : "";

          if (text) {
            return (
              <Box key={`a${index}`}>
                <Text color="magenta">{"\u258E "}</Text>
                <Text>{text}</Text>
              </Box>
            );
          }
        }

        return null;
      })}
    </>
  );
}
