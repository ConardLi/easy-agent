/**
 * Task V2 store — persistent task graph on disk.
 *
 * Session task lists and shared team task lists use the same durable store.
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
 * List-level locks serialize graph changes, id allocation, deletion and
 * reset across processes. Per-task locks preserve independent field updates
 * and coordinate them with list-wide mutations.
 */

import { readdir, readFile, unlink } from "node:fs/promises";
import * as path from "node:path";
import type { Task, TaskStatus } from "../types/task.js";
import { TASK_STATUSES } from "../types/task.js";
import { getTasksRoot } from "../utils/paths.js";
import {
  createPrivateFileIfMissing,
  ensurePrivateDirectory,
  writePrivateFile,
} from "../utils/privateData.js";
import {
  parsePersistedJson,
  PersistentDataError,
  withFileLock,
} from "../utils/atomicFile.js";

const HIGH_WATER_MARK_FILE = ".highwatermark";
const LOCK_FILE = ".lock";

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
 * Ordinary tasks keep the session's list id. Team tasks use
 * getTeamTaskListId instead.
 */
export function getTaskListId(sessionId: string): string {
  return sessionId || "default";
}

export function getTeamTaskListId(teamName: string): string {
  return `team-${sanitizePathComponent(teamName.toLowerCase())}`;
}

export function getTasksDir(taskListId: string): string {
  return path.join(getTasksRoot(), sanitizePathComponent(taskListId));
}

export function getTaskPath(taskListId: string, taskId: string): string {
  return path.join(getTasksDir(taskListId), `${sanitizePathComponent(taskId)}.json`);
}

async function ensureTasksDir(taskListId: string): Promise<void> {
  await ensurePrivateDirectory(getTasksDir(taskListId));
}

/**
 * Ensure the list-level lock file exists.
 *
 * The sentinel also makes the lock visible in the on-disk layout. Its `wx`
 * creation is idempotent across concurrent callers.
 */
async function ensureTaskListLockFile(taskListId: string): Promise<string> {
  await ensureTasksDir(taskListId);
  const lockPath = path.join(getTasksDir(taskListId), LOCK_FILE);
  await createPrivateFileIfMissing(lockPath);
  return lockPath;
}

async function withTaskListLock<T>(taskListId: string, operation: () => Promise<T>): Promise<T> {
  return withFileLock(await ensureTaskListLockFile(taskListId), operation);
}

async function withTaskFileLock<T>(
  taskListId: string,
  taskId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withFileLock(getTaskPath(taskListId, taskId), operation);
}

// ─── High water mark ───────────────────────────────────────────────

function getHighWaterMarkPath(taskListId: string): string {
  return path.join(getTasksDir(taskListId), HIGH_WATER_MARK_FILE);
}

