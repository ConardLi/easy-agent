/**
 * Easy Agent RPC protocol, version 1.
 *
 * JSON-RPC 2.0 over stdio, one message per line. The client calls methods on
 * the server; the server answers each request and pushes session events as
 * `session/event` notifications. Interaction requests (permission, plan
 * approval, question) arrive as `request_opened` events and are answered with
 * `session/respond`, so a client handles one kind of server-to-client message.
 *
 * The zod schemas below validate what clients send, and the published JSON
 * Schema (`docs/rpc-protocol.schema.json`) is generated from them. Server-to-client
 * shapes are described with schemas too, so the published document covers
 * both directions; the server builds those messages from SDK types and the
 * tests validate real traffic against the schema.
 *
 * Versioning follows the session SDK: adding methods, params, result fields,
 * or event fields keeps the version; removing or changing the meaning of any
 * of them bumps it. Unknown params and fields must be ignored by both sides.
 */

import { z } from "zod";
import { SESSION_EVENT_TYPES } from "../sdk/types.js";

export const RPC_PROTOCOL_VERSION = 1;
export const SUPPORTED_RPC_PROTOCOL_VERSIONS: readonly number[] = [RPC_PROTOCOL_VERSION];

/** JSON-RPC error codes. -32768..-32000 is reserved; the server range is -32099..-32000. */
export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** The session SDK rejected the call; `data.code` is the SDK error code. */
  AgentError: -32000,
  /** A method other than `initialize` arrived before `initialize` succeeded. */
  NotInitialized: -32001,
  /** The client's protocol version is not supported; `data.supported` lists the versions. */
  UnsupportedProtocolVersion: -32002,
  /** No open session has this id; `data.sessionId` echoes it. */
  SessionNotFound: -32003,
  /** `initialize` was called twice. */
  AlreadyInitialized: -32004,
} as const;

// ─── Shared shapes ────────────────────────────────────────────────────────

const RequestId = z.union([z.string(), z.number()]);
const SessionId = z.string().min(1);
const InteractionKind = z.enum(["permission", "plan_approval", "question"]);
const PermissionMode = z.enum(["default", "plan", "auto"]);

const PermissionResponse = z.object({ decision: z.enum(["allow_once", "allow_always", "deny"]) });
const PlanApprovalResponse = z.union([
  z.object({
    decision: z.literal("approve"),
    clearContext: z.boolean().optional(),
    acceptEdits: z.boolean().optional(),
  }),
  z.object({ decision: z.literal("reject"), feedback: z.string().optional() }),
]);
const QuestionResponse = z.union([
  z.object({ answers: z.record(z.string(), z.string()) }),
  z.object({ cancelled: z.literal(true) }),
]);
export const InteractionResponseSchema = z.union([PermissionResponse, PlanApprovalResponse, QuestionResponse]);

const ToolInteractionFields = {
  id: z.string(),
  turnId: z.string().nullable(),
  toolUseId: z.string().nullable(),
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()),
  summary: z.string(),
  risk: z.string(),
  ruleHint: z.string(),
};

export const InteractionRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("permission"), ...ToolInteractionFields }),
  z.object({
    kind: z.literal("plan_approval"),
    ...ToolInteractionFields,
    planContent: z.string().nullable(),
    planFilePath: z.string(),
  }),
  z.object({
    kind: z.literal("question"),
    id: z.string(),
    turnId: z.string().nullable(),
    questions: z.array(
      z
        .object({
          question: z.string(),
          header: z.string().optional(),
          options: z.array(z.object({ label: z.string(), description: z.string().optional() }).loose()),
          multiSelect: z.boolean().optional(),
        })
        .loose(),
    ),
  }),
]);

const TurnResultSchema: z.ZodType = z.lazy(() =>
  z.object({
    turnId: z.string().nullable(),
    handled: z.boolean(),
    reason: z.enum(["completed", "aborted", "model_error", "max_turns", "blocking_limit"]).optional(),
    toolTurns: z.number().int().optional(),
    followUps: z.array(TurnResultSchema),
  }),
);

const StoredSessionSummarySchema = z
  .object({
    sessionId: z.string(),
    cwd: z.string(),
    startedAt: z.string(),
    updatedAt: z.string(),
    model: z.string(),
    messageCount: z.number().int(),
    totalUsage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).loose(),
    firstPrompt: z.string(),
    title: z.string().optional(),
  })
  .loose();

