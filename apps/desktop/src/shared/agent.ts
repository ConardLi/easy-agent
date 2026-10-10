/**
 * The part of the Easy Agent RPC protocol (`docs/rpc.md`) the desktop client
 * uses. Shapes come from `eagent/sdk` as type-only imports, so nothing from
 * the Agent is bundled into the client.
 */

import type {
  ConfigScope,
  ConfigSnapshot,
  EffortLevel,
  ImageInput,
  McpApprovalResult,
  McpReconnectResult,
  ModelCheckResult,
  InteractionResponse,
  InterruptOutcome,
  PermissionMode,
  ReloadResult,
  RespondOutcome,
  RuntimeCapabilities,
  RuntimeInventory,
  SessionContext,
  SessionEvent,
  SessionState,
  StoredSession,
  StoredSessionSummary,
  TurnResult,
  WorkspaceReport,
} from "eagent/sdk";

export type {
  AgentInventoryItem,
  BackgroundAgentInfo,
  CommandInventoryItem,
  ContextCategory,
  ContextCategoryId,
  ContextItem,
  HookInventoryItem,
  InventorySource,
  McpServerInventoryItem,
  McpServerStatus,
  McpToolInfo,
  OutputStyleInventoryItem,
  PluginInventoryItem,
  ReloadResult,
  RuleInventoryItem,
  RuntimeInventory,
  SessionContext,
  SkillInventoryItem,
  TokenCount,
  ToolInventoryItem,
  ConfigScope,
  ConfigSnapshot,
  EffectiveSetting,
  ModelCheckResult,
  ModelProfileInfo,
  EffortLevel,
  ImageInput,
  InteractionRequest,
  InteractionResolution,
  InteractionResponse,
  MessageParam,
  PermissionInteraction,
  PlanApprovalInteraction,
  QuestionInteraction,
  RuntimeCapabilities,
  SubAgentProgress,
  Task,
  TodoItem,
  PermissionMode,
  SessionEvent,
  SessionState,
  SessionUsage,
  StoredSessionSummary,
  ThinkingConfig,
  ToolProgress,
  TurnResult,
} from "eagent/sdk";

export const RPC_PROTOCOL_VERSION = 1;

export interface InitializeResult {
  protocolVersion: number;
  sessionProtocolVersion: number;
  serverInfo: { name: "eagent"; version: string };
  workspace: WorkspaceReport & { cwd: string };
  capabilities: RuntimeCapabilities;
}

interface OpenSession {
  model?: string;
  permissionMode?: PermissionMode;
}

/** Methods the renderer may call; `initialize` and `shutdown` belong to the host. */
export interface AgentMethods {
  "runtime/capabilities": { params: Record<string, never>; result: RuntimeCapabilities };
  "runtime/inventory": { params: Record<string, never>; result: RuntimeInventory };
  "runtime/reload": { params: Record<string, never>; result: ReloadResult };
  "mcp/approve": { params: { name: string; approved: boolean; scope?: ConfigScope }; result: McpApprovalResult };
  "mcp/reconnect": { params: { name: string }; result: McpReconnectResult };
  "session/context": { params: { sessionId: string }; result: SessionContext };
  "session/create": { params: OpenSession & { persist?: boolean }; result: { sessionId: string; state: SessionState } };
  "session/resume": { params: OpenSession & { sessionId?: string }; result: { sessionId: string; state: SessionState } };
  "session/list": { params: { limit?: number }; result: { sessions: StoredSessionSummary[] } };
  "session/read": { params: { sessionId: string }; result: StoredSession };
  "session/rename": { params: { sessionId: string; title: string }; result: { session: StoredSessionSummary } };
  "session/fork": { params: { sessionId: string; title?: string }; result: { session: StoredSessionSummary } };
  "session/delete": { params: { sessionId: string }; result: Record<string, never> };
  "session/send": { params: { sessionId: string; input: string; queue?: boolean; images?: ImageInput[] }; result: TurnResult };
  "session/command": { params: { sessionId: string; name: string; args?: string[] }; result: TurnResult };
  "session/respond": { params: { sessionId: string; requestId: string; response: InteractionResponse }; result: { outcome: RespondOutcome } };
  "session/interrupt": { params: { sessionId: string }; result: { outcome: InterruptOutcome } };
  "session/state": { params: { sessionId: string }; result: SessionState };
  "session/close": { params: { sessionId: string }; result: Record<string, never> };
  "session/setPermissionMode": { params: { sessionId: string; mode: PermissionMode }; result: Record<string, never> };
  "session/setModel": { params: { sessionId: string; model: string }; result: Record<string, never> };
  "session/setThinking": { params: { sessionId: string; thinking: "on" | "off" | number }; result: Record<string, never> };
  "session/setEffort": { params: { sessionId: string; effort: EffortLevel | null }; result: Record<string, never> };
  "session/stopBackgroundAgent": { params: { sessionId: string; agentId: string }; result: { stopped: boolean } };
  "config/read": { params: Record<string, never>; result: ConfigSnapshot };
  "config/write": { params: { scope: ConfigScope; key: string; value: unknown }; result: { reload: string } };
  "workspace/trust": { params: { trusted: boolean }; result: { trusted: boolean } };
  "models/check": { params: { model: string }; result: ModelCheckResult };
  "models/list": { params: { model: string }; result: { models: string[] } };
}

export type AgentMethod = keyof AgentMethods;
export type ParamsOf<M extends AgentMethod> = AgentMethods[M]["params"];
export type ResultOf<M extends AgentMethod> = AgentMethods[M]["result"];

export const AGENT_METHODS = [
  "runtime/capabilities",
  "runtime/inventory",
  "runtime/reload",
  "mcp/approve",
  "mcp/reconnect",
  "session/context",
  "session/create",
  "session/resume",
  "session/list",
  "session/read",
  "session/rename",
  "session/fork",
  "session/delete",
  "session/send",
  "session/command",
  "session/respond",
  "session/interrupt",
  "session/state",
  "session/close",
  "session/setPermissionMode",
  "session/setModel",
  "session/setThinking",
  "session/setEffort",
  "session/stopBackgroundAgent",
  "config/read",
  "config/write",
  "workspace/trust",
  "models/check",
  "models/list",
] as const satisfies readonly AgentMethod[];

/** A JSON-RPC error, or a failure of the process behind it (`code` 0). */
export interface RpcErrorInfo {
  code: number;
  message: string;
  data?: unknown;
}

export type CallOutcome<T> = { ok: true; result: T } | { ok: false; error: RpcErrorInfo };

/** The Agent process of one workspace, as the renderer sees it. */
export type HostStatus =
  | { state: "starting" }
  | { state: "ready"; init: InitializeResult; trust: "persisted" | "session" }
  | { state: "crashed"; message: string; restarting: boolean }
  | { state: "stopped" };

export interface AgentEventMessage {
  workspaceId: string;
  event: SessionEvent;
}

export interface AgentLogMessage {
  workspaceId: string;
  level: "warn" | "error";
  message: string;
}
