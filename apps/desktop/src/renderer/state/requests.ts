import { create } from "zustand";
import { useWorkspaces } from "./workspaces";

interface RequestsStore {
  comparison: { workspaceId: string; agent: string } | null;
  openComparison(workspaceId: string, agent: string): void;
  closeComparison(): void;
}

export const useRequests = create<RequestsStore>()((set) => ({
  comparison: null,
  openComparison: (workspaceId, agent) => set({ comparison: { workspaceId, agent } }),
  closeComparison: () => set({ comparison: null }),
}));

useWorkspaces.subscribe((state, previous) => {
  if (state.activeId !== previous.activeId) useRequests.getState().closeComparison();
});
