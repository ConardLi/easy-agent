/**
 * Colored line diff for Edit / Write tool cards.
 *
 * Red `-` for removed lines, green `+` for added, dim for unchanged context.
 * Defaults to a CONDENSED view (first `maxLines` rows) with a "… +N more"
 * footer; pass `maxLines={undefined}` (verbose) to show the whole thing.
 *
 * There is no absolute line-number gutter: Edit only gives us the changed
 * fragment, so a file-absolute gutter would be misleading.
 */
import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { computeDiffLines, type DiffLine } from "../utils/diffFormat.js";

interface StructuredDiffProps {
  oldText: string;
  newText: string;
  /** Rows to show before truncating. `undefined` shows everything (verbose). */
  maxLines?: number;
}

function DiffRow({ line }: { line: DiffLine }): React.ReactNode {
  if (line.kind === "add") {
    return <Text color={theme.ok}>{`+ ${line.text}`}</Text>;
  }
  if (line.kind === "del") {
    return <Text color={theme.error}>{`- ${line.text}`}</Text>;
  }
  return <Text color={theme.muted}>{`  ${line.text}`}</Text>;
}

export function StructuredDiff({ oldText, newText, maxLines }: StructuredDiffProps): React.ReactNode {
  const lines = React.useMemo(() => computeDiffLines(oldText, newText), [oldText, newText]);
  if (lines.length === 0) return null;

  const limit = maxLines ?? lines.length;
  const shown = lines.slice(0, limit);
  const hidden = lines.length - shown.length;

  return (
    <Box flexDirection="column" marginLeft={4}>
      {shown.map((line, i) => (
        <DiffRow key={i} line={line} />
      ))}
      {hidden > 0 ? (
        <Text color={theme.muted}>{`… +${hidden} more line${hidden === 1 ? "" : "s"}`}</Text>
      ) : null}
    </Box>
  );
}
