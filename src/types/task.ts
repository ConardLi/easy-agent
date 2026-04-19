/**
 * Task V2 data model.
 *
 * Mirrors `claude-code-source-code/src/utils/tasks.ts::TaskSchema`:
 *   - id is an incrementing numeric string ("1", "2", ...), stable across
 *     restarts thanks to the high water mark file.
 *   - `blocks` / `blockedBy` store task ids, maintained bidirectionally by
 *     the store so the model only has to set one side.
 *   - `owner` is kept in the schema for forward-compat with multi-agent
 *     (stage 24+). Single-agent never writes it.
 *   - `metadata` is a free-form bag for tool-specific state (e.g. hooks,
 *     verification flags). Nothing in V2 depends on it.
 */

export const TASK_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface Task {
  /** Incrementing numeric id as string. */
  id: string;
  /** Imperative one-liner, e.g. "Run the tests". */
  subject: string;
  /** Detailed description of the work. */
  description: string;
  /** Present-continuous form shown in the spinner when in_progress. */
  activeForm?: string;
  /** Agent id that owns the task. Multi-agent hook; single-agent leaves empty. */
  owner?: string;
  status: TaskStatus;
  /** Task ids this task blocks (downstream). */
  blocks: string[];
  /** Task ids that block this task (upstream). */
  blockedBy: string[];
  /** Arbitrary tool-specific metadata. */
  metadata?: Record<string, unknown>;
}
