import { create } from "zustand";
import type { AppInfo } from "../../shared/contract";

export interface Toast {
  id: string;
  text: string;
  tone: "default" | "success" | "danger";
}

export type RightTab = "changes" | "tasks" | "context" | "agents";

interface UiState {
  appInfo: AppInfo | null;
  toasts: Toast[];
  rightPanel: boolean;
  rightTab: RightTab;
  /** A composer picker another control asked to open, e.g. `/model`. */
  picker: "model" | "effort" | null;
  setRightPanel(open: boolean, tab?: RightTab): void;
  setPicker(picker: "model" | "effort" | null): void;
  toast(text: string, tone?: Toast["tone"]): void;
  dismissToast(id: string): void;
}

export const useUi = create<UiState>()((set, get) => ({
  appInfo: null,
  toasts: [],
  rightPanel: false,
  rightTab: "changes",
  picker: null,
  setRightPanel: (open, tab) => set((s) => ({ rightPanel: open, rightTab: tab ?? s.rightTab })),
  setPicker: (picker) => set({ picker }),
  toast: (text, tone = "default") => {
    const id = crypto.randomUUID();
    set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, tone }] }));
    setTimeout(() => get().dismissToast(id), 2600);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Entry points whose feature is not wired up yet say so instead of doing nothing. */
export const notYet = (feature: string) => useUi.getState().toast(`${feature}还没接入`);
