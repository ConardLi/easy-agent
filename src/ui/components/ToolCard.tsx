/**
 * Shared chrome for tool-call cards:
 *
 *   ● Edit(src/foo.ts)              ← status dot + bold name + (target)
 *     ⎿  +12 -8  (ctrl+o to expand) ← dimmed result line under a corner gutter
 *
 * The dot is colored by state (grey = running, green = ok, red = error).
 * `ToolCardHeader`, `ResultLine` and `ToolResultSummary` are rendered by both
 * the live `ToolCallList` and the historical `InlineToolCard`, so a card looks
 * identical in-flight and once archived.
 */
import React from "react";
import { Box, Text, useStdout } from "ink";
import { theme, glyph } from "../theme.js";
import { useBlink } from "../hooks/useBlink.js";
import type { ToolLine } from "../utils/toolCardFormat.js";

/**
 * The tool-card lifecycle:
 *   - queued             → emitted but not started (static dim dot)
 *   - running            → actively executing (blinking dot)  [alias: pending]
 *   - waiting-permission → blocked on the user's approval (blinking dot)
 *   - classifier         → Auto-mode safety check in flight (blinking dot)
 *   - ok / error         → resolved (solid green / red dot)
 */
export type ToolState =
  | "queued"
  | "pending"
  | "running"
  | "waiting-permission"
  | "classifier"
  | "ok"
  | "error";

/** The three "in flight, working" states whose dot blinks. */
function isActive(state: ToolState): boolean {
  return state === "pending" || state === "running" || state === "waiting-permission" || state === "classifier";
}

function dotColor(state: ToolState): string {
  switch (state) {
    case "queued":
      return theme.muted; // not started yet — muted, no blink
    case "error":
      return theme.error;
    case "ok":
      return theme.ok;
    default:
      return theme.brand; // warm orange while working (matches the spinner)
  }
}

/**
 * The status dot in its 2-col gutter (`● ` / `✗ ` …), colored + blinking by
 * state. Shared by `ToolCardHeader` and the live collapsed-group card so every
 * card's leading dot behaves identically.
 */
export function ToolDot({ state }: { state: ToolState }): React.ReactNode {
  const blinkOn = useBlink(isActive(state));
  const dotChar = isActive(state) && !blinkOn ? " " : glyph.toolDot;
  return <Text color={dotColor(state)}>{`${dotChar} `}</Text>;
}

/**
 * One-line tool header: `● Label(target)`. The status dot occupies a 2-col
 * gutter (dot + space) so result lines align under the label. While the tool
 * is actively working the dot blinks (shared clock, see useBlink); a queued
 * card shows a steady dim dot.
 */
export function ToolCardHeader({
  line,
  state,
  tag,
}: {
  line: ToolLine;
  state: ToolState;
  /** Optional dim `[tag]` after the target (timeout, HTTP status, MCP server…). */
  tag?: string;
}): React.ReactNode {
  return (
    <Box>
      <ToolDot state={state} />
      <Text bold>{line.label}</Text>
      {line.target ? <Text color={theme.muted}>{`(${line.target})`}</Text> : null}
      {tag ? <Text color={theme.muted}>{` [${tag}]`}</Text> : null}
    </Box>
  );
}

/**
 * Dimmed `⎿` corner gutter + body. The
 * 4-col gutter (`  ⎿ `) lines the body up just past the header's dot+label.
 */
export function ResultLine({ children }: { children: React.ReactNode }): React.ReactNode {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  // Root App uses paddingX={1}; the result gutter consumes 4 more columns.
  // Giving the body a concrete width makes Ink's truncate/wrap rules stable
  // inside <Static>, so long file lists do not wrap back to column 0.
  const rowWidth = Math.max(8, columns - 2);
  const bodyWidth = Math.max(8, rowWidth - 4);

  return (
    <Box flexDirection="row" width={rowWidth}>
      <Box flexShrink={0}>
        <Text color={theme.muted}>{`  ${glyph.resultCorner} `}</Text>
      </Box>
      <Box flexDirection="column" width={bodyWidth}>
        {children}
      </Box>
    </Box>
  );
}

/**
 * The condensed one-line result summary shown under a tool header by default.
 * Renders `+N -M` for edits, or the free-text stat (e.g. "12 lines",
 * "3 matches in 2 files"), plus an optional `(ctrl+o to expand)` hint when a
 * fuller body is available behind verbose mode.
 */
export function ToolResultSummary({
  line,
  expandable,
}: {
  line: ToolLine;
  expandable?: boolean;
}): React.ReactNode {
  const hasDiff = line.added !== undefined || line.removed !== undefined;
  return (
    <ResultLine>
      <Text>
        {hasDiff ? (
          <Text>
            <Text color={theme.ok}>{`+${line.added ?? 0}`}</Text>
            {" "}
            <Text color={theme.error}>{`-${line.removed ?? 0}`}</Text>
          </Text>
        ) : (
          <Text color={theme.muted} wrap="truncate-end">{line.stat ?? "done"}</Text>
        )}
        {expandable ? <Text color={theme.muted}>{"  (ctrl+o to expand)"}</Text> : null}
      </Text>
    </ResultLine>
  );
}
