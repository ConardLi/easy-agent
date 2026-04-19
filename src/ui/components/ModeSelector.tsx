import React from "react";
import { Box, Text } from "ink";

// Structural subset shared by ModeSuggestion and TaskModeSuggestion.
// Keeping this generic avoids duplicating the whole component just to
// retype `mode` — the two selectors render identically.
interface SelectorItem {
  key: string;
  mode: string;
  description: string;
  isCurrent: boolean;
  isSelected: boolean;
}

interface ModeSelectorProps {
  items: SelectorItem[];
  title?: string;
}

export function ModeSelector({ items, title }: ModeSelectorProps): React.ReactNode {
  if (items.length === 0) {
    return null;
  }

  const hint = title ?? `select mode (↑↓ navigate, Enter confirm, 1-${items.length} shortcut)`;

  return (
    <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text dimColor>{hint}</Text>
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
