import type React from "react";
import { Box, Text } from "ink";
import { glyph, theme } from "../theme.js";

interface AssistantMessageRowProps {
  children: React.ReactNode;
}

/** Keeps the assistant marker visually separate from wrapped message text. */
export function AssistantMessageRow({ children }: AssistantMessageRowProps): React.ReactNode {
  return (
    <Box marginTop={1} alignItems="flex-start">
      <Box width={2} flexShrink={0}>
        <Text color={theme.assistant}>{glyph.assistant}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        {children}
      </Box>
    </Box>
  );
}