/** Session state; the fields are those of the SDK's `SessionState`. */
const SessionStateSchema = z
  .object({
    sessionId: z.string(),
    cwd: z.string(),
    busy: z.boolean(),
    turnId: z.string().nullable(),
    model: z.string(),
    permissionMode: PermissionMode,
    messages: z.array(z.object({ role: z.string(), content: z.unknown() }).loose()),
    pendingRequests: z.array(InteractionRequestSchema),
  })
  .loose();

// ─── Client → server ──────────────────────────────────────────────────────

const OpenSessionOptions = {
  /** Model name or profile id; defaults to the workspace model setting. */
  model: z.string().min(1).optional(),
  permissionMode: PermissionMode.optional(),
};

/** Params of every method, keyed by method name. */
export const MethodParams = {
  initialize: z.object({
    protocolVersion: z.number().int(),
    clientInfo: z.object({ name: z.string(), version: z.string().optional() }).optional(),
    /** "session" trusts the workspace for this process only, like `--trust-project-config`. */
    trust: z.enum(["persisted", "session"]).optional(),
    /** Interaction kinds the client answers; the rest get the safe default. Defaults to all. */
    interactions: z.array(InteractionKind).optional(),
    /** "wait" connects MCP servers and plugin services before answering. Defaults to "background". */
    services: z.enum(["background", "wait"]).optional(),
  }),
  "runtime/capabilities": z.object({}),
  "session/create": z.object({ ...OpenSessionOptions, persist: z.boolean().optional() }),
  "session/resume": z.object({ sessionId: SessionId.optional(), ...OpenSessionOptions }),
  "session/list": z.object({ limit: z.number().int().positive().optional() }),
  "session/read": z.object({ sessionId: SessionId }),
  "session/rename": z.object({ sessionId: SessionId, title: z.string() }),
  "session/delete": z.object({ sessionId: SessionId }),
  "session/fork": z.object({ sessionId: SessionId, title: z.string().optional() }),
  "session/send": z.object({
    sessionId: SessionId,
    input: z.string(),
    /** Wait for a running turn to finish instead of failing with `busy`. */
    queue: z.boolean().optional(),
    /** Base64 images the model sees with the input. */
    images: z.array(z.object({ data: z.string(), mimeType: z.string() })).optional(),
  }),
  "session/command": z.object({ sessionId: SessionId, name: z.string().min(1), args: z.array(z.string()).optional() }),
  "session/respond": z.object({ sessionId: SessionId, requestId: z.string(), response: InteractionResponseSchema }),
  "session/interrupt": z.object({ sessionId: SessionId }),
  "session/state": z.object({ sessionId: SessionId }),
  "session/shell": z.object({ sessionId: SessionId, command: z.string().min(1) }),
  "session/close": z.object({ sessionId: SessionId }),
  /** Takes effect right away, also while a turn runs. */
  "session/setPermissionMode": z.object({ sessionId: SessionId, mode: PermissionMode }),
  /** Model name or profile id; `"default"` clears the session override. */
  "session/setModel": z.object({ sessionId: SessionId, model: z.string().min(1) }),
  "session/setThinking": z.object({
    sessionId: SessionId,
    thinking: z.union([z.enum(["on", "off"]), z.number().int().positive()]),
  }),
  /** `null` leaves the effort to the model. */
  "session/setEffort": z.object({ sessionId: SessionId, effort: z.enum(["low", "medium", "high", "max"]).nullable() }),
  "session/stopBackgroundAgent": z.object({ sessionId: SessionId, agentId: z.string().min(1) }),
  shutdown: z.object({}),
} as const;

export type MethodName = keyof typeof MethodParams;
export type ParamsOf<M extends MethodName> = z.infer<(typeof MethodParams)[M]>;

