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

import { defineSessionState } from "./sessionScope.js";

type Listener = (toolUseId: string, status: ToolStatus | null) => void;

/** Live phases of this session scope's in-flight tool calls. */
const toolStatusState = defineSessionState("toolStatus", () => ({
  store: new Map<string, ToolStatus>(),
  listeners: new Set<Listener>(),
}));

function emit(toolUseId: string, status: ToolStatus | null): void {
  for (const l of toolStatusState().listeners) l(toolUseId, status);
}

export function getToolStatus(toolUseId: string): ToolStatus | undefined {
  return toolStatusState().store.get(toolUseId);
}

/** Set the live execution phase for a tool call and notify subscribers. */
export function setToolStatus(toolUseId: string, status: ToolStatus): void {
  if (toolStatusState().store.get(toolUseId) === status) return;
  toolStatusState().store.set(toolUseId, status);
  emit(toolUseId, status);
}

export function clearToolStatus(toolUseId: string): void {
  if (!toolStatusState().store.has(toolUseId)) return;
  toolStatusState().store.delete(toolUseId);
  emit(toolUseId, null);
}

export function clearAllToolStatus(): void {
  const ids = [...toolStatusState().store.keys()];
  toolStatusState().store.clear();
  for (const id of ids) emit(id, null);
}

export function subscribeToolStatus(listener: Listener): () => void {
  const { listeners } = toolStatusState();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
