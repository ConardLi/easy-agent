/**
 * TaskCreate — add a task to the persistent task graph.
 *
 * Mirrors `claude-code-source-code/src/tools/TaskCreateTool`. Returns the
 * assigned id so the model can immediately reference the task in
 * TaskUpdate calls (e.g. to set blockedBy on follow-up tasks).
 *
 * Drops:
 *   - TaskCreated hooks (stage 22+)
 *   - teammate assignment notes (multi-agent)
 *   - app-state auto-expand (we always render TaskList when in task mode)
 */

import { createTask, getTaskListId } from "../state/taskStore.js";
import { isTaskModeEnabled } from "../state/taskModeStore.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";

const TOOL_NAME = "TaskCreate";

function pickString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

export const taskCreateTool: Tool = {
  name: TOOL_NAME,

  description:
    "Create a structured task for the current session's persistent task graph. " +
    "Tasks survive restarts and /clear, and support dependencies via blocks/blockedBy. " +
    "Use proactively for 3+ step work, multi-step plans, and any task list the user would want to see across sessions.",

  inputSchema: {
    type: "object" as const,
    properties: {
      subject: {
        type: "string",
        minLength: 1,
        description: "Imperative one-line title, e.g. 'Fix login bug'.",
      },
      description: {
        type: "string",
        minLength: 1,
        description: "What needs to be done. One or two paragraphs is fine.",
      },
      activeForm: {
        type: "string",
        description:
          "Present-continuous form shown in the spinner when the task is in_progress, e.g. 'Fixing login bug'. If omitted, the subject is used.",
      },
      metadata: {
        type: "object",
        additionalProperties: true,
        description: "Free-form metadata attached to the task.",
      },
    },
    required: ["subject", "description"],
    additionalProperties: false,
  },

  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const subject = pickString(input, "subject")?.trim();
    const description = pickString(input, "description")?.trim();
    const activeForm = pickString(input, "activeForm")?.trim();
    const metadata = input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? (input.metadata as Record<string, unknown>)
      : undefined;

    if (!subject) return { content: "Error: `subject` must be a non-empty string.", isError: true };
    if (!description) return { content: "Error: `description` must be a non-empty string.", isError: true };

    const taskListId = getTaskListId(context.sessionId ?? "default");
    const id = await createTask(taskListId, {
      subject,
      description,
      activeForm: activeForm || undefined,
      status: "pending",
      blocks: [],
      blockedBy: [],
      metadata,
    });

    return { content: `Task #${id} created: ${subject}` };
  },

  isReadOnly() {
    return false;
  },

  isEnabled() {
    return isTaskModeEnabled();
  },
};
