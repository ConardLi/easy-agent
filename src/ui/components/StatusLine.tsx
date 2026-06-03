import React from "react";
import { Box, Text } from "ink";
import { theme, getModeStyle } from "../theme.js";

interface StatusLineProps {
  permissionMode: string;
  /**
   * Output of a user-configured `statusLine` command. Only when this is set do
   * we render an extra status row — by default (no config) the footer stays the
   * minimal hint line, matching Claude's restrained bottom area.
   */
  custom?: string | null;
}

/**
 * Bottom footer. Default: just the calm one-line hint (+ a mode marker when not
 * in `default`). When the user opts into a `statusLine` command in settings,
 * its stdout renders as an extra row above the hint. Nothing model/cwd/cost is
 * shown unless the user explicitly asks for it via that command.
 */
export function StatusLine({ permissionMode, custom }: StatusLineProps): React.ReactNode {
  const mode = getModeStyle(permissionMode);
  const isDefault = permissionMode === "default";
  const modeChip = mode.symbol ? `${mode.symbol} ${mode.label}` : mode.label;
  return (
    <Box flexDirection="column" marginTop={0} paddingX={1}>
      {custom ? (
        <Text color={theme.muted} wrap="truncate-end">
          {custom}
        </Text>
      ) : null}
      <Box>
        {isDefault ? (
          // No active mode: keep the footer calm but still advertise the
          // shortcut so the carousel is discoverable.
          <>
            <Text color={theme.muted}>{"? for shortcuts"}</Text>
            <Text color={theme.muted}>{"   ctrl+o transcript"}</Text>
            <Text color={theme.muted}>{"   shift+tab cycles mode"}</Text>
          </>
        ) : (
          // Active mode pops in its own color; the dim hint shows how to leave.
          <>
            <Text color={mode.color} bold>{`${modeChip} mode on`}</Text>
            <Text color={theme.muted}>{"  (shift+tab to cycle)"}</Text>
            <Text color={theme.muted}>{"   ? for shortcuts"}</Text>
          </>
        )}
      </Box>
    </Box>
  );
}
