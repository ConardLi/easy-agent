import type React from "react";
import { Box, Text } from "ink";
import { theme, glyph } from "../theme.js";

interface InputPromptProps {
  isLoading: boolean;
  inputValue: string;
  /** Cursor offset into inputValue (for in-line editing feedback). */
  cursor?: number;
}

/**
 * Per-character color map for trigger highlighting: a leading `/command` word
 * (first line only) and any `@path` references get the accent color; the rest
 * stays default. Returning a flat array keeps cursor-splitting trivial below.
 */
function buildColors(text: string, isFirstLine: boolean): (string | undefined)[] {
  const colors: (string | undefined)[] = new Array(text.length).fill(undefined);
  const paint = (start: number, end: number, color: string) => {
    for (let i = start; i < end && i < text.length; i++) colors[i] = color;
  };
  // Leading slash command, e.g. `/clear`.
  if (isFirstLine && text.startsWith("/")) {
    const m = text.match(/^\/\S*/);
    if (m) paint(0, m[0].length, theme.info);
  }
  // `@file` references anywhere on the line.
  for (const m of text.matchAll(/@\S+/g)) {
    if (m.index !== undefined) paint(m.index, m.index + m[0].length, theme.info);
  }
  return colors;
}

/**
 * A single visual line: trigger-highlighted, with an optional inverse-video
 * cursor block. Groups consecutive same-color chars into spans (and forces a
 * break at the cursor) to minimize Text nodes.
 */
function HighlightedLine({
  text,
  isFirstLine,
  cursorCol,
}: {
  text: string;
  isFirstLine: boolean;
  cursorCol: number | null;
}): React.ReactNode {
  const colors = buildColors(text, isFirstLine);
  const spans: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    if (cursorCol !== null && i === cursorCol) {
      spans.push(
        <Text key={key++} inverse color={colors[i]}>
          {text[i] || " "}
        </Text>,
      );
      i++;
      continue;
    }
    let j = i;
    while (j < text.length && colors[j] === colors[i] && !(cursorCol !== null && j === cursorCol)) j++;
    spans.push(
      <Text key={key++} color={colors[i]}>
        {text.slice(i, j)}
      </Text>,
    );
    i = j;
  }
  // Cursor parked at end of line (or empty line).
  if (cursorCol !== null && cursorCol >= text.length) {
    spans.push(
      <Text key={key++} inverse>
        {" "}
      </Text>,
    );
  } else if (spans.length === 0) {
    spans.push(<Text key={key++}>{" "}</Text>);
  }
  return <Text>{spans}</Text>;
}

/**
 * The prompt input. Framed by a top + bottom rule (no side borders), which
 * lets long/wrapped input
 * flow naturally: with no left/right border, wrapped lines can't "escape" a
 * vertical edge the way they did inside a full rounded box.
 *
 * Renders a real block cursor at the editor's cursor offset and lays multi-line
 * buffers out one Text row per `\n`-delimited line. The leading `>` caret marks
 * the first line; continuation lines indent to align under it.
 *
 * Hidden while a turn is running — the spinner / streaming reply is the focal
 * point and a stale empty box would just add noise.
 */
export function InputPrompt({ isLoading, inputValue, cursor }: InputPromptProps): React.ReactNode {
  if (isLoading) {
    return null;
  }

  const lines = inputValue.split("\n");
  // Bash mode: a leading `!` runs the line as a shell command — flag it with a
  // distinct caret + color so the user always knows which mode they're in.
  const bashMode = inputValue.startsWith("!");
  const caret = bashMode ? "!" : glyph.promptCaret;
  const caretColor = bashMode ? theme.warn : theme.brand;

  // Map the flat cursor offset onto (lineIndex, column).
  let cursorLine = lines.length - 1;
  let cursorCol = lines[cursorLine]?.length ?? 0;
  if (cursor !== undefined) {
    let remaining = cursor;
    for (let i = 0; i < lines.length; i++) {
      const len = lines[i]?.length ?? 0;
      if (remaining <= len) {
        cursorLine = i;
        cursorCol = remaining;
        break;
      }
      remaining -= len + 1; // +1 for the consumed "\n"
    }
  }

  // In bash mode the leading `!` is represented by the caret, so drop it from
  // the displayed first line (the buffer keeps it for editing / submission).
  const displayLines = bashMode ? [lines[0]?.slice(1) ?? "", ...lines.slice(1)] : lines;
  if (bashMode && cursorLine === 0) cursorCol = Math.max(0, cursorCol - 1);

  return (
    <Box
      marginTop={1}
      width="100%"
      borderStyle="single"
      borderColor={theme.border}
      borderLeft={false}
      borderRight={false}
      paddingX={1}
      flexDirection="column"
    >
      {displayLines.map((line, i) => (
        <Box key={i}>
          <Text color={caretColor} bold>
            {i === 0 ? `${caret} ` : "  "}
          </Text>
          <HighlightedLine
            text={line}
            isFirstLine={i === 0 && !bashMode}
            cursorCol={i === cursorLine ? cursorCol : null}
          />
        </Box>
      ))}
    </Box>
  );
}
