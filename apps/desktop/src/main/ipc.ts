import { userInfo } from "node:os";
import { app, ipcMain } from "electron";
import { type AppInfo, IPC, type Prefs } from "../shared/contract";
import type { PrefsStore } from "./services/prefs";

function appInfo(): AppInfo {
  let userName = "";
  try {
    userName = userInfo().username;
  } catch {}
  return {
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    userName,
  };
}

export function registerIpc(prefs: PrefsStore): void {
  ipcMain.handle(IPC.appInfo, () => appInfo());
  ipcMain.handle(IPC.prefsGet, () => prefs.get());
  // The patch comes from the renderer, so the store validates every value.
  ipcMain.handle(IPC.prefsUpdate, (_event, patch: Partial<Prefs>) => prefs.update(patch && typeof patch === "object" ? patch : {}));
}
