import React from "react";
import { Box, Text } from "ink";
import type { ToolCallInfo } from "../types.js";

interface ToolCallListProps {
  toolCalls: ToolCallInfo[];
}

export function ToolCallList({ toolCalls }: ToolCallListProps): React.ReactNode {
  if (toolCalls.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" marginTop={0}>
      {toolCalls.map((toolCall, index) => (
        <Box key={`tc${index}`} marginLeft={2}>
          {toolCall.resultLength !== undefined ? (
            toolCall.isError ? (
              <Text color="red">{"  \u2717 "}{toolCall.name}: error</Text>
            ) : (
              <Text>
                <Text color="green">{"  \u2713 "}{toolCall.name}</Text>
                <Text dimColor> ({toolCall.resultLength} chars)</Text>
              </Text>
            )
          ) : (
            <Text color="yellow">{"  \u26A1 Using tool: "}{toolCall.name}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}
