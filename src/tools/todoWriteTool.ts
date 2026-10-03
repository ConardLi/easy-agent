/**
 * TodoWriteTool — V1 会话级任务清单工具。
 *
 * 语义：
 *
 *   1. 输入只有一个 `todos: TodoItem[]`，每次**全量替换**之前的列表
 *   2. allDone（全部 completed）→ 存为空数组，"用完即归零"
 *   3. 状态写入按 sessionId 隔离的内存 store（子 Agent 有自己的 sessionId）
 *   4. tool result 固定为 "Todos have been modified successfully..."
 *   5. 权限：`permissions.ts` 把 TodoWrite 列为协调类工具，所有模式都放行
 *
 * V1 的限制：只在会话内有效（进程退出即丢失），平铺列表没有依赖关系，
 * 也没有 owner / claim。需要这些能力时改用 V2 的 Task 工具。
 */

import { setTodos } from "../state/todoStore.js";
import { isTodoModeEnabled } from "../state/taskModeStore.js";
import type { TodoItem, TodoStatus } from "../types/todo.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";

const TODO_WRITE_TOOL_NAME = "TodoWrite";

const VALID_STATUSES: ReadonlySet<TodoStatus> = new Set([
  "pending",
  "in_progress",
  "completed",
]);

function isTodoItem(value: unknown): value is TodoItem {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.content === "string" &&
    obj.content.trim().length > 0 &&
    typeof obj.activeForm === "string" &&
    obj.activeForm.trim().length > 0 &&
    typeof obj.status === "string" &&
    VALID_STATUSES.has(obj.status as TodoStatus)
  );
}

function parseTodos(input: Record<string, unknown>): TodoItem[] | { error: string } {
  const raw = input.todos;
  if (!Array.isArray(raw)) {
    return { error: "`todos` must be an array of TodoItem objects." };
  }
  const todos: TodoItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!isTodoItem(item)) {
      return {
        error: `todos[${i}] is not a valid TodoItem (need non-empty content, activeForm, and status ∈ pending|in_progress|completed).`,
      };
    }
    todos.push({
      content: item.content,
      status: item.status,
      activeForm: item.activeForm,
    });
  }
  return todos;
}

export const todoWriteTool: Tool = {
  name: TODO_WRITE_TOOL_NAME,
  searchHint: "manage the session task checklist",
  shouldDefer: true,

  description:
    "Update the todo list for the current session. To be used proactively and often to track progress and pending tasks. " +
    "Make sure that at least one task is in_progress at all times. " +
    "Always provide both content (imperative) and activeForm (present continuous) for each task.",

  inputSchema: {
    type: "object" as const,
    properties: {
      todos: {
        type: "array",
        description: "The full updated todo list. Each call REPLACES the entire list.",
        items: {
          type: "object",
          properties: {
            content: {
              type: "string",
              minLength: 1,
              description: "Imperative task description, e.g. 'Run the tests'.",
            },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
              description:
                "Task status. Exactly ONE task should be in_progress at any time.",
            },
            activeForm: {
              type: "string",
              minLength: 1,
              description:
                "Present continuous form shown in the spinner while the task runs, e.g. 'Running the tests'.",
            },
          },
          required: ["content", "status", "activeForm"],
          additionalProperties: false,
        },
      },
    },
    required: ["todos"],
    additionalProperties: false,
  },

  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = parseTodos(input);
    if (!Array.isArray(parsed)) {
      return { content: `Error: ${parsed.error}`, isError: true };
    }

    const sessionId = context.sessionId ?? "default";

    // When every todo is `completed`, store an empty list. The "all done" auto-clear keeps the UI from accumulating stale
    // checkmarks across long sessions.
    const allDone = parsed.length > 0 && parsed.every((t) => t.status === "completed");
    const newStored = allDone ? [] : parsed;
    setTodos(sessionId, newStored);

    // Fixed result text: the trailing sentences nudge the model to keep
    // using the list and carry on with the work.
    return {
      content:
        "Todos have been modified successfully. " +
        "Ensure that you continue to use the todo list to track your progress. " +
        "Please proceed with the current tasks if applicable",
    };
  },

  isReadOnly() {
    // Writes to in-memory session state — not the filesystem, but it does
    // mutate session-visible state, so we report it as non-read-only.
    // The permission layer special-cases this tool to always allow.
    return false;
  },

  isEnabled() {
    // TodoWrite V1 and the Task V2 tools are mutually exclusive. The runtime toggle lives in
    // taskModeStore and is flipped by `/tasks task|todo`.
    return isTodoModeEnabled();
  },
};
