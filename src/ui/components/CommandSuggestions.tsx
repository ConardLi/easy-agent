import React from "react";
import { Box, Text } from "ink";
import type { CommandSuggestion } from "../types.js";

interface CommandSuggestionsProps {
  items: CommandSuggestion[];
}

export function CommandSuggestions({ items }: CommandSuggestionsProps): React.ReactNode {
  if (items.length === 0) {
    return null;
  }

  return (
    <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text dimColor>commands</Text>
      {items.map((item) => (
        <Box key={item.name}>
          <Text color="cyan">  {item.name}</Text>
          <Text dimColor> — {item.description}</Text>
        </Box>
      ))}
    </Box>
  );
}
