/**
 * TaskList — read-only rendering of the persistent task graph.
 *
 * Mirrors `claude-code-source-code/src/components/TaskListV2.tsx` minus
 * the multi-agent / teammate pieces (owner colors, activity summaries,
 * shut-down tracking). Single-agent only needs status, subject, and
 * blocker info.
 *
 * Rendering rules, same as TodoList:
 *   - every row is STATIC (no per-row spinner) — the live "active task"
 *     verb is rendered once by the global StatusBar spinner via
 *     `effectiveSpinnerLabel` in App.tsx. Adding a setInterval per row
 *     multiplies terminal repaints and reintroduces the flicker we
 *     fought in stage 14.
 *   - React.memo with a structural comparator prevents siblings of
 *     streamingText from forcing re-renders through us.
 */

import React from "react";
import { Box, Text } from "ink";
import type { Task } from "../../types/task.js";

interface TaskListProps {
  tasks: Task[];
}

function TaskListInner({ tasks }: TaskListProps): React.ReactNode {
  if (tasks.length === 0) return null;

  const sorted = [...tasks].sort((a, b) => Number(a.id) - Number(b.id));
  const completed = sorted.filter((t) => t.status === "completed").length;
  const inProgress = sorted.filter((t) => t.status === "in_progress").length;
  const pending = sorted.length - completed - inProgress;

  // Open-blocker filter: a completed upstream task no longer blocks
  // anyone. Mirrors TaskListV2 so the tree display matches what the
  // model sees from TaskList tool results.
  const unresolvedIds = new Set(sorted.filter((t) => t.status !== "completed").map((t) => t.id));

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box marginLeft={2}>
        <Text bold color="cyan">{"\u25A2 Tasks "}</Text>
        <Text dimColor>
          {`(${completed}/${sorted.length} done`}
          {inProgress > 0 ? `, ${inProgress} in progress` : ""}
          {pending > 0 ? `, ${pending} open` : ""}
          {")"}
        </Text>
      </Box>
      {sorted.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          openBlockers={task.blockedBy.filter((id) => unresolvedIds.has(id))}
        />
      ))}
    </Box>
  );
}

function TaskRow({ task, openBlockers }: { task: Task; openBlockers: string[] }): React.ReactNode {
  const isBlocked = openBlockers.length > 0;

  if (task.status === "completed") {
    return (
      <Box marginLeft={4}>
        <Text color="green">{"\u2713 "}</Text>
        <Text dimColor>{`#${task.id} `}</Text>
        <Text strikethrough dimColor>{task.subject}</Text>
      </Box>
    );
  }

  if (task.status === "in_progress") {
    const label = task.activeForm || task.subject;
    return (
      <Box marginLeft={4}>
        <Text color="yellow">{"\u25B8 "}</Text>
        <Text dimColor>{`#${task.id} `}</Text>
        <Text color="yellow">{label}</Text>
        {isBlocked && (
          <Text color="red" dimColor>
            {` [blocked by ${openBlockers.map((id) => `#${id}`).join(", ")}]`}
          </Text>
        )}
      </Box>
    );
  }

  return (
    <Box marginLeft={4}>
      <Text dimColor>{"\u25CB "}</Text>
      <Text dimColor>{`#${task.id} ${task.subject}`}</Text>
      {isBlocked && (
        <Text color="red" dimColor>
          {` [blocked by ${openBlockers.map((id) => `#${id}`).join(", ")}]`}
        </Text>
      )}
    </Box>
  );
}

function areTaskListsEqual(prev: TaskListProps, next: TaskListProps): boolean {
  if (prev.tasks === next.tasks) return true;
  if (prev.tasks.length !== next.tasks.length) return false;
  for (let i = 0; i < prev.tasks.length; i++) {
    const a = prev.tasks[i];
    const b = next.tasks[i];
    if (
      a.id !== b.id ||
      a.status !== b.status ||
      a.subject !== b.subject ||
      a.activeForm !== b.activeForm ||
      a.blockedBy.length !== b.blockedBy.length
    ) {
      return false;
    }
    for (let j = 0; j < a.blockedBy.length; j++) {
      if (a.blockedBy[j] !== b.blockedBy[j]) return false;
    }
  }
  return true;
}

export const TaskList = React.memo(TaskListInner, areTaskListsEqual);
