/**
 * TaskList — summary of every task in the current task list.
 *
 * Mirrors the source tool. Returns a compact line per task with the
 * blocker ids filtered down to *unresolved* blockers only (a completed
 * upstream task shouldn't look like it's still blocking anyone).
 *
 * The model is expected to call this:
 *   - before starting work, to find the next ready task
 *   - after completing a task, to see what just became unblocked
 */

import { listTasks } from "../state/taskStore.js";
import { isTaskGraphEnabled, resolveTaskScope, validateTaskActor } from "./taskScope.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";

const TOOL_NAME = "TaskList";

export const taskListTool: Tool = {
  name: TOOL_NAME,
  searchHint: "list all tasks",
  shouldDefer: true,

  description:
    "List every task in the current session's task graph. Use this before starting work to find the next unblocked task, and after finishing one to see what was unblocked. Prefer tasks in ascending id order when multiple are ready.",

  inputSchema: {
    type: "object" as const,
    properties: {},
    additionalProperties: false,
  },

  async call(_input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const actorError = await validateTaskActor(context);
    if (actorError) return { content: `Error: ${actorError}`, isError: true };
    const taskListId = resolveTaskScope(context).listId;
    const allTasks = await listTasks(taskListId);
    if (allTasks.length === 0) {
      return { content: "No tasks found" };
    }

    // Completed upstream tasks no longer block anyone, so trim them out
    // of the reported blockedBy list. Matches source TaskListTool.
    const resolvedIds = new Set(allTasks.filter((t) => t.status === "completed").map((t) => t.id));

    const lines = allTasks
      .slice()
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((task) => {
        const openBlockers = task.blockedBy.filter((id) => !resolvedIds.has(id));
        const blocked = openBlockers.length > 0
          ? ` [blocked by ${openBlockers.map((id) => `#${id}`).join(", ")}]`
          : "";
        return `#${task.id} [${task.status}] ${task.subject}${task.owner ? ` [owner: ${task.owner}]` : ""}${blocked}`;
      });

    return { content: lines.join("\n") };
  },

  isReadOnly() {
    return true;
  },

  isEnabled() {
    return isTaskGraphEnabled();
  },
};
