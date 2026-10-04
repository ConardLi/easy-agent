import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
import { type DesktopApi, IPC, type MenuCommand, type Prefs } from "../shared/contract";

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const api: DesktopApi = {
  platform: process.platform,
  app: { info: () => ipcRenderer.invoke(IPC.appInfo) },
  prefs: {
    get: () => ipcRenderer.invoke(IPC.prefsGet),
    update: (patch) => ipcRenderer.invoke(IPC.prefsUpdate, patch),
    onChange: (listener) => subscribe<Prefs>(IPC.prefsChanged, listener),
  },
  menu: { onCommand: (listener) => subscribe<MenuCommand>(IPC.menuCommand, listener) },
};

contextBridge.exposeInMainWorld("easyAgent", api);
