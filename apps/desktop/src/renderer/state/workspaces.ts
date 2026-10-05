import { create } from "zustand";
import type { HostStatus, StoredSessionSummary } from "../../shared/agent";
import type { WorkspaceInfo, WorkspacesState } from "../../shared/contract";

/** What the renderer knows about a workspace's Agent process and saved sessions. */
export interface WorkspaceRuntime {
  status: HostStatus;
  branch: string | null;
  /** Saved sessions, most recent first; null until the first list arrives. */
  sessions: StoredSessionSummary[] | null;
}

interface WorkspacesStore extends WorkspacesState {
  runtime: Record<string, WorkspaceRuntime>;
  patchRuntime(id: string, patch: Partial<WorkspaceRuntime>): void;
}

const EMPTY: WorkspaceRuntime = { status: { state: "stopped" }, branch: null, sessions: null };

export const useWorkspaces = create<WorkspacesStore>()((set) => ({
  workspaces: [],
  activeId: null,
  runtime: {},
  patchRuntime: (id, patch) => set((s) => ({ runtime: { ...s.runtime, [id]: { ...EMPTY, ...s.runtime[id], ...patch } } })),
}));

export const useActiveWorkspace = (): WorkspaceInfo | undefined => useWorkspaces((s) => s.workspaces.find((w) => w.id === s.activeId));

export const useRuntime = (id: string | undefined): WorkspaceRuntime => useWorkspaces((s) => (id ? (s.runtime[id] ?? EMPTY) : EMPTY));
