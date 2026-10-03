/**
 * teammateViewStore — small state machine for the "look at what each
 * teammate is doing" keyboard UX.
 *
 * Three modes:
 *
 *   main      → default. The lead's main conversation is on screen.
 *   selecting → user pressed Shift+↑/↓; a picker overlay lists every
 *               running async sub-agent. Up/Down cycles the selection,
 *               Enter commits, Esc cancels.
 *   viewing   → user committed a selection. The main conversation is
 *               hidden; the picked teammate's `.output` JSONL is
 *               rendered as a read-only transcript. Esc returns.
 *
 * Why a dedicated store and not a useState in App.tsx:
 *   - The keyboard handler lives in a custom hook (useTeammateNavigation)
 *     that needs to read+update the same state the renderer subscribes to.
 *   - The auto-exit watcher (useTeammateViewState) also subscribes.
 *   - Matching the other cross-cutting stores (todoStore /
 *     subAgentProgressStore / asyncAgentStore) keeps the pattern uniform.
 *
 * Scope:
 *   This is in-memory only — view selection is ephemeral UI state, not
 *   anything you want to persist across sessions.
 */

export type TeammateViewMode = "main" | "selecting" | "viewing";

export interface TeammateViewState {
  mode: TeammateViewMode;
  /** agentId of the picker cursor, or null when mode === 'main'. */
  selectedAgentId: string | null;
  /** agentId of the teammate whose transcript is on screen, or null. */
  viewingAgentId: string | null;
}

type Listener = (state: TeammateViewState) => void;

let state: TeammateViewState = {
  mode: "main",
  selectedAgentId: null,
  viewingAgentId: null,
};

const listeners = new Set<Listener>();

function notify(): void {
  for (const l of listeners) l(state);
}

export function getTeammateViewState(): TeammateViewState {
  return state;
}

export function subscribeTeammateView(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Open the picker. Called when the user presses Shift+↑ or Shift+↓ from
 * the main view. `firstAgentId` is the agent the cursor should land on
 * (typically the first running one). Returns to main if no agents.
 */
export function openTeammatePicker(firstAgentId: string | null): void {
  if (!firstAgentId) {
    closeTeammateView();
    return;
  }
  state = {
    mode: "selecting",
    selectedAgentId: firstAgentId,
    viewingAgentId: null,
  };
  notify();
}

/** Move the picker cursor onto the supplied agent. No-op outside selecting. */
export function setPickerSelection(agentId: string): void {
  if (state.mode !== "selecting") return;
  if (state.selectedAgentId === agentId) return;
  state = { ...state, selectedAgentId: agentId };
  notify();
}

/**
 * Commit the picker selection — transition selecting → viewing. `agentId`
 * is required (caller picks it up from state.selectedAgentId or its own
 * cursor). No-op if mode isn't 'selecting'.
 */
export function commitTeammateView(agentId: string): void {
  if (state.mode !== "selecting") return;
  state = {
    mode: "viewing",
    selectedAgentId: null,
    viewingAgentId: agentId,
  };
  notify();
}

/**
 * Eject the user from `selecting` or `viewing` back to `main`. Idempotent
 * — calling on `main` is a no-op (no spurious notify). Used by:
 *   - Esc keypress
 *   - useTeammateViewAutoExit (when the viewed agent is removed)
 *   - new prompt submission (we want any new turn to start in main view)
 */
export function closeTeammateView(): void {
  if (state.mode === "main") return;
  state = { mode: "main", selectedAgentId: null, viewingAgentId: null };
  notify();
}