/** Results, keyed by method name; documentation and tests only. */
export const MethodResults = {
  initialize: z.object({
    protocolVersion: z.number().int(),
    sessionProtocolVersion: z.number().int(),
    serverInfo: z.object({ name: z.literal("eagent"), version: z.string() }),
    workspace: z.object({
      cwd: z.string(),
      projectTrusted: z.boolean(),
      ignoredProjectConfig: z.array(z.string()),
      ignoredCredentialOverrides: z.number().int(),
      sandboxUnavailableReason: z.string().nullable(),
    }),
    capabilities: z
      .object({
        builtinCommands: z.array(z.string()),
        skills: z.array(z.object({ name: z.string(), description: z.string() })),
        userCommands: z.array(z.object({ name: z.string(), description: z.string() })),
        agents: z.array(z.string()),
        outputStyle: z.string(),
      })
      .loose(),
  }),
  "runtime/capabilities": z.object({ builtinCommands: z.array(z.string()) }).loose(),
  "session/create": z.object({ sessionId: z.string(), state: SessionStateSchema }),
  "session/resume": z.object({ sessionId: z.string(), state: SessionStateSchema }),
  "session/list": z.object({ sessions: z.array(StoredSessionSummarySchema) }),
  "session/read": z.object({ summary: StoredSessionSummarySchema, messages: z.array(z.unknown()) }),
  "session/rename": z.object({ session: StoredSessionSummarySchema }),
  "session/delete": z.object({}),
  "session/fork": z.object({ session: StoredSessionSummarySchema }),
  "session/send": TurnResultSchema,
  "session/command": TurnResultSchema,
  "session/respond": z.object({ outcome: z.enum(["resolved", "stale"]) }),
  "session/interrupt": z.object({
    outcome: z.enum(["permission_denied", "question_cancelled", "turn_aborted", "idle"]),
  }),
  "session/state": SessionStateSchema,
  "session/shell": z.object({ output: z.string(), isError: z.boolean() }),
  "session/close": z.object({}),
  "session/setPermissionMode": z.object({}),
  "session/setModel": z.object({}),
  "session/setThinking": z.object({}),
  "session/setEffort": z.object({}),
  "session/stopBackgroundAgent": z.object({ stopped: z.boolean() }),
  shutdown: z.object({}),
} as const satisfies Record<MethodName, z.ZodType>;

// ─── Server → client ──────────────────────────────────────────────────────

/** `session/event` params: one SDK session event. */
export const SessionEventSchema = z
  .object({
    type: z.enum(SESSION_EVENT_TYPES),
    sessionId: z.string(),
    seq: z.number().int().nonnegative(),
    request: InteractionRequestSchema.optional(),
  })
  .loose();

export const NotificationParams = {
  "session/event": SessionEventSchema,
  "runtime/log": z.object({ level: z.enum(["warn", "error"]), message: z.string() }),
} as const;

export const ErrorObjectSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});

/** Envelopes of the four JSON-RPC message kinds. */
export const Envelopes = {
  request: z.object({ jsonrpc: z.literal("2.0"), id: RequestId, method: z.string(), params: z.unknown().optional() }),
  notification: z.object({ jsonrpc: z.literal("2.0"), method: z.string(), params: z.unknown().optional() }),
  result: z.object({ jsonrpc: z.literal("2.0"), id: RequestId, result: z.unknown() }),
  error: z.object({ jsonrpc: z.literal("2.0"), id: RequestId.nullable(), error: ErrorObjectSchema }),
} as const;

// ─── Whole messages ───────────────────────────────────────────────────────

const methodNames = Object.keys(MethodParams) as MethodName[];

/** Any message a client may send. */
export const ClientMessageSchema = z.union(
  methodNames.map((method) =>
    z.object({
      jsonrpc: z.literal("2.0"),
      id: RequestId.optional(),
      method: z.literal(method),
      params: MethodParams[method].optional(),
    }),
  ) as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]],
);

/** Any message the server sends. */
export const ServerMessageSchema = z.union([
  Envelopes.result,
  Envelopes.error,
  z.object({
    jsonrpc: z.literal("2.0"),
    method: z.literal("session/event"),
    params: NotificationParams["session/event"],
  }),
  z.object({ jsonrpc: z.literal("2.0"), method: z.literal("runtime/log"), params: NotificationParams["runtime/log"] }),
]);

/** The published JSON Schema document (docs/rpc-protocol.schema.json). */
export function buildRpcJsonSchema(): Record<string, unknown> {
  const document = z.toJSONSchema(
    z.object({
      ClientMessage: ClientMessageSchema,
      ServerMessage: ServerMessageSchema,
      results: z.object(MethodResults),
    }),
    { target: "draft-2020-12", unrepresentable: "any", io: "input" },
  ) as Record<string, unknown>;
  return {
    $schema: document.$schema,
    title: `Easy Agent RPC protocol v${RPC_PROTOCOL_VERSION}`,
    description:
      "JSON-RPC 2.0 messages exchanged over stdio by `eagent --rpc`, one per line. " +
      "Validate a client message against #/properties/ClientMessage and a server message against " +
      "#/properties/ServerMessage. #/properties/results lists the result of each method.",
    ...Object.fromEntries(Object.entries(document).filter(([key]) => key !== "$schema")),
  };
}
