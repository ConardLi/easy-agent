/**
 * Task V2 store — persistent task graph on disk.
 *
 * Replicates `claude-code-source-code/src/utils/tasks.ts`, dropping the
 * multi-agent pieces (teammate mailbox, claim-with-busy-check, team name
 * resolution) since Easy Agent is single-agent in stage 15.
 *
 * Layout (per task list):
 *
 *   ~/.easy-agent/tasks/<taskListId>/
 *     1.json
 *     2.json
 *     .highwatermark   <-- max id ever assigned, survives deletes/reset
 *     .lock            <-- proper-lockfile target for list-level ops
 *
 * One file per task gives us:
 *   - atomic per-task writes without reading the whole list
 *   - human-editable state (user can delete/move a single .json)
 *   - per-task locks so independent updates don't serialize
 *
 * `proper-lockfile` is used for list-level critical sections
 * (createTask, resetTaskList) to ensure id allocation and reset are
 * serialized across the process. Per-task updates use per-file locks.
 */

import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import lockfile from "proper-lockfile";
import type { Task, TaskStatus } from "../types/task.js";
import { TASK_STATUSES } from "../types/task.js";

const EASY_AGENT_HOME = path.join(os.homedir(), ".easy-agent");
const TASKS_ROOT = path.join(EASY_AGENT_HOME, "tasks");

const HIGH_WATER_MARK_FILE = ".highwatermark";
const LOCK_FILE = ".lock";

// Retry budget matches the source: ~2.6s worst-case wait so concurrent
// callers queue rather than error out. Single-agent rarely contends, but
// a stray orphan process (e.g. a crashed earlier run) should still work.
const LOCK_OPTIONS = {
  retries: {
    retries: 30,
    minTimeout: 5,
    maxTimeout: 100,
  },
};

// ─── Path helpers ──────────────────────────────────────────────────

/**
 * File-path sanitization. We restrict taskListId / taskId components to
 * the character class `[A-Za-z0-9_-]` — anything else becomes `-`. This
 * blocks `../` traversal and arbitrary symlink targets the model might
 * dream up when it sees the raw session id.
 */
export function sanitizePathComponent(input: string): string {
  return input.replace(/[^A-Za-z0-9_-]/g, "-");
}

/**
 * Resolve a sessionId to the corresponding task-list id.
 *
 * Single-agent keeps this 1-to-1. The function exists mostly as a seam
 * for future multi-agent work (leader team name, teammate context) —
 * callers shouldn't assume sessionId itself is safe to use as a path.
 */
export function getTaskListId(sessionId: string): string {
  return sessionId || "default";
}

export function getTasksDir(taskListId: string): string {
  return path.join(TASKS_ROOT, sanitizePathComponent(taskListId));
}

export function getTaskPath(taskListId: string, taskId: string): string {
  return path.join(getTasksDir(taskListId), `${sanitizePathComponent(taskId)}.json`);
}

async function ensureTasksDir(taskListId: string): Promise<void> {
  await mkdir(getTasksDir(taskListId), { recursive: true });
}

/**
 * Ensure the list-level lock file exists.
 *
 * `proper-lockfile` refuses to lock a path that doesn't exist, so we
 * touch an empty sentinel file first. The `wx` flag makes the creation
 * idempotent across concurrent callers — the second writer's EEXIST is
 * benign and swallowed.
 */
async function ensureTaskListLockFile(taskListId: string): Promise<string> {
  await ensureTasksDir(taskListId);
  const lockPath = path.join(getTasksDir(taskListId), LOCK_FILE);
  try {
    await writeFile(lockPath, "", { flag: "wx" });
  } catch {
    // Already exists — fine.
  }
  return lockPath;
}

// ─── High water mark ───────────────────────────────────────────────

function getHighWaterMarkPath(taskListId: string): string {
  return path.join(getTasksDir(taskListId), HIGH_WATER_MARK_FILE);
}

async function readHighWaterMark(taskListId: string): Promise<number> {
  try {
    const content = (await readFile(getHighWaterMarkPath(taskListId), "utf-8")).trim();
    const value = parseInt(content, 10);
    return Number.isNaN(value) ? 0 : value;
  } catch {
    return 0;
  }
}

async function writeHighWaterMark(taskListId: string, value: number): Promise<void> {
  await writeFile(getHighWaterMarkPath(taskListId), String(value));
}

