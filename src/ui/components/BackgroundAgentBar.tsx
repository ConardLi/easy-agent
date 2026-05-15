/**
 * BackgroundAgentBar — persistent footer line for background sub-agents.
 *
 * Inspired by Claude Code's `BackgroundTaskStatus.tsx`. The source shows
 * a clickable pill ("[ N background tasks ]") that expands into a
 * BackgroundTasksDialog modal. We keep just the pill + an inline summary
 * of each running agent — no dialog yet, since opening a modal in Ink
 * would require routing through usePromptInput's keyboard handler.
 *
 * Layout (only rendered when there's at least one running agent):
 *
 *   ━━━ Background Agents ─────────────────────────────────────────────
 *   ⚡ 2 running  ·  Explore (3 tools, 1.2k tokens, 4s)  ·  reviewer (5 tools, 2.4k tokens, 8s)
 *
 * Recently-finished agents (completed / failed / killed) are NOT shown
 * in this bar — the `<task-notification>` injected into the conversation
 * is the proper surface for that. Otherwise the bar would slowly grow
 * into a wall of historical entries.
 *
 * Re-render strategy:
 *   The hook providing `agents` re-snapshots the asyncAgentStore on
 *   every store event. With no running agents we render `null` — Ink
 *   then collapses the row entirely (no ghost line).
 */

import React from "react";
import { Box, Text } from "ink";
import type { AsyncAgentEntry } from "../../state/asyncAgentStore.js";

interface BackgroundAgentBarProps {
  agents: AsyncAgentEntry[];
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(0)}s`;
  const min = Math.floor(sec / 60);
  const rem = Math.round(sec - min * 60);
  return `${min}m${rem}s`;
}

function formatNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}m`;
}

/**
 * Build the per-agent inline summary, e.g. "Explore (3 tools, 1.2k
 * tokens, 4s)". The `agentType` is enough for the user to recognise
 * which sub-agent is which — `description` is omitted to keep each
 * entry short enough for a single line. Users who want details look at
 * the .output file or wait for the task-notification.
 */
function summariseAgent(agent: AsyncAgentEntry, now: number): string {
  const parts: string[] = [];
  if (agent.toolUseCount > 0) {
    parts.push(`${agent.toolUseCount} tool${agent.toolUseCount === 1 ? "" : "s"}`);
  }
  if (agent.totalTokens && agent.totalTokens > 0) {
    parts.push(`${formatNumber(agent.totalTokens)} tokens`);
  }
  // Compute elapsed off the entry's startedAt timestamp. We use the
  // hook's `now` snapshot instead of Date.now() inside the function so
  // a single render frame produces consistent durations across all
  // entries (no row jitter when the loop iterates).
  const started = Date.parse(agent.startedAt);
  if (Number.isFinite(started)) {
    parts.push(formatDuration(now - started));
  }
  if (agent.lastToolName) {
    parts.push(`last: ${agent.lastToolName}`);
  }
  return `${agent.agentType}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
}

export function BackgroundAgentBar({
  agents,
}: BackgroundAgentBarProps): React.ReactNode {
  const running = agents.filter((a) => a.status === "running");
  if (running.length === 0) return null;

  // Single now-snapshot — see summariseAgent comment for why.
  const now = Date.now();

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>{"─── Background Agents ".padEnd(60, "─")}</Text>
      <Box>
        <Text color="yellow">{"⚡ "}</Text>
        <Text color="yellow">{`${running.length} running`}</Text>
        <Text dimColor>  ·  </Text>
        <Text>{running.map((a) => summariseAgent(a, now)).join("  ·  ")}</Text>
      </Box>
    </Box>
  );
}
