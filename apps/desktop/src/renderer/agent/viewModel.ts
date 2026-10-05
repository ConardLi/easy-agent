/**
 * What the conversation components render. The projector folds Agent
 * events into these shapes; components never read Agent events directly.
 * Migrated from the style reference's `lib/types.ts`.
 */

import type { InteractionRequest, InteractionResolution } from "../../shared/agent";

export type PermissionMode = "default" | "plan" | "auto";
/** "default" leaves reasoning effort to the model. */
export type Effort = "off" | "default" | "low" | "medium" | "high" | "max";
export type SessionStatus = "idle" | "running" | "waiting";

/** Tools with their own card; everything else renders as `other`, with its real name in `label`. */
export type ToolName = "Read" | "Write" | "Edit" | "Bash" | "Grep" | "Glob" | "WebFetch" | "WebSearch" | "Task" | "TodoWrite" | "mcp" | "other";

export type ToolStatus = "running" | "success" | "error" | "denied" | "interrupted";

export interface DiffLine {
  type: "ctx" | "add" | "del" | "hunk";
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface AgentStep {
  label: string;
  done: boolean;
}

export interface ToolCall {
  id: string;
  name: ToolName;
  /** The tool's own name, shown for `other` and MCP tools. */
  label?: string;
  status: ToolStatus;
  /** File path, command, pattern, URL, or sub-agent description. */
  target: string;
  /** Short result line, e.g. "248 行" or "6 处匹配". */
  summary?: string;
  output?: string;
  diff?: DiffLine[];
  added?: number;
  removed?: number;
  startedAt: number;
  durationMs?: number;
  /** A Write that created the file rather than replacing it. */
  created?: boolean;
  agent?: { type: string; steps: AgentStep[]; result?: string; tokens?: number; toolUses?: number; lastTool?: string };
  server?: string;
}

export interface Attachment {
  id: string;
  kind: "image" | "file";
  name: string;
  meta?: string;
  /** CSS background for image previews. */
  preview?: string;
}

export type NoticeIcon = "compact" | "mode" | "interrupt" | "clear" | "command" | "error" | "model";

export type Block =
  | { kind: "user"; id: string; text: string; attachments?: Attachment[]; at?: number }
  | { kind: "assistant"; id: string; text: string; streaming?: boolean }
  | { kind: "thinking"; id: string; text: string; streaming?: boolean; durationMs?: number }
  | { kind: "tool"; id: string; tool: ToolCall }
  /** A request the Agent raised: pending until `resolution` says how it ended. */
  | { kind: "request"; id: string; request: InteractionRequest; resolution?: InteractionResolution }
  | { kind: "notice"; id: string; tone: "info" | "success" | "warning" | "danger"; icon: NoticeIcon; text: string; detail?: string };

/** A file this session changed, for the Changes panel. */
export interface FileChange {
  path: string;
  kind: "modified" | "added" | "deleted";
  added: number;
  removed: number;
  diff: DiffLine[];
}