async function findHighestTaskIdFromFiles(taskListId: string): Promise<number> {
  let files: string[];
  try {
    files = await readdir(getTasksDir(taskListId));
  } catch {
    return 0;
  }
  let highest = 0;
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const parsed = parseInt(file.replace(".json", ""), 10);
    if (!Number.isNaN(parsed) && parsed > highest) {
      highest = parsed;
    }
  }
  return highest;
}

async function findHighestTaskId(taskListId: string): Promise<number> {
  const [fromFiles, fromMark] = await Promise.all([
    findHighestTaskIdFromFiles(taskListId),
    readHighWaterMark(taskListId),
  ]);
  return Math.max(fromFiles, fromMark);
}

// ─── Validation ────────────────────────────────────────────────────

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

function parseTask(raw: unknown): Task | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || typeof obj.subject !== "string") return null;
  if (typeof obj.description !== "string") return null;
  if (!isTaskStatus(obj.status)) return null;
  const blocks = Array.isArray(obj.blocks) ? obj.blocks.filter((x): x is string => typeof x === "string") : [];
  const blockedBy = Array.isArray(obj.blockedBy) ? obj.blockedBy.filter((x): x is string => typeof x === "string") : [];
  return {
    id: obj.id,
    subject: obj.subject,
    description: obj.description,
    activeForm: typeof obj.activeForm === "string" ? obj.activeForm : undefined,
    owner: typeof obj.owner === "string" ? obj.owner : undefined,
    status: obj.status,
    blocks,
    blockedBy,
    metadata:
      obj.metadata && typeof obj.metadata === "object" && !Array.isArray(obj.metadata)
        ? (obj.metadata as Record<string, unknown>)
        : undefined,
  };
}

// ─── Signal (for UI refresh) ───────────────────────────────────────

type TaskListener = (taskListId: string) => void;
const taskListeners = new Set<TaskListener>();

/**
 * Subscribe to in-process task updates. Listeners fire after every
 * mutation (create/update/delete/reset). Filter by taskListId in the
 * subscriber — the store has no per-list channels.
 */
export function subscribeTasks(listener: TaskListener): () => void {
  taskListeners.add(listener);
  return () => {
    taskListeners.delete(listener);
  };
}

function notifyTasksUpdated(taskListId: string): void {
  for (const listener of taskListeners) {
    try {
      listener(taskListId);
    } catch {
      // Never let UI subscribers break a mutation.
    }
  }
}

// ─── CRUD ──────────────────────────────────────────────────────────

/**
 * Create a new task. Uses a list-level lock so concurrent creators
 * can't collide on the same id.
 */
export async function createTask(
  taskListId: string,
  data: Omit<Task, "id">,
): Promise<string> {
  const lockPath = await ensureTaskListLockFile(taskListId);
  const release = await lockfile.lock(lockPath, LOCK_OPTIONS);
  try {
    const highest = await findHighestTaskId(taskListId);
    const id = String(highest + 1);
    const task: Task = { id, ...data };
    await writeFile(getTaskPath(taskListId, id), JSON.stringify(task, null, 2));
    notifyTasksUpdated(taskListId);
    return id;
  } finally {
    await release();
  }
}

export async function getTask(taskListId: string, taskId: string): Promise<Task | null> {
  try {
    const content = await readFile(getTaskPath(taskListId, taskId), "utf-8");
    return parseTask(JSON.parse(content));
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") return null;
    return null;
  }
}

export async function listTasks(taskListId: string): Promise<Task[]> {
  let files: string[];
  try {
    files = await readdir(getTasksDir(taskListId));
  } catch {
    return [];
  }
  const ids = files.filter((f) => f.endsWith(".json") && !f.startsWith(".")).map((f) => f.replace(".json", ""));
  const tasks = await Promise.all(ids.map((id) => getTask(taskListId, id)));
  return tasks.filter((t): t is Task => t !== null);
}

/**
 * Internal update primitive — caller must already hold the per-task lock.
 * Used by deleteTask's cascade to avoid acquiring a lock we already own.
 */
async function updateTaskUnsafe(
  taskListId: string,
  taskId: string,
  updates: Partial<Omit<Task, "id">>,
): Promise<Task | null> {
  const existing = await getTask(taskListId, taskId);
  if (!existing) return null;
  const updated: Task = { ...existing, ...updates, id: taskId };
  await writeFile(getTaskPath(taskListId, taskId), JSON.stringify(updated, null, 2));
  notifyTasksUpdated(taskListId);
  return updated;
}

/**
 * Update a task. Per-task lock isolates concurrent updates to different
 * tasks — only concurrent updates to the SAME task serialize.
 */
