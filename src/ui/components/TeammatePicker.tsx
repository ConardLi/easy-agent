/**
 * TeammatePicker — overlay list of running background sub-agents the
 * user can pick from to view their transcript.
 *
 * Mounted by App.tsx when `teammateViewStore.mode === 'selecting'`.
 *
 * Layout:
 *
 *   ─── Select teammate (↑↓ navigate · Enter view · Esc cancel · k kill) ───
 *   ▶ backend · general-purpose  (4 tools, 1.8k tokens, 12s)  last: Write
 *     frontend · general-purpose (2 tools, 0.6k tokens, 8s)   last: Read
 *     reviewer · security-review (7 tools, 2.4k tokens, 22s)  last: Grep
 *
 * The picker cursor is driven by hooks/useTeammateNavigation.ts.
 *
 * Why a separate component (not inlined in BackgroundAgentBar):
 *   BackgroundAgentBar is always-on per-row summary. The picker is a
 *   modal-ish overlay only visible while selecting. Keeping the two
 *   apart lets either layout change without affecting the other.
 */

import type React from "react";
import { Box, Text } from "ink";
import type { AsyncAgentEntry } from "../../state/asyncAgentStore.js";

interface TeammatePickerProps {
  agents: AsyncAgentEntry[];
  selectedAgentId: string | null;
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

function summarise(agent: AsyncAgentEntry, now: number): string {
  const parts: string[] = [];
  if (agent.toolUseCount > 0) {
    parts.push(`${agent.toolUseCount} tool${agent.toolUseCount === 1 ? "" : "s"}`);
  }
  if (agent.totalTokens && agent.totalTokens > 0) {
    parts.push(`${formatNumber(agent.totalTokens)} tokens`);
  }
  const started = Date.parse(agent.startedAt);
  if (Number.isFinite(started)) parts.push(formatDuration(now - started));
  return parts.length > 0 ? `(${parts.join(", ")})` : "";
}

export function TeammatePicker({ agents, selectedAgentId }: TeammatePickerProps): React.ReactNode {
  // Picker only includes still-running agents — completed / failed /
  // killed transcripts are still readable via `Read <output_file>` for
  // power users, but cluttering the picker with stale entries is bad UX.
  const running = agents.filter((a) => a.status === "running");
  if (running.length === 0) return null;

  const now = Date.now();

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>{"─── Select teammate (↑↓ navigate · Enter view · Esc cancel · k kill) ".padEnd(80, "─")}</Text>
      {running.map((agent) => {
        const isSelected = agent.agentId === selectedAgentId;
        const label = agent.teammateName ? `${agent.teammateName} · ${agent.agentType}` : agent.agentType;
        const lastTool = agent.lastToolName ? `  last: ${agent.lastToolName}` : "";
        const prefix = isSelected ? "▶ " : "  ";
        return (
          <Box key={agent.agentId}>
            <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
              {prefix}
              {label}
            </Text>
            <Text dimColor>{`  ${summarise(agent, now)}${lastTool}`}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
