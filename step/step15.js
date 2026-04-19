/**
 * Step 15 - Persistent task graph (Task V2)
 *
 * Goal:
 * - replace the in-memory todo note with persistent task files
 * - keep stable numeric ids across restarts
 * - support dependency edges with blocks / blockedBy
 * - expose a small task toolset for create / list / get / update
 * - keep the UI synced through an in-process refresh signal
 *
 * This file is a teaching version that condenses the core mechanics.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const EASY_AGENT_HOME = path.join(os.homedir(), ".easy-agent");
const TASKS_ROOT = path.join(EASY_AGENT_HOME, "tasks");
const HIGH_WATER_MARK_FILE = ".highwatermark";

// -----------------------------------------------------------------------------
// 1. Task model
// -----------------------------------------------------------------------------

export const TASK_STATUSES = ["pending", "in_progress", "completed"];

export function createTaskRecord(id, data) {
  return {
    id,
    subject: data.subject,
    description: data.description,
    activeForm: data.activeForm,
    owner: data.owner,
    status: data.status || "pending",
    blocks: data.blocks || [],
    blockedBy: data.blockedBy || [],
    metadata: data.metadata,
  };
}

// -----------------------------------------------------------------------------
// 2. Path layout
// -----------------------------------------------------------------------------

export function sanitizePathComponent(input) {
  return String(input).replace(/[^A-Za-z0-9_-]/g, "-");
}

export function getTaskListId(sessionId) {
  return sessionId || "default";
}

export function getTasksDir(taskListId) {
  return path.join(TASKS_ROOT, sanitizePathComponent(taskListId));
}

export function getTaskPath(taskListId, taskId) {
  return path.join(getTasksDir(taskListId), sanitizePathComponent(taskId) + ".json");
}

function getHighWaterMarkPath(taskListId) {
  return path.join(getTasksDir(taskListId), HIGH_WATER_MARK_FILE);
}

async function ensureTasksDir(taskListId) {
  await fs.mkdir(getTasksDir(taskListId), { recursive: true });
}

// -----------------------------------------------------------------------------
// 3. High water mark (stable ids)
// -----------------------------------------------------------------------------

async function readHighWaterMark(taskListId) {
  try {
    const content = (await fs.readFile(getHighWaterMarkPath(taskListId), "utf8")).trim();
    const value = Number.parseInt(content, 10);
    return Number.isNaN(value) ? 0 : value;
  } catch {
    return 0;
  }
}

async function writeHighWaterMark(taskListId, value) {
  await ensureTasksDir(taskListId);
  await fs.writeFile(getHighWaterMarkPath(taskListId), String(value), "utf8");
}

async function findHighestTaskIdFromFiles(taskListId) {
  let files;
  try {
    files = await fs.readdir(getTasksDir(taskListId));
  } catch {
    return 0;
  }

  let highest = 0;
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const numericId = Number.parseInt(file.replace(".json", ""), 10);
    if (!Number.isNaN(numericId) && numericId > highest) {
      highest = numericId;
    }
  }

  return highest;
}

async function findHighestTaskId(taskListId) {
  const [fromFiles, fromMark] = await Promise.all([
    findHighestTaskIdFromFiles(taskListId),
    readHighWaterMark(taskListId),
  ]);
  return Math.max(fromFiles, fromMark);
}

// -----------------------------------------------------------------------------
// 4. Read / write helpers
// -----------------------------------------------------------------------------

function parseTask(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string") return null;
  if (typeof raw.subject !== "string") return null;
  if (typeof raw.description !== "string") return null;
  if (!TASK_STATUSES.includes(raw.status)) return null;

  return {
    id: raw.id,
    subject: raw.subject,
    description: raw.description,
    activeForm: typeof raw.activeForm === "string" ? raw.activeForm : undefined,
    owner: typeof raw.owner === "string" ? raw.owner : undefined,
    status: raw.status,
    blocks: Array.isArray(raw.blocks) ? raw.blocks.filter((item) => typeof item === "string") : [],
    blockedBy: Array.isArray(raw.blockedBy) ? raw.blockedBy.filter((item) => typeof item === "string") : [],
    metadata: raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
      ? raw.metadata
      : undefined,
  };
}

export async function getTask(taskListId, taskId) {
  try {
    const content = await fs.readFile(getTaskPath(taskListId, taskId), "utf8");
    return parseTask(JSON.parse(content));
  } catch {
    return null;
  }
}

export async function listTasks(taskListId) {
  let files;
  try {
    files = await fs.readdir(getTasksDir(taskListId));
  } catch {
    return [];
  }

  const ids = files
    .filter((file) => file.endsWith(".json") && !file.startsWith("."))
    .map((file) => file.replace(".json", ""));

  const tasks = await Promise.all(ids.map((id) => getTask(taskListId, id)));
  return tasks.filter(Boolean);
}

async function writeTask(taskListId, task) {
  await ensureTasksDir(taskListId);
  await fs.writeFile(getTaskPath(taskListId, task.id), JSON.stringify(task, null, 2), "utf8");
}

// -----------------------------------------------------------------------------
// 5. CRUD
// -----------------------------------------------------------------------------

export async function createTask(taskListId, data) {
  const id = String((await findHighestTaskId(taskListId)) + 1);
  const task = createTaskRecord(id, {
    ...data,
    status: data.status || "pending",
    blocks: [],
    blockedBy: [],
  });

  await writeTask(taskListId, task);
  return id;
}

export async function updateTask(taskListId, taskId, updates) {
  const existing = await getTask(taskListId, taskId);
  if (!existing) return null;

  const updated = {
    ...existing,
    ...updates,
    id: taskId,
  };

  await writeTask(taskListId, updated);
  return updated;
}

export async function deleteTask(taskListId, taskId) {
  const numericId = Number.parseInt(taskId, 10);
  if (!Number.isNaN(numericId)) {
    const mark = await readHighWaterMark(taskListId);
    if (numericId > mark) {
      await writeHighWaterMark(taskListId, numericId);
    }
  }

  try {
    await fs.unlink(getTaskPath(taskListId, taskId));
  } catch {
    return false;
  }

  // Cascade cleanup: remove references from sibling tasks.
  const siblings = await listTasks(taskListId);
  for (const sibling of siblings) {
    const nextBlocks = sibling.blocks.filter((id) => id !== taskId);
    const nextBlockedBy = sibling.blockedBy.filter((id) => id !== taskId);

    if (
      nextBlocks.length !== sibling.blocks.length ||
      nextBlockedBy.length !== sibling.blockedBy.length
    ) {
      await updateTask(taskListId, sibling.id, {
        blocks: nextBlocks,
        blockedBy: nextBlockedBy,
      });
    }
  }

  return true;
}

export async function resetTaskList(taskListId) {
  const currentHighest = await findHighestTaskIdFromFiles(taskListId);
  if (currentHighest > 0) {
    const existingMark = await readHighWaterMark(taskListId);
    if (currentHighest > existingMark) {
      await writeHighWaterMark(taskListId, currentHighest);
    }
  }

  let files;
  try {
    files = await fs.readdir(getTasksDir(taskListId));
  } catch {
    files = [];
  }

  for (const file of files) {
    if (file.endsWith(".json") && !file.startsWith(".")) {
      await fs.unlink(path.join(getTasksDir(taskListId), file)).catch(() => {});
    }
  }
}

// -----------------------------------------------------------------------------
// 6. Dependency graph helpers
// -----------------------------------------------------------------------------

export async function blockTask(taskListId, fromTaskId, toTaskId) {
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

export function isReady(task, allTasks) {
  if (task.status !== "pending") return false;
  const unresolved = new Set(allTasks.filter((item) => item.status !== "completed").map((item) => item.id));
  return task.blockedBy.every((id) => !unresolved.has(id));
}

// -----------------------------------------------------------------------------
// 7. Task mode switch (V1 TodoWrite vs V2 Task graph)
// -----------------------------------------------------------------------------

let currentTaskMode = "task";

export function getTaskMode() {
  return currentTaskMode;
}

export function setTaskMode(mode) {
  currentTaskMode = mode;
}

export function isTaskModeEnabled() {
  return currentTaskMode === "task";
}

export function isTodoModeEnabled() {
  return currentTaskMode === "todo";
}

// -----------------------------------------------------------------------------
// 8. Minimal task tools
// -----------------------------------------------------------------------------

export const taskCreateTool = {
  name: "TaskCreate",
  async call(input, context) {
    const taskListId = getTaskListId(context.sessionId || "default");
    const id = await createTask(taskListId, {
      subject: input.subject,
      description: input.description,
      activeForm: input.activeForm,
      status: "pending",
      blocks: [],
      blockedBy: [],
      metadata: input.metadata,
    });
    return { content: "Task #" + id + " created: " + input.subject };
  },
};

export const taskListTool = {
  name: "TaskList",
  async call(_input, context) {
    const taskListId = getTaskListId(context.sessionId || "default");
    const allTasks = await listTasks(taskListId);
    if (allTasks.length === 0) return { content: "No tasks found" };

    const resolvedIds = new Set(allTasks.filter((task) => task.status === "completed").map((task) => task.id));
    const lines = allTasks
      .slice()
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((task) => {
        const openBlockers = task.blockedBy.filter((id) => !resolvedIds.has(id));
        const blockedSuffix = openBlockers.length > 0
          ? " [blocked by " + openBlockers.map((id) => "#" + id).join(", ") + "]"
          : "";
        return "#" + task.id + " [" + task.status + "] " + task.subject + blockedSuffix;
      });

    return { content: lines.join("\n") };
  },
};

export const taskGetTool = {
  name: "TaskGet",
  async call(input, context) {
    const taskListId = getTaskListId(context.sessionId || "default");
    const task = await getTask(taskListId, input.taskId);
    if (!task) return { content: "Task not found", isError: true };

    const lines = [
      "Task #" + task.id + ": " + task.subject,
      "Status: " + task.status,
      "Description: " + task.description,
    ];
    if (task.activeForm) lines.push("ActiveForm: " + task.activeForm);
    if (task.blockedBy.length > 0) lines.push("Blocked by: " + task.blockedBy.map((id) => "#" + id).join(", "));
    if (task.blocks.length > 0) lines.push("Blocks: " + task.blocks.map((id) => "#" + id).join(", "));

    return { content: lines.join("\n") };
  },
};

export const taskUpdateTool = {
  name: "TaskUpdate",
  async call(input, context) {
    const taskListId = getTaskListId(context.sessionId || "default");

    if (input.status === "deleted") {
      const ok = await deleteTask(taskListId, input.taskId);
      return ok
        ? { content: "Task #" + input.taskId + " deleted." }
        : { content: "Failed to delete task #" + input.taskId + ".", isError: true };
    }

    const updates = {};
    if (typeof input.subject === "string") updates.subject = input.subject;
    if (typeof input.description === "string") updates.description = input.description;
    if (typeof input.activeForm === "string") updates.activeForm = input.activeForm;
    if (typeof input.status === "string") updates.status = input.status;
    if (input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)) {
      updates.metadata = input.metadata;
    }

    const updated = await updateTask(taskListId, input.taskId, updates);
    if (!updated) return { content: "Task not found", isError: true };

    if (Array.isArray(input.addBlocks)) {
      for (const downstreamId of input.addBlocks) {
        await blockTask(taskListId, input.taskId, downstreamId);
      }
    }
    if (Array.isArray(input.addBlockedBy)) {
      for (const upstreamId of input.addBlockedBy) {
        await blockTask(taskListId, upstreamId, input.taskId);
      }
    }

    return { content: "Updated task #" + input.taskId };
  },
};
