import React from "react";
import { Box, Text } from "ink";
import { Spinner } from "./Spinner.js";
import type { PermissionPromptState, UsageSummary } from "../types.js";

interface StatusBarProps {
  isLoading: boolean;
  spinnerLabel: string;
  streamingText: string;
  lastUsage: UsageSummary | null;
  permissionPrompt: PermissionPromptState | null;
  permissionMode: string;
}

export function StatusBar({
  isLoading,
  spinnerLabel,
  streamingText,
  lastUsage,
  permissionPrompt,
  permissionMode,
}: StatusBarProps): React.ReactNode {
  return (
    <>
      <Box>
        <Text dimColor>{"  mode: "}{permissionMode}</Text>
      </Box>

      {permissionPrompt && (
        <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text color="yellow">{"⚠ Permission required: "}{permissionPrompt.toolName}</Text>
          <Text dimColor>{"  args: "}{permissionPrompt.summary}</Text>
          <Text dimColor>{"  risk: "}{permissionPrompt.risk}</Text>
          <Text dimColor>{"  always allow rule: "}{permissionPrompt.ruleHint}</Text>
          <Text color="cyan">{"  [y] allow once   [n] deny   [a] always allow (session)"}</Text>
        </Box>
      )}

      {isLoading && !streamingText && !permissionPrompt && (
        <Box marginTop={1}>
          <Spinner label={spinnerLabel} />
        </Box>
      )}

      {isLoading && streamingText && !permissionPrompt && (
        <Box marginTop={0}>
          <Text color="magenta">{"\u258E "}</Text>
          <Text>{streamingText}</Text>
        </Box>
      )}

      {lastUsage && !isLoading && (
        <Box>
          <Text dimColor>
            {"  tokens: "}
            {lastUsage.input + lastUsage.output}
            {" total ("}
            {lastUsage.input}
            {" in / "}
            {lastUsage.output}
            {" out)"}
          </Text>
        </Box>
      )}
    </>
  );
}
