import React from "react";
import os from "node:os";
import path from "node:path";
import { Box, Text, useStdout } from "ink";
import { theme, glyph, getModeStyle } from "../theme.js";
import { ASCII_LOGO_WIDE, ASCII_LOGO_STACKED } from "../asciiLogo.js";
import { isAgentTeamsEnabled } from "../../utils/agentTeamsEnabled.js";

interface WelcomeBannerProps {
  model: string;
  version: string;
  /** Permission mode the session starts in (default/plan/auto). */
  permissionMode: string;
}

/** Collapse the home prefix to `~` so the cwd line stays short. */
function prettyCwd(): string {
  const cwd = process.cwd();
  const home = os.homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(home + path.sep)) return "~" + cwd.slice(home.length);
  return cwd;
}

// Vertical gradient brand → brandLight across the logo rows, for a bit of
// depth instead of one flat colour.
const FROM: [number, number, number] = [0xd7, 0x77, 0x57];
const TO: [number, number, number] = [0xf5, 0x95, 0x75];
function gradientHex(i: number, n: number): string {
  const t = n <= 1 ? 0 : i / (n - 1);
  const ch = FROM.map((f, k) => Math.round(f + (TO[k] - f) * t));
  return "#" + ch.map((v) => v.toString(16).padStart(2, "0")).join("");
}

/**
 * The startup hero. A big ANSI-Shadow "Easy Agent" wordmark (vertical orange
 * gradient) followed by a compact info block and getting-started tips. Printed
 * once at the very top of the session via <Static>.
 */
export function WelcomeBanner({ model, version, permissionMode }: WelcomeBannerProps): React.ReactNode {
  const tips: string[] = [
    "Type a message to start, or /help to list commands.",
    "/clear resets the conversation · /mode switches permissions.",
    "Ctrl+C interrupts a turn · Ctrl+D exits.",
  ];

  // Pick the single-line wordmark when it fits the bordered box, else the
  // two-row stack. Overhead = round border (2) + paddingX (1*2) + the root
  // Box's paddingX (1*2) = 6 cols. Below that the wide logo would wrap, which
  // looks worse than the compact stack, so we degrade gracefully.
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const logo = columns - 6 >= 78 ? ASCII_LOGO_WIDE : ASCII_LOGO_STACKED;

  const mode = getModeStyle(permissionMode);
  const modeChip = mode.symbol ? `${mode.symbol} ${mode.label}` : mode.label;

  return (
    <Box
      flexDirection="column"
      alignSelf="flex-start"
      marginBottom={1}
      borderStyle="round"
      borderColor={theme.brand}
      paddingX={1}
      paddingY={1}
    >
      <Box flexDirection="column">
        {logo.map((line, i) => (
          <Text key={i} bold color={gradientHex(i, logo.length)}>
            {line}
          </Text>
        ))}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.muted}>{"Terminal-native coding agent  "}</Text>
        <Text color={theme.brandLight}>{`v${version}`}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={theme.muted}>{"model  "}</Text>
          <Text color={theme.brandLight}>{model}</Text>
          <Text color={theme.muted}>{"   mode  "}</Text>
          <Text color={mode.color} bold>{`[ ${modeChip} ]`}</Text>
        </Box>
        <Box>
          <Text color={theme.muted}>{"cwd    "}</Text>
          <Text>{prettyCwd()}</Text>
        </Box>
        {isAgentTeamsEnabled() ? (
          <Box>
            <Text color={theme.muted}>{"teams  "}</Text>
            <Text color={theme.brandLight}>enabled</Text>
            <Text color={theme.muted}>{"  (TeamCreate · SendMessage · TeamDelete)"}</Text>
          </Box>
        ) : null}
      </Box>

      <Box marginTop={1} flexDirection="column">
        {tips.map((tip, i) => (
          <Box key={i}>
            <Text color={theme.brand}>{` ${glyph.bullet} `}</Text>
            <Text color={theme.muted}>{tip}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
