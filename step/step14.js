/**
 * Step 14 - TodoWrite and session-scoped task tracking
 *
 * Goal:
 * - let the model keep a visible todo list for complex work
 * - replace the full list on every write (no ids)
 * - store todos per session in memory
 * - auto-clear the list when everything is completed
 *
 * This file is a teaching version distilled from the real implementation.
 */

// -----------------------------------------------------------------------------
// 1. Minimal todo schema
// -----------------------------------------------------------------------------

export const TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);

export function isTodoItem(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.content === "string" &&
      value.content.trim().length > 0 &&
      typeof value.activeForm === "string" &&
      value.activeForm.trim().length > 0 &&
      typeof value.status === "string" &&
      TODO_STATUSES.has(value.status),
  );
}

export function parseTodos(input) {
  const raw = input.todos;
  if (!Array.isArray(raw)) {
    return { error: "`todos` must be an array of TodoItem objects." };
  }

  const todos = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!isTodoItem(item)) {
      return {
        error:
          "todos[" +
          index +
          "] is not a valid TodoItem (need non-empty content, activeForm, and status in pending|in_progress|completed).",
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

// -----------------------------------------------------------------------------
// 2. Session-scoped in-memory store
// -----------------------------------------------------------------------------

const todosBySession = new Map();
const listeners = new Set();

export function getTodos(sessionId) {
  return todosBySession.get(sessionId) || [];
}

export function setTodos(sessionId, todos) {
  todosBySession.set(sessionId, todos);
  for (const listener of listeners) {
    listener(sessionId, todos);
  }
}

export function clearTodos(sessionId) {
  setTodos(sessionId, []);
}

export function subscribeTodos(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// -----------------------------------------------------------------------------
// 3. TodoWrite tool
// -----------------------------------------------------------------------------

export const todoWriteTool = {
  name: "TodoWrite",
  description:
    "Update the todo list for the current session. Use it proactively to track progress and pending tasks.",
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The full updated todo list. Each call REPLACES the entire list.",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            activeForm: { type: "string" },
          },
          required: ["content", "status", "activeForm"],
        },
      },
    },
    required: ["todos"],
  },
  isReadOnly() {
    return false;
  },
  isEnabled() {
    return true;
  },
  async call(input, context) {
    const parsed = parseTodos(input);
    if (!Array.isArray(parsed)) {
      return { content: "Error: " + parsed.error, isError: true };
    }

    const sessionId = context.sessionId || "default";

    // If every item is completed, clear the list entirely.
    const allDone = parsed.length > 0 && parsed.every((todo) => todo.status === "completed");
    const storedTodos = allDone ? [] : parsed;

    setTodos(sessionId, storedTodos);

    return {
      content:
        "Todos have been modified successfully. " +
        "Ensure that you continue to use the todo list to track your progress. " +
        "Please proceed with the current tasks if applicable",
    };
  },
};

// -----------------------------------------------------------------------------
// 4. Permission rule: always allow TodoWrite
// -----------------------------------------------------------------------------

export function checkPermissionForTodoWrite(toolName) {
  if (toolName === "TodoWrite") {
    return {
      behavior: "allow",
      reason: "TodoWrite writes session-only state",
    };
  }

  return null;
}

// -----------------------------------------------------------------------------
// 5. Session integration pattern
// -----------------------------------------------------------------------------

export function createToolContext(sessionIdRef, cwd) {
  return {
    cwd,

    // Use a live getter so resumed sessions always read the latest id.
    get sessionId() {
      return sessionIdRef.current;
    },
  };
}

export function subscribeSessionTodos(sessionIdRef, setTodosState) {
  setTodosState(getTodos(sessionIdRef.current));

  return subscribeTodos((sid, nextTodos) => {
    if (sid === sessionIdRef.current) {
      setTodosState(nextTodos);
    }
  });
}

// -----------------------------------------------------------------------------
// 6. UI rendering helpers
// -----------------------------------------------------------------------------

export function countTodosByStatus(todos, status) {
  let count = 0;
  for (const todo of todos) {
    if (todo.status === status) count += 1;
  }
  return count;
}

export function getInProgressTodo(todos) {
  return todos.find((todo) => todo.status === "in_progress") || null;
}

export function getEffectiveSpinnerLabel(todos, fallbackLabel) {
  const inProgressTodo = getInProgressTodo(todos);
  return inProgressTodo ? inProgressTodo.activeForm : fallbackLabel;
}

// Todo rows stay static. Only the global status bar spinner animates.
export function formatTodoRows(todos) {
  return todos.map((todo) => {
    if (todo.status === "in_progress") {
      return "▸ " + todo.activeForm;
    }
    if (todo.status === "completed") {
      return "✓ " + todo.content;
    }
    return "○ " + todo.content;
  });
}
