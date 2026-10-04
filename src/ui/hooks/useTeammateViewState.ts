/**
 * useTeammateViewState — React adapter for `teammateViewStore`.
 *
 * Two things bundled together:
 *
 * 1. Live subscription — components that want to re-render whenever the
 *    view mode / selection changes use the returned `view` snapshot.
 *
 * 2. Auto-exit — when the user is currently viewing or has selected an
 *    agent that just disappeared / finished, we want to drop them back
 *    to the main view automatically (otherwise the screen stays on a
 *    stale transcript that won't grow further).
 *
 *    Auto-exit policy:
 *      - `viewing` mode + agent no longer running AND no longer in
 *        store at all → eject. (Users keep viewing completed teammates
 *        while the entry still exists, so they can read the final
 *        transcript at their leisure.)
 *      - `selecting` mode + selected agent no longer running → bump
 *        cursor to the next running one, or close picker if none left.
 */

import { useEffect, useState } from "react";
import type { BackgroundAgentInfo } from "../../sdk/index.js";
import {
  closeTeammateView,
  getTeammateViewState,
  setPickerSelection,
  subscribeTeammateView,
  type TeammateViewState,
} from "../../state/teammateViewStore.js";

export function useTeammateView(agents: BackgroundAgentInfo[]): TeammateViewState {
  const [view, setView] = useState<TeammateViewState>(() => getTeammateViewState());

  useEffect(() => {
    return subscribeTeammateView(setView);
  }, []);

  // Auto-exit / selection clamping. Runs whenever the agent set OR the
  // current view changes.
  useEffect(() => {
    if (view.mode === "main") return;

    if (view.mode === "viewing" && view.viewingAgentId) {
      // The viewed agent must still exist in the store. If it got
      // pruned (clearAllAsyncAgents during /clear, etc.) bounce back.
      const stillThere = agents.some((a) => a.agentId === view.viewingAgentId);
      if (!stillThere) closeTeammateView();
      // We intentionally do NOT auto-exit on status change here —
      // users want to keep reading the transcript after `completed`.
      return;
    }

    if (view.mode === "selecting" && view.selectedAgentId) {
      const running = agents.filter((a) => a.status === "running");
      if (running.length === 0) {
        closeTeammateView();
        return;
      }
      const cursorStillRunning = running.some((a) => a.agentId === view.selectedAgentId);
      if (!cursorStillRunning) {
        // Bump to first running agent. Don't close the picker — user
        // explicitly opened it and probably wants to pick another.
        setPickerSelection(running[0].agentId);
      }
    }
  }, [agents, view]);

  return view;
}