export async function updateTask(
  taskListId: string,
  taskId: string,
  updates: Partial<Omit<Task, "id">>,
): Promise<Task | null> {
  // Check existence BEFORE locking: proper-lockfile throws if the target
  // path doesn't exist, and we want a clean null return for the benign
  // "task was already deleted" case.
  const pre = await getTask(taskListId, taskId);
  if (!pre) return null;

  const release = await lockfile.lock(getTaskPath(taskListId, taskId), LOCK_OPTIONS);
  try {
    return await updateTaskUnsafe(taskListId, taskId, updates);
  } finally {
    await release();
  }
}

/**
 * Delete a task. Records the id in the high water mark first so we
 * never reassign it to a new task after reset, then cascades the blocks
 * / blockedBy references in siblings.
 */
export async function deleteTask(taskListId: string, taskId: string): Promise<boolean> {
  const numericId = parseInt(taskId, 10);
  if (!Number.isNaN(numericId)) {
    const mark = await readHighWaterMark(taskListId);
    if (numericId > mark) {
      await writeHighWaterMark(taskListId, numericId);
    }
  }

  try {
    await unlink(getTaskPath(taskListId, taskId));
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") return false;
    throw error;
  }

  // Cascade: remove references to the deleted task in every sibling.
  const siblings = await listTasks(taskListId);
  for (const sibling of siblings) {
    const newBlocks = sibling.blocks.filter((id) => id !== taskId);
    const newBlockedBy = sibling.blockedBy.filter((id) => id !== taskId);
    if (
      newBlocks.length !== sibling.blocks.length ||
      newBlockedBy.length !== sibling.blockedBy.length
    ) {
      await updateTask(taskListId, sibling.id, {
        blocks: newBlocks,
        blockedBy: newBlockedBy,
      });
    }
  }

  notifyTasksUpdated(taskListId);
  return true;
}

/**
 * Bidirectional dependency link: `from` blocks `to`.
 *
 * Writing only one side would leave the graph inconsistent if the model
 * read the other side later, so we always update both. Duplicate entries
 * are a no-op.
 */
export async function blockTask(
  taskListId: string,
  fromTaskId: string,
  toTaskId: string,
): Promise<boolean> {
  const [from, to] = await Promise.all([
    getTask(taskListId, fromTaskId),
    getTask(taskListId, toTaskId),
  ]);
  if (!from || !to) return false;

  if (!from.blocks.includes(toTaskId)) {
    await updateTask(taskListId, fromTaskId, { blocks: [...from.blocks, toTaskId] });
  }
  if (!to.blockedBy.includes(fromTaskId)) {
    await updateTask(taskListId, toTaskId, { blockedBy: [...to.blockedBy, fromTaskId] });
  }
  return true;
}

/**
 * Reset a task list: delete every task file, but remember the highest
 * id we ever assigned so future creates don't reuse a stale id.
 *
 * This is explicit (`/tasks reset`). We never auto-reset on `/clear` —
 * the user may want to keep a task graph across conversation clears.
 */
export async function resetTaskList(taskListId: string): Promise<void> {
  const lockPath = await ensureTaskListLockFile(taskListId);
  const release = await lockfile.lock(lockPath, LOCK_OPTIONS);
  try {
    const current = await findHighestTaskIdFromFiles(taskListId);
    if (current > 0) {
      const existing = await readHighWaterMark(taskListId);
      if (current > existing) {
        await writeHighWaterMark(taskListId, current);
      }
    }

    let files: string[];
    try {
      files = await readdir(getTasksDir(taskListId));
    } catch {
      files = [];
    }
    for (const file of files) {
      if (file.endsWith(".json") && !file.startsWith(".")) {
        try {
          await unlink(path.join(getTasksDir(taskListId), file));
        } catch {
          // Another deleter won; fine.
        }
      }
    }
    notifyTasksUpdated(taskListId);
  } finally {
    await release();
  }
}

// ─── Derived helpers ───────────────────────────────────────────────

/**
 * A task is "ready" when it's pending, unowned (single-agent), and all
 * upstream blockers are completed. This is the predicate the model uses
 * to pick its next TaskList entry.
 */
export function isReady(task: Task, tasks: readonly Task[]): boolean {
  if (task.status !== "pending") return false;
  const unresolved = new Set(tasks.filter((t) => t.status !== "completed").map((t) => t.id));
  return task.blockedBy.every((id) => !unresolved.has(id));
}
