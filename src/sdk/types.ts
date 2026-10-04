/**
 * Public types of the Easy Agent session SDK.
 *
 * Everything a frontend sees — options, state snapshots, events, interaction
 * requests and responses — is a plain JSON-serializable object, so the same
 * shapes can cross a process boundary unchanged.
 */

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { LoopTerminationReason } from "../core/agenticLoop.js";
import type {
  DiffViewData,
  MemoryPickerItem,
  PermissionsViewData,
  PluginViewData,
  ResumeSessionInfo,
} from "../core/queryEngine/types.js";
import type { TokenWarningResult } from "../context/autoCompact.js";
import type { PermissionMode } from "../permissions/permissions.js";
import type { AsyncAgentEntry } from "../state/asyncAgentStore.js";
import type { BashProgress } from "../state/bashProgressStore.js";
import type { McpProgress } from "../state/mcpProgressStore.js";
import type { SubAgentProgress } from "../state/subAgentProgressStore.js";
import type { TaskMode } from "../state/taskModeStore.js";
import type { ToolStatus } from "../state/toolStatusStore.js";
import type { ToolResult, UserQuestion } from "../tools/Tool.js";
import type { Usage } from "../types/message.js";
import type { Task } from "../types/task.js";
import type { TodoItem } from "../types/todo.js";
import type { EffortLevel, ThinkingConfig } from "../utils/thinking.js";

export type {
  BashProgress,
  DiffViewData,
  EffortLevel,
  LoopTerminationReason,
  McpProgress,
  MemoryPickerItem,
  MessageParam,
  PermissionMode,
  PermissionsViewData,
  PluginViewData,
  ResumeSessionInfo,
  SubAgentProgress,
  Task,
  TaskMode,
  ThinkingConfig,
  TodoItem,
  TokenWarningResult,
  ToolStatus,
  Usage,
  UserQuestion,
};

/**
 * Version of the event, state, and interaction shapes. Additive changes keep
 * the number; removing a field or changing its meaning bumps it.
 */
export const SESSION_PROTOCOL_VERSION = 1;

// ─── Runtime ──────────────────────────────────────────────────────────────

/** Destination for startup warnings and bootstrap errors. */
export interface RuntimeLogger {
  warn(message: string): void;
  error(message: string): void;
}

/** How MCP servers and plugin services are brought up. */
export interface StartServicesOptions {
  /** Connect the MCP servers configured in settings. Default true. */
  mcpServers?: boolean;
  /**
   * Wait for plugin services before resolving. When false, MCP and plugin
   * services start in the background and failures are reported as warnings.
   * Default true.
   */
  wait?: boolean;
}

export interface AgentRuntimeOptions {
  /** Absolute workspace directory. */
  cwd: string;
  /**
   * `persisted` uses the saved workspace trust decision. `session` trusts the
   * workspace for this process only, without saving the decision.
   */
  trust?: "persisted" | "session";
  /**
   * The command-line settings layer (`--settings` file contents plus inline
   * flags such as model, mode, maxTurns, toolSearch). Installed for the whole
   * process; omit it to keep the layer that is already installed.
   */
  flagSettings?: Record<string, unknown>;
  /** Extra plugin directories to load from disk. */
  pluginDirs?: readonly string[];
  /** Tighten permissions of local data directories at startup. Default true. */
  hardenPrivateData?: boolean;
  /** Start MCP and plugin services during creation, or `false` to call `startServices()` later. */
  services?: StartServicesOptions | false;
  /** Where startup warnings go. Defaults to the console. */
  logger?: RuntimeLogger;
}

/** One saved session of the workspace. */
export interface StoredSessionSummary {
  sessionId: string;
  cwd: string;
  startedAt: string;
  updatedAt: string;
  model: string;
  messageCount: number;
  totalUsage: Usage;
  firstPrompt: string;
}

/** A saved session read without opening it. */
export interface StoredSession {
  summary: StoredSessionSummary;
  messages: MessageParam[];
}

/** Commands, skills, and agents the workspace offers. */
export interface RuntimeCapabilities {
  /** Built-in slash command names, sorted. */
  builtinCommands: string[];
  /** Skills a user can invoke as `/<name>`. */
  skills: Array<{ name: string; description: string }>;
  /** User-defined commands loaded from command directories. */
  userCommands: Array<{ name: string; description: string }>;
  /** Sub-agent types available to the Agent tool. */
  agents: string[];
  /** Active output style name. */
  outputStyle: string;
}

// ─── Session options ──────────────────────────────────────────────────────

export type InteractionKind = "permission" | "plan_approval" | "question";

