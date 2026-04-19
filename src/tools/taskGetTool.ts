/**
 * TaskGet — fetch a single task's full record.
 *
 * Mirrors the source tool. Matters because TaskList only returns a
 * trimmed summary (id/subject/status/blockedBy), so the model uses
 * TaskGet to see the description + full context before editing.
 */

import { getTask, getTaskListId } from "../state/taskStore.js";
import { isTaskModeEnabled } from "../state/taskModeStore.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";

const TOOL_NAME = "TaskGet";

export const taskGetTool: Tool = {
  name: TOOL_NAME,

  description: "Retrieve the full details of a single task by id. Always call this before TaskUpdate to read current state.",

  inputSchema: {
    type: "object" as const,
    properties: {
      taskId: { type: "string", minLength: 1, description: "The id of the task to retrieve." },
    },
    required: ["taskId"],
    additionalProperties: false,
  },

  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const taskId = typeof input.taskId === "string" ? input.taskId.trim() : "";
    if (!taskId) return { content: "Error: `taskId` is required.", isError: true };

    const taskListId = getTaskListId(context.sessionId ?? "default");
    const task = await getTask(taskListId, taskId);
    if (!task) return { content: "Task not found" };

    const lines = [
      `Task #${task.id}: ${task.subject}`,
      `Status: ${task.status}`,
      `Description: ${task.description}`,
    ];
    if (task.activeForm) lines.push(`ActiveForm: ${task.activeForm}`);
    if (task.blockedBy.length > 0) {
      lines.push(`Blocked by: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
    }
    if (task.blocks.length > 0) {
      lines.push(`Blocks: ${task.blocks.map((id) => `#${id}`).join(", ")}`);
    }

    return { content: lines.join("\n") };
  },

  isReadOnly() {
    return true;
  },

  isEnabled() {
    return isTaskModeEnabled();
  },
};
