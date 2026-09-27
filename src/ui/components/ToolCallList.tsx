import React from "react";
import { Box, Text } from "ink";
import type { ToolCallInfo } from "../types.js";
import { computeCollapsedCounts, formatErrorBody, summarizeTool, toolUseTag } from "../utils/toolCardFormat.js";
import { classifyToolForCollapse, getCollapsedSummaryText } from "../utils/toolClassify.js";
import { ResultLine, ToolCardHeader, ToolDot, ToolResultSummary, type ToolState } from "./ToolCard.js";
import { SubAgentCard } from "./SubAgentCard.js";
import { theme } from "../theme.js";
import { formatDuration, formatFileSize } from "../utils/format.js";
import type { BashProgress } from "../../state/bashProgressStore.js";

/**
 * The `⎿` sub-line shown under an in-flight card for the non-running phases.
 * Running cards have no sub-line (their progress shows elsewhere, e.g. the
 * Bash tail). Wording mirrors source's queued / permission / classifier text.
 */
function phaseSubLine(state: ToolState): string | null {
  switch (state) {
    case "queued":
      return "Waiting…";
    case "waiting-permission":
      return "Waiting for permission…";
    case "classifier":
      return "Auto classifier checking…";
    default:
      return null;
  }
}

interface ToolCallListProps {
  toolCalls: ToolCallInfo[];
  /** Extra breathing room when the first visible thing after a prompt is a tool. */
  leadingMarginTop?: number;
}

// Source's ShellProgressMessage shows the trailing 5 lines while a command
// runs; the full output lands in history / the Ctrl+O transcript.
const BASH_TAIL_LINES = 5;

/**
 * The `(elapsed · timeout Xs)` hint, mirroring source's ShellTimeDisplay:
 *   - no timeout      → `(4s)`
 *   - with timeout    → `(4s · timeout 2m)`
 *   - before first ms → `(timeout 2m)`
 */
function shellTimeHint(elapsedSec: number | undefined, timeoutMs?: number): string {
  const timeout = timeoutMs ? formatDuration(timeoutMs, { hideTrailingZeros: true }) : undefined;
  if (elapsedSec === undefined) {
    return timeout ? `(timeout ${timeout})` : "";
  }
  const elapsed = formatDuration(elapsedSec * 1000);
  return timeout ? `(${elapsed} · timeout ${timeout})` : `(${elapsed})`;
}

/**
 * Live tail of a running Bash command, mirroring source's ShellProgressMessage:
 *   - last 5 output lines (dim)
 *   - a status row: `+N lines`/`~N lines` · `(elapsed · timeout Xs)` · bytes
 *   - before any output: a bare `Running… (elapsed · timeout)` line
 */
function BashProgressBody({ progress }: { progress: BashProgress }): React.ReactNode {
  const elapsedSec = Math.max(0, Math.floor((Date.now() - progress.startTime) / 1000));
  const lines = progress.output.split("\n").filter((l) => l.length > 0);
  const tail = lines.slice(-BASH_TAIL_LINES);

  // No output yet → just the running spinner + time/timeout hint.
  if (tail.length === 0) {
    return (
      <ResultLine>
        <Text color={theme.muted}>{`Running… ${shellTimeHint(elapsedSec, progress.timeoutMs)}`}</Text>
      </ResultLine>
    );
  }

  // `+N lines`  → exact overflow past the 5 shown (full output still retained).
  // `~N lines`  → the preview buffer dropped earlier lines, so what's shown is a
  //               tail sample of a large output — flag the total as approximate.
  const retainedCount = progress.output.split("\n").length;
  const previewDroppedLines = progress.totalLines > retainedCount;
  const extraLines = Math.max(0, progress.totalLines - BASH_TAIL_LINES);
  let lineStatus = "";
  if (extraLines > 0) {
    lineStatus = previewDroppedLines ? `~${progress.totalLines} lines` : `+${extraLines} lines`;
  }

  const statusBits = [
    lineStatus,
    shellTimeHint(elapsedSec, progress.timeoutMs),
    progress.totalBytes > 0 ? formatFileSize(progress.totalBytes) : "",
  ].filter(Boolean);

  return (
    <Box flexDirection="column">
      {tail.map((l, i) => (
        <Box key={i} paddingLeft={2}>
          <Text color={theme.muted} dimColor wrap="truncate-end">
            {l || " "}
          </Text>
        </Box>
      ))}
      {statusBits.length > 0 ? (
        <ResultLine>
          <Text color={theme.muted}>{statusBits.join("  ")}</Text>
        </ResultLine>
      ) : null}
    </Box>
  );
}

