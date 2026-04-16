import React from "react";
import { Box, Text } from "ink";
import type { ModeSuggestion } from "../hooks/usePromptInput.js";

interface ModeSelectorProps {
  items: ModeSuggestion[];
}

export function ModeSelector({ items }: ModeSelectorProps): React.ReactNode {
  if (items.length === 0) {
    return null;
  }

  return (
    <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text dimColor>select mode (↑↓ navigate, Enter confirm, 1-3 shortcut)</Text>
      {items.map((item) => {
        const pointer = item.isSelected ? "❯" : " ";
        const color = item.isSelected ? "yellow" : item.isCurrent ? "green" : "cyan";
        const bold = item.isSelected || item.isCurrent;
        return (
          <Box key={item.mode}>
            <Text color={item.isSelected ? "yellow" : "gray"}>{pointer} </Text>
            <Text color="gray">{item.key}. </Text>
            <Text color={color} bold={bold}>{item.mode}</Text>
            <Text dimColor> — {item.description}</Text>
            {item.isCurrent && <Text color="green"> (current)</Text>}
          </Box>
        );
      })}
    </Box>
  );
}
