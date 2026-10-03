/**
 * Tool status store — live execution phase for each in-flight tool call.
 *
 * Same side-channel pattern as `bashProgressStore` / `subAgentProgressStore`:
 * while the agentic loop is blocked inside `await runTools(...)` there is no
 * way to yield events back into the UI, so `runOneToolBlock` publishes the
 * execution phase here keyed by the parent's `tool_use.id`, and the UI
 * subscribes to drive the tool-card state machine.
 *
 * Phases:
 *   - (absent)            → queued: the model emitted the tool_use block but
 *                           the loop hasn't started running it yet
 *   - "classifier"        → Auto-mode safety classifier is checking the call
 *   - "waiting-permission"→ blocked awaiting the user's approval
 *   - "running"           → the tool is actively executing
 * A card whose result has landed (resultLength set) is "done"/"error" and
 * ignores the live status; the status map is fully cleared when the turn's
 * tool results are committed.
 */

export type ToolStatus = "queued" | "running" | "waiting-permission" | "classifier";

type Listener = (toolUseId: string, status: ToolStatus | null) => void;

const store = new Map<string, ToolStatus>();
const listeners = new Set<Listener>();

function emit(toolUseId: string, status: ToolStatus | null): void {
  for (const l of listeners) l(toolUseId, status);
}

export function getToolStatus(toolUseId: string): ToolStatus | undefined {
  return store.get(toolUseId);
}

/** Set the live execution phase for a tool call and notify subscribers. */
export function setToolStatus(toolUseId: string, status: ToolStatus): void {
  if (store.get(toolUseId) === status) return;
  store.set(toolUseId, status);
  emit(toolUseId, status);
}

export function clearToolStatus(toolUseId: string): void {
  if (!store.has(toolUseId)) return;
  store.delete(toolUseId);
  emit(toolUseId, null);
}

export function clearAllToolStatus(): void {
  const ids = [...store.keys()];
  store.clear();
  for (const id of ids) emit(id, null);
}

export function subscribeToolStatus(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
