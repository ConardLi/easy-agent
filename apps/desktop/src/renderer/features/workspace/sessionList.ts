import { useMemo } from "react";
import type { MessageParam } from "../../../shared/agent";
import { visibleUserText } from "../../agent/projector/messages";
import { statusOf } from "../../agent/projector/session";
import type { SessionStatus } from "../../agent/viewModel";
import { useSessions } from "../../state/sessions";
import { useWorkspaces } from "../../state/workspaces";

export interface SessionListItem {
  id: string;
  title: string;
  updatedAt: number;
  startedAt: number;
  status: SessionStatus;
  pinned: boolean;
  unread: boolean;
}

const NEW_TITLE = "新会话";

function firstPrompt(messages: readonly MessageParam[]): string | null {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const content = message.content as unknown;
    const texts = typeof content === "string" ? [content] : Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => String(b.text)) : [];
    for (const text of texts) {
      const visible = visibleUserText(text);
      if (visible) return visible.replace(/\s+/g, " ");
    }
  }
  return null;
}

/** Saved sessions plus sessions opened in this run that are not saved yet, most recent first. */
export function useSessionList(workspaceId: string | undefined): SessionListItem[] {
  const saved = useWorkspaces((s) => (workspaceId ? s.runtime[workspaceId]?.sessions : undefined));
  const pinned = useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId)?.pinnedSessions);
  const views = useSessions((s) => s.views);
  const unread = useSessions((s) => s.unread);

  return useMemo(() => {
    if (!workspaceId) return [];
    const items: SessionListItem[] = [];
    const seen = new Set<string>();
    for (const summary of saved ?? []) {
      const view = views[summary.sessionId];
      seen.add(summary.sessionId);
      items.push({
        id: summary.sessionId,
        title: summary.title || summary.firstPrompt || (view && firstPrompt(view.messages)) || NEW_TITLE,
        updatedAt: Date.parse(summary.updatedAt) || 0,
        startedAt: Date.parse(summary.startedAt) || 0,
        status: view ? statusOf(view) : "idle",
        pinned: pinned?.includes(summary.sessionId) ?? false,
        unread: !!unread[summary.sessionId],
      });
    }
    const now = Date.now();
    for (const view of Object.values(views)) {
      if (view.workspaceId !== workspaceId || seen.has(view.id)) continue;
      items.push({
        id: view.id,
        title: firstPrompt(view.messages) ?? NEW_TITLE,
        updatedAt: now,
        startedAt: now,
        status: statusOf(view),
        pinned: pinned?.includes(view.id) ?? false,
        unread: !!unread[view.id],
      });
    }
    return items.sort((a, b) => b.updatedAt - a.updatedAt);
  }, [workspaceId, saved, pinned, views, unread]);
}
