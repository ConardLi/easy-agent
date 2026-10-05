import { create } from "zustand";
import type { SessionEvent } from "../../shared/agent";
import { applyEvent, type SessionView, viewFromState } from "../agent/projector/session";
import type { Effort, PermissionMode } from "../agent/viewModel";

/** Composer settings for a session that has not been created yet. */
export interface Draft {
  /** Unset means the workspace's default model. */
  model?: string;
  mode: PermissionMode;
  effort: Effort;
}

interface SessionsStore {
  /** Open sessions, by id. */
  views: Record<string, SessionView>;
  /** The conversation on screen; null shows the new-session page. */
  activeId: string | null;
  draft: Draft;
  /** Sessions that finished a turn while another one was on screen. */
  unread: Record<string, true>;
  applyEvents(events: { workspaceId: string; event: SessionEvent }[]): void;
  setDraft(patch: Partial<Draft>): void;
}

export const useSessions = create<SessionsStore>()((set) => ({
  views: {},
  activeId: null,
  draft: { mode: "default", effort: "default" },
  unread: {},
  applyEvents: (events) =>
    set((s) => {
      const views = { ...s.views };
      const unread = { ...s.unread };
      let activeId = s.activeId;
      for (const { workspaceId, event } of events) {
        let view = views[event.sessionId];
        if (!view && event.type === "session_replaced") {
          // `/resume <id>` typed in an open session: its events now carry the new id.
          const previous = Object.values(views).find((v) => v.workspaceId === workspaceId && v.turn && /^\/resume\b/.test(v.turn.input));
          if (previous) {
            delete views[previous.id];
            if (activeId === previous.id) activeId = event.sessionId;
            view = previous;
          }
        }
        if (!view) {
          if (event.type !== "state_snapshot") continue;
          views[event.sessionId] = viewFromState(workspaceId, event.state, event.seq);
          continue;
        }
        const next = applyEvent(view, event);
        views[next.id] = next;
        if (event.type === "turn_completed" && next.id !== activeId) unread[next.id] = true;
      }
      return { views, unread, activeId };
    }),
  setDraft: (patch) => set((s) => ({ draft: { ...s.draft, ...patch } })),
}));

export const useActiveView = (): SessionView | undefined => useSessions((s) => (s.activeId ? s.views[s.activeId] : undefined));
