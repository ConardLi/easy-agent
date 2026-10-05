/**
 * IPC between the main process and the renderer. The preload script exposes
 * `DesktopApi` as `window.easyAgent`; channel names live here so both sides
 * agree on them.
 */

import type { AgentEventMessage, AgentLogMessage, AgentMethod, CallOutcome, HostStatus, ParamsOf, ResultOf, SessionState } from "./agent";

export const THEMES = ["system", "dark", "light"] as const;
export type Theme = (typeof THEMES)[number];

export const ACCENTS = [
  { id: "iris", label: "鸢尾", color: "#7c83ff" },
  { id: "ember", label: "余烬", color: "#f97a45" },
  { id: "jade", label: "玉石", color: "#22c38a" },
  { id: "sky", label: "晴空", color: "#3aa3f0" },
  { id: "rose", label: "蔷薇", color: "#f0588a" },
  { id: "graphite", label: "石墨", color: "#71717a" },
] as const;
export type AccentId = (typeof ACCENTS)[number]["id"];

export const FONT_SIZES = [14, 15, 16] as const;
export type FontSize = (typeof FONT_SIZES)[number];

/** Desktop app preferences, stored in the app data directory, never in Easy Agent settings files. */
export interface Prefs {
  theme: Theme;
  accent: AccentId;
  fontSize: FontSize;
  sidebarOpen: boolean;
}

export const DEFAULT_PREFS: Prefs = { theme: "system", accent: "iris", fontSize: 15, sidebarOpen: true };

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  versions: { electron: string; chrome: string; node: string };
  /** Login name of the OS user, shown in the sidebar footer. */
  userName: string;
}

/** Application menu items the renderer acts on. */
export type MenuCommand = "toggle-sidebar" | "new-session" | "open-folder" | "open-settings";

/** A folder the user opened; each one gets its own Agent process. */
export interface WorkspaceInfo {
  id: string;
  path: string;
  name: string;
  color: string;
  addedAt: number;
  openedAt: number;
  /** Session to reopen next time the workspace is shown. */
  lastSessionId?: string;
  pinnedSessions: string[];
}

export interface WorkspacesState {
  workspaces: WorkspaceInfo[];
  activeId: string | null;
}

export type WorkspacePatch = Partial<Pick<WorkspaceInfo, "lastSessionId" | "pinnedSessions">>;

export const IPC = {
  appInfo: "app:info",
  prefsGet: "prefs:get",
  prefsUpdate: "prefs:update",
  prefsChanged: "prefs:changed",
  menuCommand: "menu:command",
  workspacesGet: "workspaces:get",
  workspacesOpenFolder: "workspaces:open-folder",
  workspacesActivate: "workspaces:activate",
  workspacesRemove: "workspaces:remove",
  workspacesUpdate: "workspaces:update",
  workspacesBranch: "workspaces:branch",
  workspacesChanged: "workspaces:changed",
  agentStart: "agent:start",
  agentRestart: "agent:restart",
  agentCall: "agent:call",
  agentSnapshot: "agent:snapshot",
  agentOpenSessions: "agent:open-sessions",
  agentStatus: "agent:status",
  agentEvent: "agent:event",
  agentLog: "agent:log",
} as const;

export interface DesktopApi {
  platform: string;
  app: { info(): Promise<AppInfo> };
  prefs: {
    get(): Promise<Prefs>;
    update(patch: Partial<Prefs>): Promise<Prefs>;
    /** Changes made outside the renderer, e.g. from the application menu. */
    onChange(listener: (prefs: Prefs) => void): () => void;
  };
  menu: { onCommand(listener: (command: MenuCommand) => void): () => void };
  workspaces: {
    get(): Promise<WorkspacesState>;
    /** Pick a folder with the system dialog and add it; null when cancelled. */
    openFolder(): Promise<WorkspaceInfo | null>;
    activate(id: string): Promise<void>;
    remove(id: string): Promise<void>;
    update(id: string, patch: WorkspacePatch): Promise<void>;
    /** Current git branch, or null outside a repository. */
    branch(id: string): Promise<string | null>;
    onChange(listener: (state: WorkspacesState) => void): () => void;
  };
  agent: {
    /** Start the workspace's Agent process if needed and return its status. */
    start(workspaceId: string): Promise<HostStatus>;
    restart(workspaceId: string, trust: "persisted" | "session"): Promise<HostStatus>;
    call<M extends AgentMethod>(workspaceId: string, method: M, params: ParamsOf<M>): Promise<CallOutcome<ResultOf<M>>>;
    snapshot(workspaceId: string, sessionId: string): Promise<CallOutcome<{ state: SessionState; seq: number }>>;
    openSessions(workspaceId: string): Promise<string[]>;
    onStatus(listener: (workspaceId: string, status: HostStatus) => void): () => void;
    onEvent(listener: (message: AgentEventMessage) => void): () => void;
    onLog(listener: (message: AgentLogMessage) => void): () => void;
  };
}
