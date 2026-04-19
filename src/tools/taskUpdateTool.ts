/**
 * TaskUpdate — modify a task in the persistent task graph.
 *
 * Mirrors `claude-code-source-code/src/tools/TaskUpdateTool`, stripped
 * of multi-agent (mailbox, agent-name autofill, verification nudge).
 *
 * Supports:
 *   - field edits: subject / description / activeForm
 *   - status changes (incl. "deleted" pseudo-status → calls deleteTask)
 *   - metadata merge (setting a key to null deletes it, like source)
 *   - dependency edits via `addBlockedBy` / `addBlocks`
 *
 * The reason we accept `"deleted"` on `status` (rather than a separate
 * TaskDelete tool) is that the model already has `status` in its
 * working memory; collapsing the two saves a tool slot and makes the
 * "finished with it, throw it away" flow one call instead of two.
 */

import {
  blockTask,
  deleteTask,
  getTask,
  getTaskListId,
  updateTask,
} from "../state/taskStore.js";
import { isTaskModeEnabled } from "../state/taskModeStore.js";
import type { Task, TaskStatus } from "../types/task.js";
import { TASK_STATUSES } from "../types/task.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";

const TOOL_NAME = "TaskUpdate";

type UpdateStatus = TaskStatus | "deleted";
const UPDATE_STATUSES: ReadonlySet<string> = new Set<string>([...TASK_STATUSES, "deleted"]);

function pickString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function pickStringArray(input: Record<string, unknown>, key: string): string[] | undefined {
  const value = input[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((x): x is string => typeof x === "string");
  return strings.length === value.length ? strings : undefined;
}

function mergeMetadata(
  existing: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(existing ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

export const taskUpdateTool: Tool = {
  name: TOOL_NAME,

  description:
    "Update a task in the persistent task graph. Use this to mark progress " +
    "(pending → in_progress → completed), edit fields, add dependencies, or delete " +
    "tasks by setting status to 'deleted'. Always read the task's latest state with TaskGet before editing.",

  inputSchema: {
    type: "object" as const,
    properties: {
      taskId: { type: "string", minLength: 1, description: "The id of the task to update." },
      subject: { type: "string", description: "New subject (imperative form)." },
      description: { type: "string", description: "New description." },
      activeForm: {
        type: "string",
        description: "Present-continuous form shown in the spinner while the task is in_progress.",
      },
      status: {
        type: "string",
        enum: ["pending", "in_progress", "completed", "deleted"],
        description: "New status. 'deleted' removes the task and cleans up references.",
      },
      addBlocks: {
        type: "array",
        items: { type: "string" },
        description: "Task ids that this task blocks (downstream dependencies).",
      },
      addBlockedBy: {
        type: "array",
        items: { type: "string" },
        description: "Task ids that block this task (upstream dependencies).",
      },
      metadata: {
        type: "object",
        additionalProperties: true,
        description: "Metadata keys to merge. Set a key to null to delete it.",
      },
    },
    required: ["taskId"],
    additionalProperties: false,
  },

  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const taskId = pickString(input, "taskId")?.trim();
    if (!taskId) return { content: "Error: `taskId` is required.", isError: true };

    const taskListId = getTaskListId(context.sessionId ?? "default");
    const existing = await getTask(taskListId, taskId);
    if (!existing) return { content: `Task #${taskId} not found`, isError: true };

    // Short-circuit status="deleted": run the cascading delete and
    // return immediately. Any other updates in the same call are
    // ignored — deleting a task means the edits are moot anyway.
    const rawStatus = pickString(input, "status");
    if (rawStatus !== undefined && !UPDATE_STATUSES.has(rawStatus)) {
      return { content: `Error: invalid status '${rawStatus}'.`, isError: true };
    }
    const statusValue = rawStatus as UpdateStatus | undefined;

    if (statusValue === "deleted") {
      const ok = await deleteTask(taskListId, taskId);
      return ok
        ? { content: `Task #${taskId} deleted.` }
        : { content: `Failed to delete task #${taskId}.`, isError: true };
    }

    const updates: Partial<Omit<Task, "id">> = {};
    const updatedFields: string[] = [];

    const subject = pickString(input, "subject");
    if (subject !== undefined && subject !== existing.subject) {
      updates.subject = subject;
      updatedFields.push("subject");
    }
    const description = pickString(input, "description");
    if (description !== undefined && description !== existing.description) {
      updates.description = description;
      updatedFields.push("description");
    }
    const activeForm = pickString(input, "activeForm");
    if (activeForm !== undefined && activeForm !== existing.activeForm) {
      updates.activeForm = activeForm;
      updatedFields.push("activeForm");
    }
    if (statusValue !== undefined && statusValue !== existing.status) {
      updates.status = statusValue;
      updatedFields.push("status");
    }
    if (input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)) {
      updates.metadata = mergeMetadata(existing.metadata, input.metadata as Record<string, unknown>);
      updatedFields.push("metadata");
    }

    if (Object.keys(updates).length > 0) {
      await updateTask(taskListId, taskId, updates);
    }

    // Dependency wires run AFTER the main update so both sides of each
    // block/blockedBy pair see the freshest state. blockTask maintains
    // both directions so the graph stays consistent even if the model
    // only names one side.
    const addBlocks = pickStringArray(input, "addBlocks");
    if (addBlocks && addBlocks.length > 0) {
      let changed = false;
      for (const downstreamId of addBlocks) {
        if (existing.blocks.includes(downstreamId)) continue;
        const ok = await blockTask(taskListId, taskId, downstreamId);
        if (ok) changed = true;
      }
      if (changed) updatedFields.push("blocks");
    }

    const addBlockedBy = pickStringArray(input, "addBlockedBy");
    if (addBlockedBy && addBlockedBy.length > 0) {
      let changed = false;
      for (const upstreamId of addBlockedBy) {
        if (existing.blockedBy.includes(upstreamId)) continue;
        const ok = await blockTask(taskListId, upstreamId, taskId);
        if (ok) changed = true;
      }
      if (changed) updatedFields.push("blockedBy");
    }

    if (updatedFields.length === 0) {
      return { content: `Task #${taskId} unchanged.` };
    }
    return { content: `Updated task #${taskId}: ${updatedFields.join(", ")}` };
  },

  isReadOnly() {
    return false;
  },

  isEnabled() {
    return isTaskModeEnabled();
  },
};
