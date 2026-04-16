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
      {toolCalls.map((toolCall, index) => {
        const label = toolCall.displayName ?? toolCall.name;
        return (
          <Box key={`tc${index}`} marginLeft={2}>
            {toolCall.resultLength !== undefined ? (
              toolCall.isError ? (
                <Text color="red">{"  \u2717 "}{label}: error</Text>
              ) : (
                <Text>
                  <Text color="green">{"  \u2713 "}{label}</Text>
                  {toolCall.displayHint ? (
                    <Text dimColor>{"  "}{toolCall.displayHint}</Text>
                  ) : (
                    <Text dimColor> ({toolCall.resultLength} chars)</Text>
                  )}
                </Text>
              )
            ) : (
              <Text color="yellow">{"  \u26A1 Using tool: "}{label}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
