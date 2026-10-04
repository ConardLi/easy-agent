/**
 * Full-screen, scrollable, verbose transcript overlay.
 *
 * Rendered in place of the live frame while Ctrl+O is active. Because it's
 * `height = rows` tall it fills the viewport, pushing the (condensed) <Static>
 * scrollback out of view — so it reads as a dedicated transcript screen.
 * The body shows a window of
 * pre-built lines at the current scroll offset (see useTranscript).
 */
import type React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";

interface TranscriptSearchInfo {
  active: boolean;
  query: string;
  matchCount: number;
  matchOrdinal: number;
}

interface TranscriptOverlayProps {
  /** Every line of the verbose transcript (one string per terminal row). */
  lines: string[];
  /** Index of the first visible line. */
  scroll: number;
  /** How many content rows fit between the header and footer. */
  viewportHeight: number;
  /** Total terminal height, so the overlay fills the screen. */
  rows: number;
  /** Live search state (search bar + footer hint). */
  search?: TranscriptSearchInfo;
}

export function TranscriptOverlay({
  lines,
  scroll,
  viewportHeight,
  rows,
  search,
}: TranscriptOverlayProps): React.ReactNode {
  const window = lines.slice(scroll, scroll + viewportHeight);
  // Pad the window so the footer stays pinned to the bottom even on a short
  // transcript (avoids the footer jumping up when there's little content).
  while (window.length < viewportHeight) window.push("");

  const end = Math.min(scroll + viewportHeight, lines.length);
  const atTop = scroll === 0;
  const atBottom = end >= lines.length;
  const position =
    lines.length === 0
      ? "empty"
      : `${scroll + 1}–${end} / ${lines.length}` + (atTop ? "  (top)" : "") + (atBottom ? "  (bottom)" : "");

  return (
    <Box flexDirection="column" height={rows}>
      <Box>
        <Text backgroundColor={theme.userBarBg} color={theme.brandLight}>
          {" Transcript "}
        </Text>
        <Text color={theme.muted}>{`  ${position}`}</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1}>
        <Text>{window.join("\n")}</Text>
      </Box>

      {/* Search bar — visible while typing a query or once a query is locked. */}
      {search && (search.active || search.query) ? (
        <Box>
          <Text color={theme.brand}>{"/"}</Text>
          <Text>{search.query}</Text>
          {search.active ? <Text inverse> </Text> : null}
          <Text color={theme.muted}>
            {search.query
              ? search.matchCount > 0
                ? `   ${search.matchOrdinal}/${search.matchCount} matches`
                : "   no matches"
              : ""}
          </Text>
        </Box>
      ) : null}

      <Box>
        <Text color={theme.muted} dimColor>
          {search?.active
            ? "type to search · Enter confirm · Esc cancel"
            : "↑/↓ scroll · / search · n/N next/prev · g/G top/bottom · Esc / Ctrl+O / q close"}
        </Text>
      </Box>
    </Box>
  );
}