/** One in-flight tool card (header + phase sub-line / progress / result). */
function SingleToolCard({ toolCall }: { toolCall: ToolCallInfo }): React.ReactNode {
  const pending = toolCall.resultLength === undefined;
  // Live cards have only the input (no result content yet), so result-derived
  // tags (WebFetch status) appear once archived — input tags (timeout, MCP
  // server) show immediately.
  const tag = toolUseTag(toolCall.name, toolCall.input);

  const line = summarizeTool(toolCall.name, toolCall.input);
  // Use the model-facing displayName override when present (e.g.
  // "Updated plan"), else the summarized label.
  if (toolCall.displayName) line.label = toolCall.displayName;

  if (pending) {
    const headerLine = { label: toolCall.displayName ?? line.label, target: line.target };
    // The live phase drives the dot + an optional sub-line. Absent
    // status = queued (model emitted the call, loop hasn't started it).
    const liveState: ToolState = toolCall.status ?? "queued";

    // Bash: while the command runs, show its streaming tail under the
    // header so long commands (installs, test runs, `find /`) aren't a
    // frozen spinner. Falls back to the bare header before the first
    // chunk arrives or for non-Bash tools.
    if (toolCall.name === "Bash" && toolCall.bashProgress) {
      return (
        <Box flexDirection="column">
          <ToolCardHeader line={headerLine} state="running" tag={tag} />
          <BashProgressBody progress={toolCall.bashProgress} />
        </Box>
      );
    }

    if (toolCall.name.startsWith("mcp__") && toolCall.mcpProgress) {
      const progress = toolCall.mcpProgress;
      return (
        <Box flexDirection="column">
          <ToolCardHeader line={headerLine} state="running" tag={tag} />
          <ResultLine>
            <Text color={theme.muted}>
              {`Progress ${progress.progress}${progress.total === undefined ? "" : `/${progress.total}`}${progress.message ? ` · ${progress.message}` : ""}`}
            </Text>
          </ResultLine>
        </Box>
      );
    }

    const phaseText = phaseSubLine(liveState);
    return (
      <Box flexDirection="column">
        <ToolCardHeader line={headerLine} state={liveState} tag={tag} />
        {phaseText ? (
          <ResultLine>
            <Text color={theme.muted}>{phaseText}</Text>
          </ResultLine>
        ) : null}
      </Box>
    );
  }

  if (toolCall.isError) {
    return (
      <Box flexDirection="column">
        <ToolCardHeader line={line} state="error" tag={tag} />
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
    <Box flexDirection="column">
      <ToolCardHeader line={line} state="ok" tag={tag} />
      <ToolResultSummary line={line} />
    </Box>
  );
}

// A run of this many consecutive read/search/list calls collapses into one
// live summary card (mirrors source's collapseReadSearch min group size).
const LIVE_GROUP_MIN = 2;

/** True when an in-flight card can fold into a live read/search summary. */
function isLiveCollapsible(tc: ToolCallInfo): boolean {
  if (tc.name === "Agent") return false;
  if (tc.isError) return false; // an errored call breaks the run, shown on its own
  return classifyToolForCollapse(tc.name, tc.input) !== null;
}

/**
 * Live collapsed card for a run of consecutive read/search/list/MCP/memory
 * calls. While any member is still in flight, the summary uses present tense +
 * a blinking dot ("Reading 5 files…"); once all land it reads past tense
 * ("Read 5 files"). The `⎿` line previews the most recent target so the user
 * sees what's being touched right now. Mirrors source's CollapsedReadSearchContent.
 */
function LiveGroupedCard({ members }: { members: ToolCallInfo[] }): React.ReactNode {
  const anyPending = members.some((m) => m.resultLength === undefined);
  const { counts, targets } = computeCollapsedCounts(
    members.map((m) => ({ name: m.name, input: m.input })),
  );
  const label = getCollapsedSummaryText(counts, anyPending);
  const state: ToolState = anyPending ? "running" : "ok";
  const hint = targets.length > 0 ? targets[targets.length - 1] : undefined;

  return (
    <Box flexDirection="column">
      <Box>
        <ToolDot state={state} />
        <Text bold>{label}</Text>
      </Box>
      {hint ? (
        <ResultLine>
          <Text color={theme.muted} wrap="truncate-end">{hint}</Text>
        </ResultLine>
      ) : null}
    </Box>
  );
}

type RenderUnit =
  | { kind: "single"; toolCall: ToolCallInfo; key: string }
  | { kind: "group"; members: ToolCallInfo[]; key: string };

/** Partition the live tool calls into single cards and collapsed runs. */
function buildRenderUnits(toolCalls: ToolCallInfo[]): RenderUnit[] {
  const units: RenderUnit[] = [];
  let i = 0;
  while (i < toolCalls.length) {
    const tc = toolCalls[i]!;
    if (isLiveCollapsible(tc)) {
      let j = i;
      while (j < toolCalls.length && isLiveCollapsible(toolCalls[j]!)) j++;
      const run = toolCalls.slice(i, j);
      if (run.length >= LIVE_GROUP_MIN) {
        units.push({ kind: "group", members: run, key: `grp${run[0]!.id || i}` });
      } else {
        units.push({ kind: "single", toolCall: run[0]!, key: run[0]!.id || `tc${i}` });
      }
      i = j;
    } else {
      units.push({ kind: "single", toolCall: tc, key: tc.id || `tc${i}` });
      i += 1;
    }
  }
  return units;
}

/**
 * Live (in-flight) tool cards. Shows the same `● Label(target)` header + `⎿`
 * one-line summary as the historical `InlineToolCard`, so a card doesn't
 * visually jump when it lands in <Static> history. Consecutive read/search
 * calls collapse into a single active summary line (present tense while
 * running) — the same grouping the history view applies once results land.
 */
export function ToolCallList({ toolCalls, leadingMarginTop = 0 }: ToolCallListProps): React.ReactNode {
  toolCalls = toolCalls.filter((call) => call.name !== "ToolSearch" || call.isError);
  if (toolCalls.length === 0) {
    return null;
  }

  const units = buildRenderUnits(toolCalls);

  return (
    <Box flexDirection="column" marginTop={leadingMarginTop}>
      {units.map((unit) => {
        if (unit.kind === "group") {
          return <LiveGroupedCard key={unit.key} members={unit.members} />;
        }
        // Agent tool always uses the rich SubAgentCard renderer — both
        // while running (live counters from the progress store) and
        // after completion (final stats baked into the snapshot).
        if (unit.toolCall.name === "Agent" && unit.toolCall.subAgentProgress) {
          return <SubAgentCard key={unit.key} toolCall={unit.toolCall} />;
        }
        return <SingleToolCard key={unit.key} toolCall={unit.toolCall} />;
      })}
    </Box>
  );
}
