import { create } from "zustand";
import { DEFAULT_PREFS, type Prefs } from "../../shared/contract";
import { desktop } from "../lib/desktop";

interface PrefsState extends Prefs {
  update(patch: Partial<Prefs>): void;
  toggleSidebar(): void;
}

/** Mirror of the preferences the main process stores; the main process has the final say. */
export const usePrefs = create<PrefsState>()((set, get) => ({
  ...DEFAULT_PREFS,
  update: (patch) => {
    set(patch);
    void desktop.prefs.update(patch).then(set);
  },
  toggleSidebar: () => get().update({ sidebarOpen: !get().sidebarOpen }),
}));

export async function loadPrefs(): Promise<void> {
  usePrefs.setState(await desktop.prefs.get());
  desktop.prefs.onChange((prefs) => usePrefs.setState(prefs));
}
