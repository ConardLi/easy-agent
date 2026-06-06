/**
 * DiffView — the `/diff` result panel. Renders uncommitted git changes as
 * colorized unified-patch hunks (green `+`, red `-`, cyan `@@`, dim file
 * headers), then a compact summary of the agent's file-history edits.
 *
 * Mirrors source's DiffDetailView look (colorized hunks per file) within our
 * non-interactive panel model. Dismissed with Esc like any command panel.
 */

import React from "react";
import { Box, Text } from "ink";
import type { DiffViewData } from "../../core/queryEngine.js";
import { theme, glyph } from "../theme.js";

interface DiffViewProps {
  data: DiffViewData | null;
}

/** Color a single unified-patch line by its leading marker. */
function PatchLine({ line }: { line: string }): React.ReactNode {
  if (line.startsWith("@@")) {
    return <Text color={theme.info}>{line}</Text>;
  }
  if (line.startsWith("+++") || line.startsWith("---")) {
    return (
      <Text color={theme.muted} dimColor>
        {line}
      </Text>
    );
  }
  if (line.startsWith("+")) {
    return <Text color={theme.ok}>{line}</Text>;
  }
  if (line.startsWith("-")) {
    return <Text color={theme.error}>{line}</Text>;
  }
  if (
    line.startsWith("index ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("old mode") ||
    line.startsWith("new mode") ||
    line.startsWith("similarity ") ||
    line.startsWith("rename ")
  ) {
    return (
      <Text color={theme.muted} dimColor>
        {line}
      </Text>
    );
  }
  return <Text color={theme.muted}>{line}</Text>;
}

function statusLabel(status: string): string {
  switch (status) {
    case "??":
      return "untracked";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "M":
    case "":
      return "modified";
    default:
      return status;
  }
}

export function DiffView({ data }: DiffViewProps): React.ReactNode {
  if (!data) return null;

  const statText = data.gitStat
    ? `${data.gitStat.files} file${data.gitStat.files === 1 ? "" : "s"} changed, +${data.gitStat.insertions} -${data.gitStat.deletions}`
    : null;

  return (
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Text color={theme.info}>{glyph.toolDot} </Text>
        <Text color={theme.info} bold>
          Diff
        </Text>
      </Box>

      {/* ── Uncommitted git changes ── */}
      <Box marginLeft={2} marginTop={1}>
        {data.isRepo ? (
          <Text color={theme.muted}>
            Uncommitted changes (working tree vs HEAD)
            {statText ? <Text dimColor>{`  ${statText}`}</Text> : null}
          </Text>
        ) : (
          <Text color={theme.muted} dimColor>
            Not a git repository — showing agent file-history edits only.
          </Text>
        )}
      </Box>

      {data.isRepo && data.files.length === 0 ? (
        <Box marginLeft={4} marginTop={1}>
          <Text color={theme.muted} dimColor>
            (clean — no uncommitted changes)
          </Text>
        </Box>
      ) : null}

      {data.files.map((file) => (
        <Box key={file.path} flexDirection="column" marginTop={1}>
          <Box marginLeft={2}>
            <Text color={theme.brand} bold>
              {file.path}
            </Text>
            <Text color={theme.muted} dimColor>
              {`  (${statusLabel(file.status)})`}
            </Text>
          </Box>
          <Box flexDirection="column" marginLeft={4}>
            {file.lines.map((line, i) => (
              <PatchLine key={i} line={line} />
            ))}
          </Box>
        </Box>
      ))}

      {data.truncated ? (
        <Box marginLeft={4} marginTop={1}>
          <Text color={theme.warn}>… patch truncated — run `git diff` for the full output.</Text>
        </Box>
      ) : null}

      {/* ── Agent file-history edits ── */}
      <Box marginLeft={2} marginTop={1}>
        <Text color={theme.muted}>{`Agent edits in the last ${data.turns} turn${data.turns === 1 ? "" : "s"}`}</Text>
      </Box>
      <Box flexDirection="column" marginLeft={4}>
        {data.fileHistory.state === "disabled" ? (
          <Text color={theme.muted} dimColor>
            (file history disabled)
          </Text>
        ) : data.fileHistory.state === "empty" ? (
          <Text color={theme.muted} dimColor>
            (no tracked changes)
          </Text>
        ) : (
          <>
            <Text color={theme.muted}>
              {`${data.fileHistory.filesChanged.length} file${data.fileHistory.filesChanged.length === 1 ? "" : "s"}, `}
              <Text color={theme.ok}>{`+${data.fileHistory.insertions}`}</Text>
              {" "}
              <Text color={theme.error}>{`-${data.fileHistory.deletions}`}</Text>
            </Text>
            {data.fileHistory.filesChanged.map((f) => (
              <Text key={f} color={theme.muted} dimColor>
                {`  ${f}`}
              </Text>
            ))}
            <Text color={theme.muted} dimColor>
              {"  Use /rewind [n] to undo these edits."}
            </Text>
          </>
        )}
      </Box>

      <Box marginTop={1} marginLeft={2}>
        <Text color={theme.muted} dimColor>
          esc to dismiss
        </Text>
      </Box>
    </Box>
  );
}
