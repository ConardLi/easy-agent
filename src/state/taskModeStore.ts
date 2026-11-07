/**
 * Task-tracking mode — runtime toggle between Task V2 and TodoWrite V1.
 *
 * The mode is a REPL command (`/tasks task|todo`) rather than a boot-time
 * env var, so the user can flip modes inside a live session without
 * restarting.
 *
 * A session starts in the Agent's `features.tasks` mode: `"task"` (the
 * default, persistent task graph) or `"todo"` (the V1 session-memory list).
 * The selection belongs to the active session scope (see sessionScope.ts):
 * all tool `isEnabled()` checks read from here.
 */

import { harnessSetting } from "../harness/active.js";
import { defineSessionState } from "./sessionScope.js";

export type TaskMode = "task" | "todo";

type Listener = (mode: TaskMode) => void;

const taskModeState = defineSessionState("taskMode", () => ({
  mode: defaultTaskMode(),
  listeners: new Set<Listener>(),
}));

/** The mode a session starts in: the Agent's `features.tasks`. */
export function defaultTaskMode(): TaskMode {
  return harnessSetting<TaskMode>("features.tasks");
}

export function getTaskMode(): TaskMode {
  return taskModeState().mode;
}

export function setTaskMode(mode: TaskMode): void {
  const state = taskModeState();
  if (mode === state.mode) return;
  state.mode = mode;
  for (const listener of state.listeners) {
    try {
      listener(mode);
    } catch {
      // Never let a subscriber break the switch.
    }
  }
}

export function subscribeTaskMode(listener: Listener): () => void {
  const { listeners } = taskModeState();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isTaskModeEnabled(): boolean {
  return taskModeState().mode === "task";
}

export function isTodoModeEnabled(): boolean {
  return taskModeState().mode === "todo";
}
