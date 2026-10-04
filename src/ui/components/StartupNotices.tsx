import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { getUiNotices, subscribeUiNotices, type UiNotice } from "../../state/uiNoticeStore.js";

const EMPTY: readonly UiNotice[] = [];

function toneStyle(tone: UiNotice["tone"]): { color: string; glyph: string } {
  switch (tone) {
    case "error":
      return { color: theme.error, glyph: "\u2717" };
    case "warn":
      return { color: theme.warn, glyph: "\u26A0" };
    default:
      return { color: theme.muted, glyph: "\u2139" };
  }
}

/**
 * Quiet, in-frame surface for transient non-fatal notices (flaky MCP server,
 * malformed config) that helpers route through the UI notice bus. Rendered as
 * dim, aligned one-liners just above the input box — visible enough to notice,
 * unobtrusive enough to ignore. Returns nothing when there's nothing to say.
 */
export function StartupNotices(): React.ReactNode {
  const notices = React.useSyncExternalStore(subscribeUiNotices, getUiNotices, () => EMPTY);

  if (notices.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" marginTop={1} paddingX={1}>
      {notices.map((notice) => {
        const { color, glyph } = toneStyle(notice.tone);
        return (
          <Box key={notice.id}>
            <Text color={color}>{`${glyph} `}</Text>
            <Text color={theme.muted}>{notice.text}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
