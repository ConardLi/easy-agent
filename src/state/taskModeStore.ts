/**
 * Task-tracking mode — runtime toggle between Task V2 and TodoWrite V1.
 *
 * Claude Code uses an env var (`CLAUDE_CODE_ENABLE_TASKS`) read at boot
 * time. We deliberately lift that into a REPL command (`/tasks task|todo`)
 * so the user can flip modes inside a live session without restarting.
 *
 * `"task"` is the default (persistent task graph). `"todo"` falls back
 * to the V1 session-memory list. The selection is process-global: all
 * tool `isEnabled()` checks read from here.
 */

export type TaskMode = "task" | "todo";

const DEFAULT_TASK_MODE: TaskMode = "task";

let currentMode: TaskMode = DEFAULT_TASK_MODE;

type Listener = (mode: TaskMode) => void;
const listeners = new Set<Listener>();

export function getTaskMode(): TaskMode {
  return currentMode;
}

export function setTaskMode(mode: TaskMode): void {
  if (mode === currentMode) return;
  currentMode = mode;
  for (const listener of listeners) {
    try {
      listener(mode);
    } catch {
      // Never let a subscriber break the switch.
    }
  }
}

export function subscribeTaskMode(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isTaskModeEnabled(): boolean {
  return currentMode === "task";
}

export function isTodoModeEnabled(): boolean {
  return currentMode === "todo";
}
