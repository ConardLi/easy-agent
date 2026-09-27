/**
 * Public types for the QueryEngine layer.
 *
 * Extracted verbatim from queryEngine.ts. The QueryEngine module re-exports
 * everything here so existing `import { ... } from "../core/queryEngine.js"`
 * paths (UI hooks, components, headless, scripts) keep working unchanged.
 */

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { AgenticLoopEvent } from "../agenticLoop.js";
import type { Usage } from "../../types/message.js";
import type { TokenWarningResult } from "../../context/autoCompact.js";
import type {
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PermissionRuleSet,
  PermissionSettings,
} from "../../permissions/permissions.js";
import type { TaskMode } from "../../state/taskModeStore.js";
import type { FileHistorySnapshotRecord } from "../../session/storage.js";
import type { SettingSource } from "../../config/sources.js";
import type { PluginScope } from "../../plugins/schemas.js";
import type { ToolContext } from "../../tools/Tool.js";

/**
 * One selectable session in the `/resume` picker. Carries just enough metadata
 * to render a useful row without loading the full transcript.
 */
export interface ResumeSessionInfo {
  sessionId: string;
  startedAt: string;
  updatedAt: string;
  messageCount: number;
  model: string;
  totalTokens: number;
  isCurrent: boolean;
  /** First user prompt — the human-readable label shown in the picker. */
  firstPrompt: string;
}

/** One editable memory target shown in the `/memory` picker. */
export interface MemoryPickerItem {
  /** Human-readable label, e.g. "project AGENT.md" or "memory: <title>". */
  label: string;
  /** Absolute path of the file. */
  path: string;
  /** False when the file doesn't exist yet (created on edit). */
  exists: boolean;
  /** Byte size when it exists, else 0. */
  size: number;
}

/** Where a permission rule lives. "session" rules are in-memory (not editable). */
export type PermissionRuleScope = SettingSource | "session";

/** One allow/deny rule + the layer it came from, for the `/permissions` UI. */
export interface PermissionRuleRow {
  rule: string;
  scope: PermissionRuleScope;
}

/** Structured payload for the interactive `/permissions` manager overlay. */
export interface PermissionsViewData {
  mode: PermissionMode;
  allow: PermissionRuleRow[];
  deny: PermissionRuleRow[];
}

/** Per-kind component counts for one loaded plugin. */
export interface PluginComponentCounts {
  skills: number;
  agents: number;
  commands: number;
  outputStyles: number;
  hooks: number;
  mcpServers: number;
  lspServers?: number;
}

export interface PluginComponentNames {
  skills: string[];
  agents: string[];
  commands: string[];
  outputStyles: string[];
  hooks: string[];
  mcpServers: string[];
  lspServers?: string[];
}

/** An installed plugin, as shown in the manager's "Installed" tab. */
export interface PluginInstalledRow {
  pluginId: string;
  name: string;
  marketplace: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  repository?: string;
  enabled: boolean;
  /** Which settings layer turned it on, when enabled. */
  scope?: PluginScope;
  components: PluginComponentCounts;
  componentNames: PluginComponentNames;
  hasExecutableComponents: boolean;
  warnings: string[];
  errorCount: number;
  /** False when enabled via project/local scope in an untrusted folder. */
  executablesTrusted: boolean;
}

/** A catalogued plugin that is not installed yet — the "Discover" tab. */
export interface PluginAvailableRow {
  pluginId: string;
  name: string;
  marketplace: string;
  description?: string;
  version?: string;
}

/** A registered marketplace — the "Marketplaces" tab. */
export interface PluginMarketplaceRow {
  name: string;
  kind: "local" | "git";
  location: string;
  lastUpdated: string;
  /** Number of plugins the catalog advertises, or null when unreadable. */
  pluginCount: number | null;
  /** Populated when the manifest failed to parse. */
  error?: string;
}

/** Structured payload for the interactive `/plugin` manager overlay. */
export interface PluginViewData {
  installed: PluginInstalledRow[];
  available: PluginAvailableRow[];
  marketplaces: PluginMarketplaceRow[];
  errors: { pluginId: string; scope: string; message: string }[];
  /** Whether project/local executable components may run in this cwd. */
  projectTrusted: boolean;
}

/** A single file's unified-patch body, parsed out of `git diff`. */
export interface DiffFilePatch {
  /** Display path (relative to cwd when possible). */
  path: string;
  /** Porcelain status letters from `git status --short` (e.g. "M", "??"). */
  status: string;
  /** Patch body lines (everything after the `diff --git` header). */
  lines: string[];
}

/** Structured payload for the `/diff` panel — colorized by the UI, not text. */
export interface DiffViewData {
  /** True when the cwd is inside a git work tree. */
  isRepo: boolean;
  /** Working-tree changes vs HEAD, one entry per file. */
  files: DiffFilePatch[];
  /** Aggregate `git diff --shortstat`, or null when nothing changed. */
  gitStat: { files: number; insertions: number; deletions: number } | null;
  /** True when the patch was capped to keep the panel bounded. */
  truncated: boolean;
  /** Number of agent turns summarised in the file-history section. */
  turns: number;
  /** Agent file-history edits over the last `turns` turns. */
  fileHistory:
    | { state: "disabled" }
    | { state: "empty" }
    | {
        state: "changes";
        filesChanged: string[];
        insertions: number;
        deletions: number;
      };
}

export type QueryEngineEvent =
  | AgenticLoopEvent
  | { type: "messages_updated"; messages: MessageParam[] }
  | { type: "compacted"; summary?: string; trigger: "auto" | "manual" | "micro" }
  | { type: "usage_updated"; totalUsage: Usage; turnUsage: Usage; lastCallUsage: Usage }
  | { type: "token_warning"; warning: TokenWarningResult }
  | { type: "command_progress"; title: string; message: string; spinnerLabel: string }
  | { type: "command"; message: string; kind: "info" | "error" }
  | { type: "notice"; tone: "info" | "error"; title: string; body: string }
  | { type: "model_changed"; model: string; source: "default" | "session" }
  | { type: "session_cleared" }
  | { type: "mode_changed"; mode: PermissionMode; previousMode: PermissionMode }
  | { type: "task_mode_changed"; mode: TaskMode; previousMode: TaskMode }
  | { type: "resume_picker"; sessions: ResumeSessionInfo[] }
  | { type: "diff_view"; data: DiffViewData }
  | { type: "open_editor"; filePath: string; label: string }
  | { type: "memory_picker"; items: MemoryPickerItem[] }
  | { type: "permissions_view"; data: PermissionsViewData }
  | { type: "plugin_view"; data: PluginViewData }
  | {
      type: "session_switched";
      sessionId: string;
      messages: MessageParam[];
      totalUsage: Usage;
      fileHistorySnapshots: FileHistorySnapshotRecord[];
    };

export interface QueryEngineOptions {
  model: string;
  toolContext: ToolContext;
  initialMessages?: MessageParam[];
  initialUsage?: Usage;
  permissionMode?: PermissionMode;
  permissionSettings?: PermissionSettings;
  sessionPermissionRules?: PermissionRuleSet;
  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionDecision>;
}

export interface QueryEngineState {
  messages: MessageParam[];
  totalUsage: Usage;
  model: string;
  modelSource: "default" | "session";
}