async function readHighWaterMark(taskListId: string): Promise<number> {
  const filePath = getHighWaterMarkPath(taskListId);
  try {
    const content = (await readFile(filePath, "utf-8")).trim();
    if (!/^\d+$/.test(content)) {
      throw new PersistentDataError(filePath, "expected a non-negative integer high-water mark");
    }
    return Number.parseInt(content, 10);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function writeHighWaterMark(taskListId: string, value: number): Promise<void> {
  await writePrivateFile(getHighWaterMarkPath(taskListId), String(value));
}

async function findHighestTaskIdFromFiles(taskListId: string): Promise<number> {
  let files: string[];
  try {
    files = await readdir(getTasksDir(taskListId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
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
  return withTaskListLock(taskListId, async () => {
    const highest = await findHighestTaskId(taskListId);
    const id = String(highest + 1);
    const task: Task = { id, ...data };
    await writePrivateFile(getTaskPath(taskListId, id), JSON.stringify(task, null, 2));
    notifyTasksUpdated(taskListId);
    return id;
  });
}

export async function getTask(taskListId: string, taskId: string): Promise<Task | null> {
  const filePath = getTaskPath(taskListId, taskId);
  try {
    const content = await readFile(filePath, "utf-8");
    const task = parseTask(parsePersistedJson(filePath, content));
    if (!task) throw new PersistentDataError(filePath, "task record does not match the expected schema");
    return task;
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") return null;
    throw error;
  }
}

export async function listTasks(taskListId: string): Promise<Task[]> {
  let files: string[];
  try {
    files = await readdir(getTasksDir(taskListId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
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
  await writePrivateFile(getTaskPath(taskListId, taskId), JSON.stringify(updated, null, 2));
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
  return withTaskFileLock(taskListId, taskId, () =>
    updateTaskUnsafe(taskListId, taskId, updates),
  );
}

/**
 * Delete a task. Records the id in the high water mark first so we
 * never reassign it to a new task after reset, then cascades the blocks
 * / blockedBy references in siblings.
 */
export async function deleteTask(taskListId: string, taskId: string, actor?: string): Promise<boolean> {
  return withTaskListLock(taskListId, async () => {
    const numericId = parseInt(taskId, 10);
    if (!Number.isNaN(numericId)) {
      const mark = await readHighWaterMark(taskListId);
      if (numericId > mark) {
        await writeHighWaterMark(taskListId, numericId);
      }
    }

    const deleted = await withTaskFileLock(taskListId, taskId, async () => {
      try {
        if (actor) {
          const current = await getTask(taskListId, taskId);
          if (current?.owner && current.owner !== actor) {
            throw new Error(`Task #${taskId} is owned by ${current.owner}`);
          }
        }
        await unlink(getTaskPath(taskListId, taskId));
        return true;
      } catch (error: unknown) {
        const err = error as NodeJS.ErrnoException;
        if (err?.code === "ENOENT") return false;
        throw error;
      }
    });
    if (!deleted) return false;

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
  });
}

export async function updateTeamTask(
  taskListId: string,
  taskId: string,
  actor: string,
  updates: Partial<Omit<Task, "id">>,
): Promise<Task | null> {
  return withTaskListLock(taskListId, () => withTaskFileLock(taskListId, taskId, async () => {
    const current = await getTask(taskListId, taskId);
    if (!current) return null;
    if (current.owner && current.owner !== actor) throw new Error(`Task #${taskId} is owned by ${current.owner}`);
    if (current.status === "completed" && Object.keys(updates).length > 0) {
      throw new Error(`Task #${taskId} is already completed`);
    }

    const next: Task = { ...current, ...updates, id: taskId };
    if (updates.status === "in_progress") {
      if (current.status !== "pending" && !(current.status === "in_progress" && current.owner === actor)) {
        throw new Error(`Task #${taskId} cannot be claimed from ${current.status}`);
      }
      for (const blockerId of current.blockedBy) {
        const blocker = await getTask(taskListId, blockerId);
        if (blocker && blocker.status !== "completed") throw new Error(`Task #${taskId} is blocked by #${blockerId}`);
      }
      next.owner = actor;
    } else if (updates.status === "pending") {
      if (current.status === "completed") throw new Error(`Task #${taskId} is already completed`);
      next.owner = undefined;
    } else if (updates.status === "completed") {
      if (current.status !== "in_progress" || current.owner !== actor) {
        throw new Error(`Task #${taskId} must be claimed by ${actor} before completion`);
      }
      next.owner = actor;
    }
    await writePrivateFile(getTaskPath(taskListId, taskId), JSON.stringify(next, null, 2));
    notifyTasksUpdated(taskListId);
    return next;
  }));
}

export async function releaseMemberTasks(teamName: string, memberName: string): Promise<number> {
  const taskListId = getTeamTaskListId(teamName);
  return withTaskListLock(taskListId, async () => {
    const tasks = await listTasks(taskListId);
    let released = 0;
    for (const task of tasks) {
      if (task.owner !== memberName || task.status !== "in_progress") continue;
      await withTaskFileLock(taskListId, task.id, async () => {
        const current = await getTask(taskListId, task.id);
        if (current?.owner !== memberName || current.status !== "in_progress") return;
        await writePrivateFile(getTaskPath(taskListId, task.id), JSON.stringify({ ...current, owner: undefined, status: "pending" }, null, 2));
        released++;
        notifyTasksUpdated(taskListId);
      });
    }
    return released;
  });
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
  actor?: string,
): Promise<boolean> {
  return withTaskListLock(taskListId, async () => {
    const [from, to] = await Promise.all([
      getTask(taskListId, fromTaskId),
      getTask(taskListId, toTaskId),
    ]);
    if (!from || !to) return false;
    if (actor) {
      if (from.owner && from.owner !== actor) throw new Error(`Task #${fromTaskId} is owned by ${from.owner}`);
      if (to.owner && to.owner !== actor) throw new Error(`Task #${toTaskId} is owned by ${to.owner}`);
      if (to.status !== "pending") throw new Error(`Task #${toTaskId} cannot gain a blocker after work has started`);
    }

    // Persist the scheduling constraint before its reverse index. If the
    // process stops between writes, the dependent task remains blocked.
    if (!to.blockedBy.includes(fromTaskId)) {
      await updateTask(taskListId, toTaskId, { blockedBy: [...to.blockedBy, fromTaskId] });
    }
    if (!from.blocks.includes(toTaskId)) {
      await updateTask(taskListId, fromTaskId, { blocks: [...from.blocks, toTaskId] });
    }
    return true;
  });
}

/**
 * Reset a task list: delete every task file, but remember the highest
 * id we ever assigned so future creates don't reuse a stale id.
 *
 * This is explicit (`/tasks reset`). We never auto-reset on `/clear` —
 * the user may want to keep a task graph across conversation clears.
 */
export async function resetTaskList(taskListId: string): Promise<void> {
  await withTaskListLock(taskListId, async () => {
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
        const taskId = file.slice(0, -".json".length);
        await withTaskFileLock(taskListId, taskId, async () => {
          try {
            await unlink(path.join(getTasksDir(taskListId), file));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        });
      }
    }
    notifyTasksUpdated(taskListId);
  });
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
