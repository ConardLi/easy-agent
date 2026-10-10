import { userInfo } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { AgentMethod } from "../shared/agent";
import { type AppInfo, IPC, type Prefs, type WorkspacePatch } from "../shared/contract";
import type { HostManager } from "./agent/hosts";
import { writeFile } from "node:fs/promises";
import { captureScreenRegion } from "./services/capture";
import { installSkill, listFiles, previewSkill, readText, setMcpJsonServer, skillFolderToRemove, writeText } from "./services/customize";
import { searchFiles } from "./services/files";
import { currentBranch } from "./services/git";
import type { PrefsStore } from "./services/prefs";
import type { SecretStore } from "./services/secrets";
import type { WorkspaceStore } from "./services/workspaces";

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

const asString = (value: unknown) => (typeof value === "string" ? value : "");

export function registerIpc({
  prefs,
  workspaces,
  hosts,
  secrets,
}: {
  prefs: PrefsStore;
  workspaces: WorkspaceStore;
  hosts: HostManager;
  secrets: SecretStore;
}): void {
  ipcMain.handle(IPC.appInfo, () => appInfo());
  ipcMain.handle(IPC.appCaptureScreen, () => captureScreenRegion());
  ipcMain.handle(IPC.appSaveText, async (event, defaultName: unknown, text: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const options = { defaultPath: asString(defaultName).replace(/[/\\]/g, "-") || "export.md" };
    const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return null;
    await writeFile(picked.filePath, asString(text), "utf8");
    return picked.filePath;
  });
  ipcMain.handle(IPC.appOpenPath, async (_event, path: unknown) => {
    const target = asString(path).replace(/^~(?=$|\/)/, homedir());
    if (target) await shell.openPath(target.startsWith("/") ? target : join(homedir(), target));
  });
  ipcMain.handle(IPC.appOpenExternal, async (_event, url: unknown) => {
    const link = asString(url);
    if (/^https:\/\/[^\s]+$/.test(link)) await shell.openExternal(link);
  });
  ipcMain.handle(IPC.secretsList, () => secrets.list());
  ipcMain.handle(IPC.secretsSet, (_event, name: unknown, value: unknown) => {
    const key = asString(name);
    if (!/^[a-z0-9_-]{1,64}$/i.test(key)) throw new Error("Invalid secret name");
    return secrets.set(key, typeof value === "string" && value ? value : null);
  });
  ipcMain.handle(IPC.prefsGet, () => prefs.get());
  // Everything below comes from the renderer, so values are checked before use.
  ipcMain.handle(IPC.prefsUpdate, (_event, patch: Partial<Prefs>) => prefs.update(patch && typeof patch === "object" ? patch : {}));

  ipcMain.handle(IPC.workspacesGet, () => workspaces.get());
  ipcMain.handle(IPC.workspacesOpenFolder, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const options = { title: "打开文件夹", properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[] };
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const path = picked.filePaths[0];
    return picked.canceled || !path ? null : workspaces.add(path);
  });
  ipcMain.handle(IPC.workspacesActivate, (_event, id: unknown) => workspaces.activate(asString(id)));
  ipcMain.handle(IPC.workspacesRemove, async (_event, id: unknown) => {
    await hosts.stop(asString(id));
    await workspaces.remove(asString(id));
  });
  ipcMain.handle(IPC.workspacesUpdate, (_event, id: unknown, patch: WorkspacePatch) =>
    workspaces.update(asString(id), patch && typeof patch === "object" ? patch : {}),
  );
  ipcMain.handle(IPC.workspacesBranch, (_event, id: unknown) => {
    const workspace = workspaces.find(asString(id));
    return workspace ? currentBranch(workspace.path) : null;
  });

  ipcMain.handle(IPC.workspacesFiles, (_event, id: unknown, query: unknown) => {
    const workspace = workspaces.find(asString(id));
    return workspace ? searchFiles(workspace.path, asString(query).slice(0, 200)) : [];
  });

  ipcMain.handle(IPC.agentStart, (_event, id: unknown) => hosts.start(asString(id)));
  ipcMain.handle(IPC.agentRestart, (_event, id: unknown, trust: unknown) => hosts.restart(asString(id), trust === "session" ? "session" : "persisted"));
  ipcMain.handle(IPC.agentCall, (_event, id: unknown, method: unknown, params: unknown) =>
    hosts.call(asString(id), asString(method) as AgentMethod, (params && typeof params === "object" ? params : {}) as never),
  );
  ipcMain.handle(IPC.agentSnapshot, (_event, id: unknown, sessionId: unknown) => hosts.snapshot(asString(id), asString(sessionId)));
  ipcMain.handle(IPC.agentOpenSessions, (_event, id: unknown) => hosts.openSessions(asString(id)));

  const workspacePath = (id: unknown): string => {
    const workspace = workspaces.find(asString(id));
    if (!workspace) throw new Error("没有这个工作区");
    return workspace.path;
  };
  ipcMain.handle(IPC.customizeRead, (_event, id: unknown, path: unknown) => readText(workspacePath(id), asString(path)));
  ipcMain.handle(IPC.customizeWrite, (_event, id: unknown, path: unknown, content: unknown) => writeText(workspacePath(id), asString(path), asString(content)));
  ipcMain.handle(IPC.customizeList, (_event, id: unknown, dir: unknown) => listFiles(workspacePath(id), asString(dir)));
  ipcMain.handle(IPC.customizePickSkill, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const options = { title: "选择技能文件夹", properties: ["openDirectory"] as "openDirectory"[] };
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const path = picked.filePaths[0];
    return picked.canceled || !path ? null : previewSkill(path);
  });
  ipcMain.handle(IPC.customizePreviewSkill, (_event, path: unknown) => previewSkill(asString(path)));
  ipcMain.handle(IPC.customizeInstallSkill, (_event, id: unknown, source: unknown, scope: unknown) =>
    installSkill(workspacePath(id), asString(source), scope === "user" ? "user" : "project"),
  );
  ipcMain.handle(IPC.customizeTrashSkill, async (_event, id: unknown, dir: unknown) => {
    await shell.trashItem(await skillFolderToRemove(workspacePath(id), asString(dir)));
  });
  ipcMain.handle(IPC.customizeMcpJson, (_event, id: unknown, name: unknown, entry: unknown) =>
    setMcpJsonServer(
      workspacePath(id),
      asString(name),
      entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null,
    ),
  );
}
