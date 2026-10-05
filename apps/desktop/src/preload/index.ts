import { contextBridge, type IpcRendererEvent, ipcRenderer, webUtils } from "electron";
import type { AgentEventMessage, AgentLogMessage, HostStatus } from "../shared/agent";
import { type DesktopApi, IPC, type MenuCommand, type Prefs, type WorkspacesState } from "../shared/contract";

function subscribe<A extends unknown[]>(channel: string, listener: (...args: A) => void): () => void {
  const handler = (_event: IpcRendererEvent, ...args: unknown[]) => listener(...(args as A));
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const api: DesktopApi = {
  platform: process.platform,
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
    captureScreen: () => ipcRenderer.invoke(IPC.appCaptureScreen),
    saveText: (defaultName, text) => ipcRenderer.invoke(IPC.appSaveText, defaultName, text),
    openPath: (path) => ipcRenderer.invoke(IPC.appOpenPath, path),
    openExternal: (url) => ipcRenderer.invoke(IPC.appOpenExternal, url),
  },
  secrets: {
    list: () => ipcRenderer.invoke(IPC.secretsList),
    set: (name, value) => ipcRenderer.invoke(IPC.secretsSet, name, value),
  },
  pathOf: (file) => webUtils.getPathForFile(file),
  prefs: {
    get: () => ipcRenderer.invoke(IPC.prefsGet),
    update: (patch) => ipcRenderer.invoke(IPC.prefsUpdate, patch),
    onChange: (listener) => subscribe<[Prefs]>(IPC.prefsChanged, listener),
  },
  menu: { onCommand: (listener) => subscribe<[MenuCommand]>(IPC.menuCommand, listener) },
  workspaces: {
    get: () => ipcRenderer.invoke(IPC.workspacesGet),
    openFolder: () => ipcRenderer.invoke(IPC.workspacesOpenFolder),
    activate: (id) => ipcRenderer.invoke(IPC.workspacesActivate, id),
    remove: (id) => ipcRenderer.invoke(IPC.workspacesRemove, id),
    update: (id, patch) => ipcRenderer.invoke(IPC.workspacesUpdate, id, patch),
    branch: (id) => ipcRenderer.invoke(IPC.workspacesBranch, id),
    files: (id, query) => ipcRenderer.invoke(IPC.workspacesFiles, id, query),
    onChange: (listener) => subscribe<[WorkspacesState]>(IPC.workspacesChanged, listener),
  },
  agent: {
    start: (workspaceId) => ipcRenderer.invoke(IPC.agentStart, workspaceId),
    restart: (workspaceId, trust) => ipcRenderer.invoke(IPC.agentRestart, workspaceId, trust),
    call: (workspaceId, method, params) => ipcRenderer.invoke(IPC.agentCall, workspaceId, method, params),
    snapshot: (workspaceId, sessionId) => ipcRenderer.invoke(IPC.agentSnapshot, workspaceId, sessionId),
    openSessions: (workspaceId) => ipcRenderer.invoke(IPC.agentOpenSessions, workspaceId),
    onStatus: (listener) => subscribe<[string, HostStatus]>(IPC.agentStatus, listener),
    onEvent: (listener) => subscribe<[AgentEventMessage]>(IPC.agentEvent, listener),
    onLog: (listener) => subscribe<[AgentLogMessage]>(IPC.agentLog, listener),
  },
};

contextBridge.exposeInMainWorld("easyAgent", api);
