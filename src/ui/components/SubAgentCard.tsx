/**
 * SubAgentCard — rich tool-call card for `Agent` invocations.
 *
 * Replaces the bare "⚡ Using tool: Agent" line you'd otherwise see for
 * every sub-agent call, built from the data flowing through
 * `subAgentProgressStore`.
 *
 * Layout:
 *
 *   ⚡ Agent[Explore]  Quick project tour   · running                  ← header
 *      └ 3 tool uses · last: Read                                       ← live
 *      OR
 *      └ Done · 7 tool uses · 4231 tokens · 12.3s                       ← final
 *
 * Failure / max_turns / aborted variants swap the leading icon and tag.
 *
 * Why a dedicated component (vs. extending ToolCallList):
 *   The Agent card has fundamentally different semantics — one
 *   tool_use spawns dozens of inner tool_uses, each of which the user
 *   wants to track. Cramming all that into the per-line ToolCallList
 *   renderer would couple it to sub-agent details forever. A separate
 *   component keeps the simple card simple.
 */

import type React from "react";
import { Box, Text } from "ink";
import type { ToolCallInfo } from "../types.js";
import type { SubAgentStatus } from "../../state/subAgentProgressStore.js";

interface SubAgentCardProps {
  toolCall: ToolCallInfo;
}

function statusGlyph(status: SubAgentStatus): { glyph: string; color: string } {
  switch (status) {
    case "completed":
      return { glyph: "✓", color: "green" };
    case "error":
      return { glyph: "✗", color: "red" };
    case "max_turns":
      return { glyph: "⚠", color: "yellow" };
    case "aborted":
      return { glyph: "⊘", color: "yellow" };
    default:
      return { glyph: "⚡", color: "yellow" };
  }
}

function statusLabel(status: SubAgentStatus): string {
  switch (status) {
    case "completed":
      return "Done";
    case "error":
      return "Failed";
    case "max_turns":
      return "Stopped (max turns)";
    case "aborted":
      return "Aborted";
    default:
      return "Running";
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const rem = Math.round(sec - min * 60);
  return `${min}m${rem}s`;
}

function formatNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}m`;
}

export function SubAgentCard({ toolCall }: SubAgentCardProps): React.ReactNode {
  const progress = toolCall.subAgentProgress;

  // Defensive fallback: card should always have a snapshot by the time
  // this renders (we seed at tool_use_start), but if the Agent body
  // failed to publish, fall back to the basic ToolCallList rendering.
  if (!progress) {
    return (
      <Box marginLeft={2}>
        <Text color="yellow">{"  ⚡ Using tool: Agent (initializing…)"}</Text>
      </Box>
    );
  }

  const { glyph, color } = statusGlyph(progress.status);
  const isRunning = progress.status === "running";

  // Header line: glyph + Agent[<label>] + description + status tag.
  //
  // Label selection:
  //   - Plain sub-agent              → "[<agentType>]"      e.g. "[Explore]"
  //   - Agent Teams teammate         → "[<name> · <agentType>]"
  //                                    e.g. "[backend · general-purpose]"
  //
  // The teammate `name` is the only thing that distinguishes one
  // teammate from another when several share the same agentType
  // (e.g. backend + frontend + reviewer all running `general-purpose`).
  // Without it the UI shows three identical "Agent[general-purpose]"
  // cards and the user can't tell which is which. The agentType still
  // travels along after a "·" because seeing the underlying agent
  // definition is useful for debugging custom roles.
  const label = progress.teammateName ? `${progress.teammateName} · ${progress.agentType}` : progress.agentType;
  const header = (
    <Box>
      <Text color={color}>
        {"  "}
        {glyph}
        {" Agent"}
      </Text>
      <Text bold color={color}>
        {`[${label}]`}
      </Text>
      {progress.description ? <Text>{`  ${progress.description}`}</Text> : null}
      <Text dimColor>{`  · ${statusLabel(progress.status)}`}</Text>
    </Box>
  );

  // Body line(s):
  //   Running → "<count> tool uses · <tokens> tokens · last: <name>"
  //   Done    → "<count> tool uses · <tokens> tokens · <duration>"
  // Token line is live — agentTool publishes cumulative usage from each
  // sub-agent turn into the store, so this number ticks upward while
  // the sub-agent is still working ("17 tool uses · 28.0k tokens"
  // mid-flight, side-by-side with sibling agents in a parallel batch).
  let body: React.ReactNode = null;
  if (isRunning) {
    const parts: string[] = [];
    if (progress.toolUseCount > 0) {
      parts.push(`${progress.toolUseCount} tool use${progress.toolUseCount === 1 ? "" : "s"}`);
    }
    if (progress.totalTokens && progress.totalTokens > 0) {
      parts.push(`${formatNumber(progress.totalTokens)} tokens`);
    }
    if (progress.lastToolName) {
      const errorTag = progress.lastToolIsError ? " (error)" : "";
      parts.push(`last: ${progress.lastToolName}${errorTag}`);
    }
    if (parts.length === 0) {
      parts.push("Initializing…");
    }
    body = (
      <Box marginLeft={4}>
        <Text dimColor>{`└ ${parts.join(" · ")}`}</Text>
      </Box>
    );
  } else {
    const parts: string[] = [];
    parts.push(`${progress.toolUseCount} tool use${progress.toolUseCount === 1 ? "" : "s"}`);
    if (progress.totalTokens && progress.totalTokens > 0) {
      parts.push(`${formatNumber(progress.totalTokens)} tokens`);
    }
    if (progress.durationMs !== undefined) {
      parts.push(formatDuration(progress.durationMs));
    }
    body = (
      <Box marginLeft={4}>
        <Text dimColor>{`└ ${parts.join(" · ")}`}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginLeft={2}>
      {header}
      {body}
    </Box>
  );
}
