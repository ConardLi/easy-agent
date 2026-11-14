import { create } from "zustand";
import type { HarnessSummary, HostStatus, StoredSessionSummary } from "../../shared/agent";
import type { WorkspaceInfo, WorkspacesState } from "../../shared/contract";

/** What the renderer knows about a workspace's Agent processes and saved sessions. */
export interface WorkspaceRuntime {
  /** The process that runs the workspace's default Agent. */
  status: HostStatus;
  /** Processes started for other Agents, by Agent name. */
  agentHosts: Record<string, HostStatus>;
  /** Agents a new session can run with (`harness/list`); null until the list arrives. */
  agents: HarnessSummary[] | null;
  branch: string | null;
  /** Saved sessions, most recent first; null until the first list arrives. */
  sessions: StoredSessionSummary[] | null;
}

interface WorkspacesStore extends WorkspacesState {
  runtime: Record<string, WorkspaceRuntime>;
  patchRuntime(id: string, patch: Partial<WorkspaceRuntime>): void;
}

const EMPTY: WorkspaceRuntime = { status: { state: "stopped" }, agentHosts: {}, agents: null, branch: null, sessions: null };

export const useWorkspaces = create<WorkspacesStore>()((set) => ({
  workspaces: [],
  activeId: null,
  runtime: {},
  patchRuntime: (id, patch) => set((s) => ({ runtime: { ...s.runtime, [id]: { ...EMPTY, ...s.runtime[id], ...patch } } })),
}));

export const useActiveWorkspace = (): WorkspaceInfo | undefined => useWorkspaces((s) => s.workspaces.find((w) => w.id === s.activeId));

export const useRuntime = (id: string | undefined): WorkspaceRuntime => useWorkspaces((s) => (id ? (s.runtime[id] ?? EMPTY) : EMPTY));

/** The Agent a session runs with when none is picked: the one the default-Agent process runs. */
export function defaultAgentOf(runtime: WorkspaceRuntime | undefined): string {
  return runtime?.status.state === "ready" ? runtime.status.harness.name : "default";
}

/** The process that runs `agent` in the workspace; the default-Agent process for its own Agent or none. */
export function hostStatusOf(runtime: WorkspaceRuntime, agent: string | undefined): HostStatus {
  if (!agent || agent === defaultAgentOf(runtime)) return runtime.status;
  return runtime.agentHosts[agent] ?? runtime.status;
}
