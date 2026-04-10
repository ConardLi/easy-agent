import React from "react";
import { Box, Text } from "ink";
import type { SystemNotice } from "../types.js";

interface SystemPanelProps {
  notice: SystemNotice | null;
}

export function SystemPanel({ notice }: SystemPanelProps): React.ReactNode {
  if (!notice) {
    return null;
  }

  const color = notice.tone === "error" ? "red" : "blue";
  const icon = notice.tone === "error" ? "✗" : "ℹ";

  return (
    <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      <Text color={color}>{icon} {notice.title}</Text>
      {notice.body.split("\n").map((line, index) => (
        <Text key={index} dimColor>{line}</Text>
      ))}
    </Box>
  );
}
