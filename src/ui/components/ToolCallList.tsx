import React from "react";
import { Box, Text } from "ink";
import type { ToolCallInfo } from "../types.js";
import { formatErrorBody, summarizeTool } from "../utils/toolCardFormat.js";
import { ResultLine, ToolCardHeader, ToolResultSummary } from "./ToolCard.js";
import { SubAgentCard } from "./SubAgentCard.js";
import { theme } from "../theme.js";
import type { BashProgress } from "../../state/bashProgressStore.js";

interface ToolCallListProps {
  toolCalls: ToolCallInfo[];
  /** Extra breathing room when the first visible thing after a prompt is a tool. */
  leadingMarginTop?: number;
}

const BASH_TAIL_LINES = 6;

/** Live tail of a running Bash command: last few lines + elapsed/line count. */
function BashProgressBody({ progress }: { progress: BashProgress }): React.ReactNode {
  const elapsedSec = Math.max(0, Math.round((Date.now() - progress.startTime) / 1000));
  const lines = progress.output.split("\n").filter((l, i, arr) => l.length > 0 || i < arr.length - 1);
  const tail = lines.slice(-BASH_TAIL_LINES);
  const stat =
    progress.totalLines > 0
      ? `running… (${elapsedSec}s · ${progress.totalLines} lines)`
      : `running… (${elapsedSec}s)`;
  return (
    <Box flexDirection="column">
      <ResultLine>
        <Text color={theme.muted}>{stat}</Text>
      </ResultLine>
      {tail.map((l, i) => (
        <Box key={i} paddingLeft={2}>
          <Text color={theme.muted} dimColor wrap="truncate-end">
            {l || " "}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

/**
 * Live (in-flight) tool cards. Shows the same `● Label(target)` header + `⎿`
 * one-line summary as the historical `InlineToolCard`, so a card doesn't
 * visually jump when it lands in <Static> history. The full diff / output body
 * only appears in history (and only in verbose mode) — keeping the live frame
 * light avoids a double-render flash on the same frame.
 */
export function ToolCallList({ toolCalls, leadingMarginTop = 0 }: ToolCallListProps): React.ReactNode {
  if (toolCalls.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" marginTop={leadingMarginTop}>
      {toolCalls.map((toolCall, index) => {
        const pending = toolCall.resultLength === undefined;
        const key = toolCall.id || `tc${index}`;

        // Agent tool always uses the rich SubAgentCard renderer — both
        // while running (live counters from the progress store) and
        // after completion (final stats baked into the snapshot).
        if (toolCall.name === "Agent" && toolCall.subAgentProgress) {
          return <SubAgentCard key={key} toolCall={toolCall} />;
        }

        const line = summarizeTool(toolCall.name, toolCall.input);
        // Use the model-facing displayName override when present (e.g.
        // "Updated plan"), else the summarized label.
        if (toolCall.displayName) line.label = toolCall.displayName;

        if (pending) {
          // Bash: while the command runs, show its streaming tail under the
          // header so long commands (installs, test runs, `find /`) aren't a
          // frozen spinner. Falls back to the bare header before the first
          // chunk arrives or for non-Bash tools.
          if (toolCall.name === "Bash" && toolCall.bashProgress) {
            return (
              <Box key={key} flexDirection="column">
                <ToolCardHeader
                  line={{ label: toolCall.displayName ?? toolCall.name, target: line.target }}
                  state="pending"
                />
                <BashProgressBody progress={toolCall.bashProgress} />
              </Box>
            );
          }
          return (
            <ToolCardHeader
              key={key}
              line={{ label: toolCall.displayName ?? toolCall.name, target: line.target }}
              state="pending"
            />
          );
        }

        if (toolCall.isError) {
          return (
            <Box key={key} flexDirection="column">
              <ToolCardHeader line={line} state="error" />
              {toolCall.errorMessage ? (
                <ResultLine>
                  <Text color={theme.error}>{formatErrorBody(toolCall.errorMessage)}</Text>
                </ResultLine>
              ) : null}
            </Box>
          );
        }

        // displayHint (e.g. "/plan to preview") wins over the derived stat.
        if (toolCall.displayHint) {
          line.stat = toolCall.displayHint;
          line.added = undefined;
          line.removed = undefined;
        }

        return (
          <Box key={key} flexDirection="column">
            <ToolCardHeader line={line} state="ok" />
            <ToolResultSummary line={line} />
          </Box>
        );
      })}
    </Box>
  );
}
