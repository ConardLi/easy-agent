import type React from "react";
import { Box, Text } from "ink";
import type { FileSuggestion } from "../types.js";
import { theme } from "../theme.js";

interface FileSuggestionsProps {
  items: FileSuggestion[];
}

/** `@`-typeahead palette: files/dirs under the working directory. */
export function FileSuggestions({ items }: FileSuggestionsProps): React.ReactNode {
  if (items.length === 0) {
    return null;
  }
  return (
    <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text dimColor>files (↑↓ navigate, Enter/Tab select)</Text>
      {items.map((item) => {
        const pointer = item.isSelected ? "❯" : " ";
        return (
          <Box key={item.path}>
            <Text color={item.isSelected ? theme.brand : theme.muted}>{pointer} </Text>
            <Text
              color={item.isSelected ? theme.brand : item.isDirectory ? theme.info : undefined}
              bold={item.isSelected}
            >
              {item.path}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
