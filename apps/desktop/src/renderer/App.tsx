import { AnimatePresence, motion } from "motion/react";
import { Tooltip } from "radix-ui";
import { useEffect, useLayoutEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import type { MenuCommand, Theme } from "../shared/contract";
import { Composer } from "./features/composer/Composer";
import { RightPanel } from "./features/panels/RightPanel";
import { SettingsView } from "./features/settings/SettingsView";
import { Conversation } from "./features/session/Conversation";
import { Toasts } from "./features/shell/Toasts";
import { TopBar } from "./features/shell/TopBar";
import { FirstRun } from "./features/workspace/FirstRun";
import { HostBanner } from "./features/workspace/HostBanner";
import { Sidebar } from "./features/workspace/Sidebar";
import { useSessionList } from "./features/workspace/sessionList";
import { Welcome } from "./features/workspace/Welcome";
import { desktop } from "./lib/desktop";
import { newSession, openFolder } from "./state/actions";
import { usePrefs } from "./state/prefs";
import { useActiveView } from "./state/sessions";
import { useSettings } from "./state/settings";
import { useUi } from "./state/ui";
import { useActiveWorkspace } from "./state/workspaces";

/** Put the theme on the document root; "system" follows the OS color scheme. */
export function applyTheme(theme: Theme, animate = false): void {
  const root = document.documentElement;
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  if (animate && root.classList.contains(dark ? "light" : "dark")) {
    root.classList.add("theme-transition");
    setTimeout(() => root.classList.remove("theme-transition"), 260);
  }
  root.classList.toggle("dark", dark);
  root.classList.toggle("light", !dark);
}

function useAppearance() {
  const { theme, accent, fontSize } = usePrefs(useShallow((s) => ({ theme: s.theme, accent: s.accent, fontSize: s.fontSize })));
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.accent = accent;
    root.dataset.size = String(fontSize);
    applyTheme(theme, true);
    const media = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme(theme, true);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme, accent, fontSize]);
}

const MENU_ACTIONS: Record<MenuCommand, () => void> = {
  "toggle-sidebar": () => usePrefs.getState().toggleSidebar(),
  "new-session": () => newSession(),
  "open-folder": () => void openFolder(),
  "open-settings": () => {
    const settings = useSettings.getState();
    if (settings.open) settings.closeSettings();
    else settings.openSettings();
  },
};

function Main() {
  const workspace = useActiveWorkspace();
  const view = useActiveView();
  const items = useSessionList(workspace?.id);
  if (!workspace) return <FirstRun />;
  if (!view) return <Welcome workspace={workspace} />;
  return (
    <>
      <Conversation view={view} workspaceName={workspace.name} startedAt={items.find((i) => i.id === view.id)?.startedAt} />
      <div className="mx-auto w-full max-w-[796px] px-8 empty:hidden">
        <HostBanner workspace={workspace} className="mb-3" />
      </div>
      <Composer />
    </>
  );
}

/** ⌘J toggles the details panel; the other shortcuts are application menu items. */
function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "j") return;
      const ui = useUi.getState();
      ui.setRightPanel(!ui.rightPanel);
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function App() {
  useAppearance();
  useShortcuts();
  useEffect(() => desktop.menu.onCommand((command) => MENU_ACTIONS[command]()), []);
  const sidebarOpen = usePrefs((s) => s.sidebarOpen);
  const rightPanel = useUi((s) => s.rightPanel);
  const hasSession = !!useActiveView();
  const settingsOpen = useSettings((s) => s.open);

  return (
    <Tooltip.Provider delayDuration={350} skipDelayDuration={200}>
      <div className="flex h-full bg-bg text-fg">
        <AnimatePresence initial={false}>
          {sidebarOpen && (
            <motion.div
              key="sidebar"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 272, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
              className="h-full shrink-0 overflow-hidden"
            >
              <Sidebar />
            </motion.div>
          )}
        </AnimatePresence>

        <main className={sidebarOpen ? "min-w-0 flex-1 py-2 pr-2" : "min-w-0 flex-1 p-2"}>
          <div className="flex h-full overflow-hidden rounded-[14px] bg-canvas shadow-canvas">
            {settingsOpen ? (
              <SettingsView />
            ) : (
              <section className="flex min-w-0 flex-1 flex-col">
                <TopBar />
                <Main />
              </section>
            )}
            <AnimatePresence initial={false}>
              {rightPanel && hasSession && !settingsOpen && (
                <motion.div
                  key="right"
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: 360, opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                  className="h-full shrink-0 overflow-hidden"
                >
                  <RightPanel />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </main>
      </div>
      <Toasts />
    </Tooltip.Provider>
  );
}
