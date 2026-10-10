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
  /** The key that sends a message; the other combination inserts a newline. */
  sendWith: "enter" | "mod-enter";
  /** Notify when a session finishes a turn or waits for an answer while the window is in the background. */
  notifyOnFinish: boolean;
  reopenLastWorkspace: boolean;
  /** Keep thinking expanded while it streams. */
  showThinking: boolean;
  /** Run the bundled Agent, or an `eagent` installed on the system. */
  agentRuntime: "bundled" | "system";
  agentPath: string;
  /** Passed as `--settings`; layered above user, project, and local settings. */
  extraSettingsFile: string;
  autoRestart: boolean;
  debugLogging: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  theme: "system",
  accent: "iris",
  fontSize: 15,
  sidebarOpen: true,
  sendWith: "enter",
  notifyOnFinish: true,
  reopenLastWorkspace: true,
  showThinking: true,
  agentRuntime: "bundled",
  agentPath: "eagent",
  extraSettingsFile: "",
  autoRestart: true,
  debugLogging: false,
};

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  versions: { electron: string; chrome: string; node: string };
  /** Login name of the OS user, shown in the sidebar footer. */
  userName: string;
}

/** Application menu items the renderer acts on. */
export type MenuCommand = "toggle-sidebar" | "new-session" | "open-folder" | "open-settings" | "open-customize";

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

/** Environment variable a keychain key is passed to the Agent as; settings files refer to it as `${…}`. */
export const secretEnvName = (name: string) => `EASY_AGENT_KEY_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;

/** An image the main process produced, e.g. a screen capture. */
export interface CapturedImage {
  data: string;
  mimeType: "image/png";
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
  workspacesFiles: "workspaces:files",
  appCaptureScreen: "app:capture-screen",
  appSaveText: "app:save-text",
  appOpenPath: "app:open-path",
  appOpenExternal: "app:open-external",
  secretsList: "secrets:list",
  secretsSet: "secrets:set",
  workspacesChanged: "workspaces:changed",
  agentStart: "agent:start",
  agentRestart: "agent:restart",
  agentCall: "agent:call",
  agentSnapshot: "agent:snapshot",
  agentOpenSessions: "agent:open-sessions",
  agentStatus: "agent:status",
  agentEvent: "agent:event",
  agentLog: "agent:log",
  customizeRead: "customize:read",
  customizeWrite: "customize:write",
  customizeList: "customize:list",
  customizePickSkill: "customize:pick-skill",
  customizePreviewSkill: "customize:preview-skill",
  customizeInstallSkill: "customize:install-skill",
  customizeTrashSkill: "customize:trash-skill",
  customizeMcpJson: "customize:mcp-json",
} as const;

/** A skill folder read before it is installed. */
export interface SkillPreview {
  source: string;
  name: string;
  description: string;
  files: string[];
}

export interface DesktopApi {
  platform: string;
  app: {
    info(): Promise<AppInfo>;
    /** Let the user select a screen region; null when cancelled or unsupported on this platform. */
    captureScreen(): Promise<CapturedImage | null>;
    /** Save text through the system save dialog; returns the path, or null when cancelled. */
    saveText(defaultName: string, text: string): Promise<string | null>;
    /** Show a folder in the file manager; `~` is the home directory. */
    openPath(path: string): Promise<void>;
    /** Open an https link in the default browser. */
    openExternal(url: string): Promise<void>;
  };
  /** API keys kept in the OS keychain; the Agent gets each as `${EASY_AGENT_KEY_<NAME>}`. */
  secrets: {
    /** Stored names with masked values. */
    list(): Promise<Record<string, string>>;
    /** Store a key, or delete it with null. Agent processes see the change after they restart. */
    set(name: string, value: string | null): Promise<void>;
  };
  /** Absolute path of a file dropped or pasted into the page, or "" when it has none. */
  pathOf(file: File): string;
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
    /** Workspace files matching a query, relative to the workspace root. */
    files(id: string, query: string): Promise<string[]>;
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
  /**
   * Files behind the customize pages. Paths must be inside the workspace or
   * `~/.easy-agent`, or be an AGENTS.md / AGENT.md in a parent folder; only
   * Markdown files can be written.
   */
  customize: {
    readText(workspaceId: string, path: string): Promise<string>;
    writeText(workspaceId: string, path: string, content: string): Promise<void>;
    /** Files in a folder, relative to it. */
    listFiles(workspaceId: string, dir: string): Promise<string[]>;
    /** Choose a skill folder with the system dialog; null when cancelled. */
    pickSkill(): Promise<SkillPreview | null>;
    /** Read a dropped skill folder or SKILL.md. */
    previewSkill(path: string): Promise<SkillPreview>;
    /** Copy a skill into the user or project skills folder; returns the new folder. */
    installSkill(workspaceId: string, source: string, scope: "user" | "project"): Promise<string>;
    /** Move a skill folder from the user or project skills folder to the trash. */
    trashSkill(workspaceId: string, dir: string): Promise<void>;
    /** Add, replace, or (with null) remove one server in the project's `.mcp.json`. */
    setMcpJsonServer(workspaceId: string, name: string, entry: Record<string, unknown> | null): Promise<void>;
  };
}
