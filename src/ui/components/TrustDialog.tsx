/**
 * First-run trust prompt.
 *
 * Shown the first time the agent is started in a directory the user hasn't
 * trusted yet. Project-scoped settings can configure hooks, statusLine
 * commands, MCP servers and Bash allow-rules — all of which can execute code —
 * so we ask for explicit consent before honoring any of them. Declining exits
 * the CLI; trusting persists the decision (in the machine-level State store,
 * never inside the project) and continues.
 */

import React from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";

interface TrustDialogProps {
  cwd: string;
  /** Detected risk items to surface (project hooks, MCP servers, …). */
  risks: string[];
  onDecision: (trust: boolean) => void;
}

const OPTIONS = [
  { label: "Yes, I trust this folder", trust: true },
  { label: "No, exit", trust: false },
] as const;

export function TrustDialog({ cwd, risks, onDecision }: TrustDialogProps): React.ReactNode {
  const [highlight, setHighlight] = React.useState(0);

  useInput((input, key) => {
    if (key.upArrow) {
      setHighlight((h) => (h + OPTIONS.length - 1) % OPTIONS.length);
      return;
    }
    if (key.downArrow) {
      setHighlight((h) => (h + 1) % OPTIONS.length);
      return;
    }
    if (input === "1") {
      onDecision(true);
      return;
    }
    if (input === "2" || key.escape) {
      onDecision(false);
      return;
    }
    if (key.return) {
      onDecision(OPTIONS[highlight]!.trust);
      return;
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.brand}
      paddingX={1}
      marginY={1}
    >
      <Text bold color={theme.brandLight}>
        Do you trust the files in this folder?
      </Text>
      <Box marginTop={1}>
        <Text color={theme.muted}>{cwd}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          This folder may contain project settings (hooks, status line, MCP
          servers, Bash rules) that can run commands on your machine. Only
          continue if you trust its source.
        </Text>
      </Box>
      {risks.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.muted}>Detected in this folder:</Text>
          {risks.map((r, i) => (
            <Text key={i} color={theme.muted}>{`  • ${r}`}</Text>
          ))}
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        {OPTIONS.map((opt, i) => {
          const on = i === highlight;
          return (
            <Box key={i}>
              <Text color={theme.brand}>{on ? "› " : "  "}</Text>
              <Text color={on ? theme.brandLight : undefined} bold={on}>
                {`${i + 1}. ${opt.label}`}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted} dimColor>
          Enter to select · ↑/↓ to navigate · Esc to exit
        </Text>
      </Box>
    </Box>
  );
}
