import { create } from "zustand";
import type { AppInfo } from "../../shared/contract";

export interface Toast {
  id: string;
  text: string;
  tone: "default" | "success" | "danger";
}

interface UiState {
  appInfo: AppInfo | null;
  toasts: Toast[];
  toast(text: string, tone?: Toast["tone"]): void;
  dismissToast(id: string): void;
}

export const useUi = create<UiState>()((set, get) => ({
  appInfo: null,
  toasts: [],
  toast: (text, tone = "default") => {
    const id = crypto.randomUUID();
    set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, tone }] }));
    setTimeout(() => get().dismissToast(id), 2600);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Entry points whose feature is not wired up yet say so instead of doing nothing. */
export const notYet = (feature: string) => useUi.getState().toast(`${feature}还没接入`);