/**
 * Automatic answers for interaction requests. A handler takes precedence over
 * delivering the request to the frontend.
 */
export interface InteractionHandlers {
  permission?: (request: PermissionInteraction) => PermissionResponse | Promise<PermissionResponse>;
  plan_approval?: (request: PlanApprovalInteraction) => PlanApprovalResponse | Promise<PlanApprovalResponse>;
  question?: (request: QuestionInteraction) => QuestionResponse | Promise<QuestionResponse>;
}

export interface AgentSessionOptions {
  /** Model name or profile id. Defaults to the workspace model setting. */
  model?: string;
  /** Initial permission mode. Defaults to the `mode` setting. */
  permissionMode?: PermissionMode;
  /**
   * Tool-turn limit used when neither `--max-turns` nor the `maxTurns` setting
   * is set. Defaults to the agentic loop limit.
   */
  defaultMaxTurns?: number;
  /**
   * Request kinds the frontend answers through `respond()`. Kinds that are
   * neither listed nor handled get the safe default: permission and plan
   * approval are denied, questions are cancelled. Default: all kinds.
   */
  interactions?: readonly InteractionKind[];
  handlers?: InteractionHandlers;
  /**
   * Start a turn automatically when the session is idle and a background
   * agent result or team message arrives. Default true.
   */
  autoWake?: boolean;
  /** Write the session transcript and file-history checkpoints. Default true. */
  persist?: boolean;
}

// ─── Interactions ─────────────────────────────────────────────────────────

interface InteractionBase {
  /** Unique id; pass it to `respond()`. */
  id: string;
  /** Turn that raised the request. */
  turnId: string | null;
}

/** A tool call that needs the user's confirmation. */
export interface PermissionInteraction extends InteractionBase {
  kind: "permission";
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
  risk: string;
  /** Rule that "allow always" would add for this session. */
  ruleHint: string;
}

/** The model asks to leave plan mode with the plan below. */
export interface PlanApprovalInteraction extends InteractionBase {
  kind: "plan_approval";
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
  risk: string;
  ruleHint: string;
  planContent: string | null;
  planFilePath: string;
}

/** AskUserQuestion: one or more multiple-choice questions. */
export interface QuestionInteraction extends InteractionBase {
  kind: "question";
  questions: UserQuestion[];
}

export type InteractionRequest = PermissionInteraction | PlanApprovalInteraction | QuestionInteraction;

export type PermissionResponse = { decision: "allow_once" } | { decision: "allow_always" } | { decision: "deny" };

export type PlanApprovalResponse =
  | {
      decision: "approve";
      /** Drop the planning conversation and start a fresh turn that implements the plan. */
      clearContext?: boolean;
      /**
       * Allow Write, Edit, and npm/npx commands for the rest of the session.
       * Defaults to true when `clearContext` is set, false otherwise.
       */
      acceptEdits?: boolean;
    }
  | {
      decision: "reject";
      /** When given, a follow-up turn asks the model to revise the plan. */
      feedback?: string;
    };

export type QuestionResponse = { answers: Record<string, string> } | { cancelled: true };

export type InteractionResponse = PermissionResponse | PlanApprovalResponse | QuestionResponse;

/** Why a pending request stopped being pending. */
export type InteractionResolution = "response" | "handler" | "interrupt" | "turn_end" | "closed";

export type RespondOutcome = "resolved" | "stale";

// ─── State ────────────────────────────────────────────────────────────────

export interface ContextUsage {
  /** Estimated tokens of the conversation in the context window. */
  tokens: number;
  window: number;
  /** Rounded percentage of the window in use. */
  percent: number;
}

export interface SessionUsage {
  /** Cumulative usage of the session. */
  total: Usage;
  /** Usage of the most recent turn, null before the first turn completes. */
  turn: Usage | null;
  /** Usage of the most recent model request. */
  lastCall: Usage | null;
  context: ContextUsage | null;
}

/** A background agent as seen by frontends. */
export type BackgroundAgentInfo = Omit<AsyncAgentEntry, "abortController" | "ownerScopeId">;

export interface SessionState {
  sessionId: string;
  cwd: string;
  /** A turn (model run or local command) is in progress. */
  busy: boolean;
  turnId: string | null;
  model: string;
  modelSource: "default" | "session";
  permissionMode: PermissionMode;
  taskMode: TaskMode;
  /** Thinking configuration the next request will use. */
  thinking: ThinkingConfig;
  /** Reasoning effort override, null for the model default. */
  effort: EffortLevel | null;
  messages: MessageParam[];
  usage: SessionUsage;
  pendingRequests: InteractionRequest[];
  todos: TodoItem[];
  tasks: Task[];
  backgroundAgents: BackgroundAgentInfo[];
}

