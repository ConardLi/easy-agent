/**
 * useTeammateNavigation — keyboard handler for the teammate-view UX
 * (Shift+↑/↓ to pick, Enter to view, Esc to return, 'k' to kill).
 *
 * Mounted once in App.tsx. Reads from asyncAgentStore (to know which
 * agents exist) and teammateViewStore (to know the current mode +
 * selection), and writes back via the helpers in those stores.
 *
 * Why a dedicated hook, not folded into usePromptInput:
 *   - usePromptInput is busy with text editing and slash-command
 *     suggestions; piling teammate-navigation onto the same useInput
 *     closure makes the precedence rules (e.g. "Esc closes view UNLESS
 *     there's a permission prompt waiting") impossible to read.
 *
 * Key bindings:
 *
 *   Shift+↓   open picker (or move cursor down, with wraparound)
 *   Shift+↑   open picker / move cursor up (with wraparound)
 *   Enter     in `selecting` → commit and switch to `viewing`
 *   Esc       in `selecting` or `viewing` → close (back to main)
 *   k         in `selecting` → kill the highlighted teammate's loop
 *
 * Precedence:
 *   We DO NOT intercept any key while:
 *     - a permission prompt is showing (user is making a decision)
 *     - the model is mid-stream and the user is queueing text
 *   These are checked via the `disabled` flag the caller passes in.
 *   Without that guard, pressing Esc to dismiss a permission prompt
 *   would also tear down whatever teammate view was up, and Shift+↑
 *   while typing would suddenly hijack the cursor.
 */

import { useCallback } from "react";
import { useInput } from "ink";
import type { AsyncAgentEntry } from "../../state/asyncAgentStore.js";
import { killAsyncAgent } from "../../state/asyncAgentStore.js";
import {
  closeTeammateView,
  commitTeammateView,
  getTeammateViewState,
  openTeammatePicker,
  setPickerSelection,
} from "../../state/teammateViewStore.js";

interface UseTeammateNavigationParams {
  /** Live snapshot of all async agents (the subscriber in useAgentSession). */
  agents: AsyncAgentEntry[];
  /**
   * When true, we don't intercept any keys. Caller sets this if a
   * higher-priority input handler is active (permission prompt,
   * /command picker, plan-exit dialog).
   */
  disabled: boolean;
}

/**
 * Pick the next agent in the running set, with wraparound.
 *
 * `direction` is +1 (down) or -1 (up). Returns the next agentId, or
 * null when the running set is empty.
 */
function nextRunningAgentId(agents: AsyncAgentEntry[], currentId: string | null, direction: 1 | -1): string | null {
  const running = agents.filter((a) => a.status === "running");
  if (running.length === 0) return null;
  if (!currentId) return running[0].agentId;
  const idx = running.findIndex((a) => a.agentId === currentId);
  if (idx === -1) return running[0].agentId;
  // (idx + direction + N) % N — JS's % is sign-preserving so we
  // pre-add N to safely wrap on negative.
  const nextIdx = (idx + direction + running.length) % running.length;
  return running[nextIdx].agentId;
}

export function useTeammateNavigation({ agents, disabled }: UseTeammateNavigationParams): void {
  // Stable handler — we read fresh state inside via getTeammateViewState()
  // rather than capturing it, so re-renders don't churn this callback
  // (and Ink's useInput doesn't either).
  const handleInput = useCallback(
    (
      input: string,
      key: {
        shift?: boolean;
        upArrow?: boolean;
        downArrow?: boolean;
        return?: boolean;
        escape?: boolean;
        ctrl?: boolean;
        meta?: boolean;
      },
    ) => {
      if (disabled) return;
      if (key.ctrl || key.meta) return;

      const view = getTeammateViewState();

      // Esc: close any open view/picker. Fires before the Shift+arrow
      // handlers so a stale picker doesn't swallow Esc.
      if (key.escape && view.mode !== "main") {
        closeTeammateView();
        return;
      }

      // Shift+↑ / Shift+↓: open or cycle the picker.
      if (key.shift && (key.upArrow || key.downArrow)) {
        const direction: 1 | -1 = key.downArrow ? 1 : -1;
        if (view.mode === "main") {
          // First press from main view → open picker on the first
          // running agent (for ↓) or the last one (for ↑).
          const running = agents.filter((a) => a.status === "running");
          if (running.length === 0) return;
          const first = direction === 1 ? running[0].agentId : running[running.length - 1].agentId;
          openTeammatePicker(first);
          return;
        }
        if (view.mode === "selecting") {
          const next = nextRunningAgentId(agents, view.selectedAgentId, direction);
          if (next) setPickerSelection(next);
          return;
        }
        if (view.mode === "viewing") {
          // While viewing one teammate, Shift+↑/↓ re-opens the picker
          // — lets the user hop straight to another teammate without
          // pressing Esc first. Cursor lands on the currently-viewed
          // one for visual continuity.
          openTeammatePicker(view.viewingAgentId);
          return;
        }
      }

      // Enter (while selecting): commit → viewing.
      if (key.return && view.mode === "selecting" && view.selectedAgentId) {
        commitTeammateView(view.selectedAgentId);
        return;
      }

      // 'k' (while selecting): kill the highlighted agent. The kill
      // signal aborts the agent's loop; the store transitions the
      // entry to "killed" and useTeammateViewAutoExit will pop us out
      // of viewing mode if the same agent was on screen.
      if (input === "k" && view.mode === "selecting" && view.selectedAgentId) {
        killAsyncAgent(view.selectedAgentId);
      }
    },
    [agents, disabled],
  );

  useInput(handleInput, { isActive: !disabled });
}
