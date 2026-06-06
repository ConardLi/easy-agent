/**
 * MemoryPicker — interactive overlay for `/memory` (no args). Lists the editable
 * memory files (AGENT.md chain + project memdir); the user moves with ↑/↓ (or a
 * 1-9 quick key) and presses Enter to open the selected file in $EDITOR.
 *
 * Mirrors source's MemoryFileSelector (components/memory/MemoryFileSelector.tsx):
 * non-existent User/Project files are still listed (marked "new"), and selecting
 * a row opens it in the editor. Pure presentation — keyboard handling lives in
 * hooks/useMemoryPicker, and the open is performed by re-invoking `/memory edit
 * <n>` through the engine (the same $EDITOR path the text command uses).
 */

import React from "react";
import { Box, Text } from "ink";
import type { MemoryPickerItem } from "../../core/queryEngine.js";
import { theme, glyph } from "../theme.js";

interface MemoryPickerProps {
  items: MemoryPickerItem[];
  /** Cursor position into `items`. */
  index: number;
  /** cwd, so absolute paths can be shown relative when possible. */
  cwd: string;
}

/** How many rows to show at once before the viewport scrolls. */
const MAX_VISIBLE = 8;

function formatSize(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

function displayPath(cwd: string, abs: string): string {
  if (abs.startsWith(cwd + "/")) return abs.slice(cwd.length + 1);
  const home = process.env.HOME;
  if (home && abs.startsWith(home + "/")) return "~/" + abs.slice(home.length + 1);
  return abs;
}

/** Window of indices [start, start+MAX_VISIBLE) that keeps `index` visible. */
function computeWindow(total: number, index: number): { start: number; end: number } {
  if (total <= MAX_VISIBLE) return { start: 0, end: total };
  let start = index - Math.floor(MAX_VISIBLE / 2);
  start = Math.max(0, Math.min(start, total - MAX_VISIBLE));
  return { start, end: start + MAX_VISIBLE };
}

export function MemoryPicker({ items, index, cwd }: MemoryPickerProps): React.ReactNode {
  if (!items || items.length === 0) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text color={theme.info}>{glyph.toolDot} </Text>
          <Text color={theme.info} bold>
            Edit memory
          </Text>
        </Box>
        <Box marginLeft={2}>
          <Text color={theme.muted}>No memory files found. Esc to close.</Text>
        </Box>
      </Box>
    );
  }

  const { start, end } = computeWindow(items.length, index);
  const above = start;
  const below = items.length - end;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={theme.info}>{glyph.toolDot} </Text>
        <Text color={theme.info} bold>
          Edit memory
        </Text>
        <Text color={theme.muted}>{`  ↑↓ navigate · 1-9 quick · Enter open in $EDITOR · Esc cancel`}</Text>
      </Box>

      {above > 0 ? (
        <Box marginLeft={2}>
          <Text color={theme.muted} dimColor>{`↑ ${above} more`}</Text>
        </Box>
      ) : null}

      {items.slice(start, end).map((item, offset) => {
        const i = start + offset;
        const selected = i === index;
        const prefix = selected ? "\u25B6 " : "  ";
        const num = i < 9 ? `${i + 1}.` : "  ";
        const meta = item.exists ? formatSize(item.size) : "new";
        return (
          <Box key={item.path} flexDirection="column">
            <Box>
              <Text color={selected ? theme.brand : undefined} bold={selected} wrap="truncate-end">
                {prefix}
                {num} {item.label}
              </Text>
              <Text color={theme.muted}>{`  (${meta})`}</Text>
            </Box>
            <Box marginLeft={6}>
              <Text color={theme.muted} dimColor wrap="truncate-end">
                {displayPath(cwd, item.path)}
              </Text>
            </Box>
          </Box>
        );
      })}

      {below > 0 ? (
        <Box marginLeft={2}>
          <Text color={theme.muted} dimColor>{`↓ ${below} more`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
