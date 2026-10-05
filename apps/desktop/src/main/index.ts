import { join } from "node:path";
import { app, BrowserWindow, Menu, nativeTheme, session } from "electron";
import { IPC, type MenuCommand } from "../shared/contract";
import { HostManager } from "./agent/hosts";
import { registerIpc } from "./ipc";
import { buildMenu } from "./menu";
import { createPrefsStore } from "./services/prefs";
import { createSecretStore } from "./services/secrets";
import { createWorkspaceStore } from "./services/workspaces";
import { applyWindowTheme, createMainWindow } from "./window";

// Tests point the app at a throwaway data directory.
const userDataDir = process.env.EASY_AGENT_DESKTOP_USER_DATA;
if (userDataDir) app.setPath("userData", userDataDir);

app.setName("Easy Agent");

/** Deny every web permission except clipboard writes (copy buttons) and notifications (finished sessions). */
function lockDownSession(): void {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(permission === "clipboard-sanitized-write" || permission === "notifications"),
  );
  app.on("web-contents-created", (_event, contents) => contents.on("will-attach-webview", (e) => e.preventDefault()));
}

function focusOrOpen(): BrowserWindow {
  const win = BrowserWindow.getAllWindows()[0] ?? createMainWindow();
  if (win.isMinimized()) win.restore();
  win.focus();
  return win;
}

async function start(): Promise<void> {
  await app.whenReady();
  const prefs = createPrefsStore(join(app.getPath("userData"), "preferences.json"));
  const workspaces = createWorkspaceStore(join(app.getPath("userData"), "workspaces.json"));
  const secrets = createSecretStore(join(app.getPath("userData"), "secrets.json"));
  const hosts = new HostManager(workspaces, prefs, secrets);
  nativeTheme.themeSource = prefs.get().theme;
  lockDownSession();
  registerIpc({ prefs, workspaces, hosts, secrets });
  workspaces.onChange((state) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.workspacesChanged, state);
  });

  // Let every Agent process end its turns and save its sessions before the app exits.
  let quitting = false;
  app.on("will-quit", (event) => {
    if (quitting || !hosts.running) return;
    event.preventDefault();
    quitting = true;
    void hosts.stopAll().finally(() => app.quit());
  });

  const send = (command: MenuCommand) => (BrowserWindow.getFocusedWindow() ?? focusOrOpen()).webContents.send(IPC.menuCommand, command);
  const refreshMenu = () => Menu.setApplicationMenu(buildMenu({ prefs: prefs.get(), send, updatePrefs: (patch) => void prefs.update(patch) }));
  refreshMenu();

  prefs.onChange((next) => {
    nativeTheme.themeSource = next.theme;
    refreshMenu();
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.prefsChanged, next);
  });
  nativeTheme.on("updated", () => {
    for (const win of BrowserWindow.getAllWindows()) applyWindowTheme(win);
  });

  createMainWindow();
  app.on("activate", () => focusOrOpen());
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => focusOrOpen());
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  void start();
}
