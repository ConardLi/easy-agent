import { create } from "zustand";
import type { ImageInput, RewindScope } from "../../shared/agent";
import type { AppInfo } from "../../shared/contract";

/** A rewind waiting for the person to confirm it. */
export interface RewindRequest {
  workspaceId: string;
  sessionId: string;
  /** Checkpoint id; absent for undoing every change of the session. */
  to?: string;
  scope: RewindScope;
  /** What follows: the prompt goes back into the composer, or runs again. */
  followUp?: { kind: "edit" | "regenerate"; text: string; images: ImageInput[] };
}

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
  /** Text and images the composer should take over, e.g. after rewinding to a message. */
  composerInject: { text: string; images: ImageInput[]; nonce: number } | null;
  rewind: RewindRequest | null;
  setRightPanel(open: boolean, tab?: RightTab): void;
  setPicker(picker: "model" | "effort" | null): void;
  injectComposer(text: string, images?: ImageInput[]): void;
  setRewind(rewind: RewindRequest | null): void;
  toast(text: string, tone?: Toast["tone"]): void;
  dismissToast(id: string): void;
}

export const useUi = create<UiState>()((set, get) => ({
  appInfo: null,
  toasts: [],
  rightPanel: false,
  rightTab: "changes",
  picker: null,
  composerInject: null,
  rewind: null,
  setRightPanel: (open, tab) => set((s) => ({ rightPanel: open, rightTab: tab ?? s.rightTab })),
  setPicker: (picker) => set({ picker }),
  injectComposer: (text, images = []) => set({ composerInject: { text, images, nonce: Date.now() } }),
  setRewind: (rewind) => set({ rewind }),
  toast: (text, tone = "default") => {
    const id = crypto.randomUUID();
    set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, tone }] }));
    setTimeout(() => get().dismissToast(id), 2600);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Entry points whose feature is not wired up yet say so instead of doing nothing. */
export const notYet = (feature: string) => useUi.getState().toast(`${feature}还没接入`);
