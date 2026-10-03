/**
 * TeammateViewer — read-only viewer for one background sub-agent's
 * `.output` JSONL transcript.
 *
 * Mounted by App.tsx when `teammateViewStore.mode === 'viewing'`.
 * Replaces the main `ConversationView` for the duration of the view.
 *
 * Layout:
 *
 *   ─── Viewing: backend · general-purpose · running (Esc to return) ───
 *   ⏵ Started general-purpose — fix the auth bug
 *   ⚡ Read
 *     └ ok (1240 chars): export async function login...
 *   ⚡ Edit
 *     └ ok (54 chars)
 *   · turn 2: 1842 tokens (in 1310, out 532)
 *   ⚡ Bash
 *     └ ok (12 chars): no errors
 *   ✓ Done · completed · 8421ms · 3 tool uses · 2541 tokens
 *
 * A teammate's message history is not kept in memory (background agents
 * run in their own loop and only persist to the .output file), so we
 * read+poll the file instead — see useTaskOutputLive below.
 *
 * Why we only show the last N records:
 *   Long-running sub-agents can rack up hundreds of events. Rendering
 *   all of them in Ink causes a full-frame repaint per state tick and
 *   the terminal becomes unusable. We render the most recent
 *   MAX_RENDER_LINES with an "…N earlier events" indicator at the top.
 */

import type React from "react";
import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { AsyncAgentEntry } from "../../state/asyncAgentStore.js";
import {
  formatRecordLine,
  readTaskOutputEvents,
  type TaskOutputRecord,
} from "../../utils/taskOutputReader.js";

interface TeammateViewerProps {
  agent: AsyncAgentEntry;
}

const POLL_INTERVAL_MS = 1000;
const MAX_RENDER_LINES = 40;

/**
 * Subscribe a viewer component to a `.output` file: initial read +
 * polling every 1s until the agent leaves the `running` status.
 *
 * Returns [records, isLoading]. While loading, records is whatever has
 * been read so far (often [] on first paint).
 */
function useTaskOutputLive(
  filePath: string,
  isAgentRunning: boolean,
): [TaskOutputRecord[], boolean] {
  const [records, setRecords] = useState<TaskOutputRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function tick(): Promise<void> {
      try {
        const next = await readTaskOutputEvents(filePath);
        if (cancelled) return;
        setRecords(next);
        setIsLoading(false);
      } catch {
        // Best-effort. A transient EBUSY (Windows) or partial write is
        // not worth crashing the viewer over — next tick will retry.
      }
    }

    void tick(); // initial read

    if (!isAgentRunning) {
      // Single read is enough — file is no longer growing.
      return () => {
        cancelled = true;
      };
    }
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [filePath, isAgentRunning]);

  return [records, isLoading];
}

export function TeammateViewer({ agent }: TeammateViewerProps): React.ReactNode {
  const isRunning = agent.status === "running";
  const [records, isLoading] = useTaskOutputLive(agent.outputFile, isRunning);

  const label = agent.teammateName
    ? `${agent.teammateName} · ${agent.agentType}`
    : agent.agentType;

  const statusColor =
    agent.status === "completed"
      ? "green"
      : agent.status === "failed"
        ? "red"
        : agent.status === "killed"
          ? "yellow"
          : "cyan";

  const visible = records.slice(-MAX_RENDER_LINES);
  const droppedCount = Math.max(0, records.length - visible.length);

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color="cyan">
        {`─── Viewing: ${label} · `}
        <Text color={statusColor}>{agent.status}</Text>
        {` (Esc to return) `.padEnd(Math.max(0, 80 - 60 - label.length), "─")}
      </Text>
      {agent.description ? (
        <Text dimColor>{`  task: ${agent.description}`}</Text>
      ) : null}
      <Text dimColor>{`  output: ${agent.outputFile}`}</Text>

      {droppedCount > 0 ? (
        <Text dimColor>{`  … (${droppedCount} earlier events hidden)`}</Text>
      ) : null}

      {records.length === 0 ? (
        <Text dimColor>
          {isLoading ? "  Waiting for first event…" : "  (no events yet)"}
        </Text>
      ) : (
        visible.map((r, i) => (
          // Index key is OK: this list is append-only and we slice from
          // the end, so a given index always corresponds to the same
          // logical position-from-tail. React won't get confused.
          <Text key={i} dimColor={r.event.type === "turn_usage"}>
            {`  ${formatRecordLine(r)}`}
          </Text>
        ))
      )}

      <Text dimColor>{"─".repeat(80)}</Text>
    </Box>
  );
}