// ─── Turns ────────────────────────────────────────────────────────────────

/**
 * What started a turn: user input, a background result that woke the idle
 * session, or a follow-up the session runs after a plan decision.
 */
export type TurnSource = "user" | "background" | "plan_followup" | "feedback_followup";

export type TurnContinuation = "plan_followup" | "feedback_followup";

export interface TurnResult {
  /** Null when the input was empty and nothing ran. */
  turnId: string | null;
  /** False when there was nothing to do. */
  handled: boolean;
  /** How the agentic loop stopped; absent for local commands. */
  reason?: LoopTerminationReason;
  /** Tool turns the agentic loop ran. */
  toolTurns?: number;
  /** Turns the session ran afterwards on its own (plan follow-ups). */
  followUps: TurnResult[];
}

export type InterruptOutcome = "permission_denied" | "question_cancelled" | "turn_aborted" | "idle";

export interface ShellResult {
  output: string;
  isError: boolean;
}

// ─── Events ───────────────────────────────────────────────────────────────

export type ToolProgress =
  | { kind: "status"; status: ToolStatus | null }
  | { kind: "bash"; progress: BashProgress | null }
  | { kind: "mcp"; progress: McpProgress | null }
  | { kind: "subagent"; progress: SubAgentProgress | null };

/** Structured result of a local command that opens a view. */
export type CommandView =
  | { type: "resume_picker"; sessions: ResumeSessionInfo[] }
  | { type: "diff"; data: DiffViewData }
  | { type: "memory_picker"; items: MemoryPickerItem[] }
  | { type: "permissions"; data: PermissionsViewData }
  | { type: "plugins"; data: PluginViewData };

export type SessionEventBody =
  // Session
  | { type: "state_snapshot"; state: SessionState }
  | { type: "messages_changed"; messages: MessageParam[] }
  | { type: "usage_changed"; usage: SessionUsage }
  | { type: "mode_changed"; mode: PermissionMode; previousMode: PermissionMode }
  | { type: "model_changed"; model: string; source: "default" | "session" }
  | { type: "task_mode_changed"; mode: TaskMode }
  | { type: "todos_changed"; todos: TodoItem[] }
  | { type: "tasks_changed"; tasks: Task[] }
  | { type: "background_agents_changed"; agents: BackgroundAgentInfo[] }
  | { type: "session_cleared" }
  | { type: "session_replaced"; sessionId: string; messages: MessageParam[]; totalUsage: Usage }
  | { type: "notice"; tone: "info" | "error"; title: string; body: string }
  // Turns
  | { type: "turn_started"; turnId: string; input: string; source: TurnSource; runsModel: boolean }
  | {
      type: "turn_completed";
      turnId: string;
      handled: boolean;
      reason?: LoopTerminationReason;
      toolTurns?: number;
      continuation?: TurnContinuation;
    }
  | { type: "turn_failed"; turnId: string; error: { name: string; message: string } }
  | { type: "text_delta"; text: string }
  | { type: "thinking_started" }
  | { type: "thinking_delta"; thinking: string }
  | { type: "thinking_completed"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "assistant_message"; message: MessageParam }
  | { type: "tool_started"; toolUseId: string; name: string; subAgentProgress?: SubAgentProgress }
  | { type: "tool_progress"; toolUseId: string; progress: ToolProgress }
  | { type: "tool_completed"; toolUseId: string; name: string; input: Record<string, unknown>; result: ToolResult }
  | { type: "tool_results"; message: MessageParam }
  | { type: "request_opened"; request: InteractionRequest }
  | { type: "request_resolved"; requestId: string; kind: InteractionKind; resolution: InteractionResolution }
  | { type: "api_retry"; attempt: number; maxRetries: number; delayMs: number; message: string }
  | { type: "stream_restart"; reason: "max_tokens_escalation" | "reactive_compact" }
  | { type: "token_warning"; warning: TokenWarningResult }
  | { type: "compacted"; trigger: "auto" | "manual" | "micro"; summary?: string }
  | { type: "error"; message: string }
  // Local commands
  | { type: "command_progress"; title: string; message: string; spinnerLabel: string }
  | { type: "command_output"; kind: "info" | "error"; message: string }
  | { type: "command_view"; view: CommandView }
  | { type: "editor_requested"; filePath: string; label: string };

/** Every event carries the session id and a per-session sequence number. */
export type SessionEvent = SessionEventBody & {
  sessionId: string;
  /** Increases by one per event; a snapshot carries the sequence it reflects. */
  seq: number;
};

export type SessionEventListener = (event: SessionEvent) => void;
