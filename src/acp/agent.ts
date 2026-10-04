/**
 * Easy Agent as an Agent Client Protocol (v1) agent.
 *
 * An editor starts `eagent --acp` and talks JSON-RPC over stdio. Each ACP
 * session is one SDK session: prompts become turns, session events become
 * `session/update` notifications, and the SDK's interaction requests become
 * `session/request_permission` (and, for clients that support forms,
 * `elicitation/create`) requests to the editor. Permission rules, workspace
 * trust, and the sandbox are the SDK's; this layer only translates.
 *
 * The process serves one workspace. The runtime is created for the `cwd` of
 * the first session; a later session for another directory is accepted only
 * once no session of the current one is open.
 */

import { realpath } from "node:fs/promises";
import * as path from "node:path";
import type { z } from "zod";
import { JsonRpcError, JsonRpcErrorCode, JsonRpcPeer } from "../jsonrpc/peer.js";
import {
  AgentSdkError,
  type AgentRuntime,
  type AgentRuntimeOptions,
  type AgentSession,
  INTERACTIVE_DEFAULT_MAX_TURNS,
  type InteractionKind,
  type InteractionRequest,
  type PermissionMode,
  type SessionEvent,
  type TurnResult,
} from "../sdk/index.js";
import { ACP_PROTOCOL_VERSION, type AcpMethod, AcpErrorCode, AcpParams, type AcpParamsOf } from "./protocol.js";
import {
  availableCommands,
  type ContentBlock,
  describeToolCall,
  mcpServerConfigs,
  type McpServerSpec,
  modeState,
  type PermissionOutcome,
  PromptContentError,
  permissionOptions,
  promptToInput,
  permissionResponse,
  planApprovalOptions,
  questionForm,
  questionResponse,
  replayUpdates,
  SESSION_MODES,
  type SessionUpdate,
  stopReason,
  toolDiffs,
  toolKind,
  toolResultText,
  toolTitle,
} from "./translate.js";

export interface AcpAgentOptions {
  version: string;
  pluginDirs: readonly string[];
  /** `--trust-project-config`: trust whichever workspace the editor opens, for this process only. */
  trustWorkspace: boolean;
  send(line: string): void;
  logError(message: string): void;
  createRuntime(options: AgentRuntimeOptions): Promise<AgentRuntime>;
}

/** The terminal flow an editor runs when the agent has no credentials. */
export const LOGIN_AUTH_METHOD = {
  id: "eagent-login",
  name: "Set up an API key",
  description: "Opens a terminal to enter a model provider API key; it is saved to ~/.easy-agent/settings.json.",
  type: "terminal",
  args: ["--login"],
} as const;

const LIST_PAGE_SIZE = 50;

interface OpenSession {
  /** The id the editor knows; stays the same if `/resume` switches conversations. */
  readonly id: string;
  handle: AgentSession;
  readonly tools: Map<string, { name: string; running: boolean }>;
  /** Editor requests still waiting for an answer, by SDK interaction id. */
  readonly asking: Map<string, () => void>;
  lastError: string | null;
  /** A prompt is being handled; set from `session/prompt` until it answers. */
  prompting: boolean;
  /** `session/cancel` arrived before the prompt's turn started. */
  cancelRequested: boolean;
  unsubscribe(): void;
}

export class AcpAgent {
  readonly #options: AcpAgentOptions;
  readonly #peer: JsonRpcPeer;
  #runtime: AgentRuntime | null = null;
  #runtimePending: Promise<AgentRuntime> | null = null;
  readonly #sessions = new Map<string, OpenSession>();
  #client = { elicitationForm: false, terminalAuth: false };

  readonly #handlers: { [M in AcpMethod]: (params: AcpParamsOf<M>) => Promise<unknown> } = {
    initialize: async (params) => this.#initialize(params),
    authenticate: async () => {
      if (!(await this.#hasCredentials())) throw authRequired();
      return {};
    },
    "session/new": async ({ cwd, mcpServers }) => {
      const runtime = await this.#prepare(cwd, mcpServers);
      const session = await runtime.createSession(this.#sessionOptions());
      return { sessionId: this.#open(session).id, modes: modeState(session.getState().permissionMode) };
    },
    "session/load": async ({ sessionId, cwd, mcpServers }) => {
      const open = await this.#reopen(sessionId, cwd, mcpServers);
      for (const update of replayUpdates(open.handle.getState().messages)) this.#update(open, update);
      return { modes: modeState(open.handle.getState().permissionMode) };
    },
    "session/resume": async ({ sessionId, cwd, mcpServers }) => {
      const open = await this.#reopen(sessionId, cwd, mcpServers);
      return { modes: modeState(open.handle.getState().permissionMode) };
    },
    "session/close": async ({ sessionId }) => {
      await this.#close(this.#session(sessionId));
      return {};
    },
    "session/list": async ({ cwd, cursor }) => this.#list(cwd ?? undefined, cursor ?? undefined),
    "session/delete": async ({ sessionId }) => {
      const open = this.#sessions.get(sessionId);
      if (open) await this.#close(open);
      const runtime = await this.#ensureRuntime(this.#runtime?.cwd ?? process.cwd());
      try {
        await runtime.deleteSession(sessionId);
      } catch (error) {
        // Deleting a session that does not exist (any more) succeeds.
        if (!(error instanceof AgentSdkError && (error.code === "not_found" || error.code === "invalid_argument"))) {
          throw error;
        }
      }
      return {};
    },
    "session/prompt": async ({ sessionId, prompt }) => this.#prompt(this.#session(sessionId), prompt as ContentBlock[]),
    "session/set_mode": async ({ sessionId, modeId }) => {
      if (!SESSION_MODES.some((mode) => mode.id === modeId)) {
        throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, `Unknown mode: ${modeId}`);
      }
      this.#session(sessionId).handle.setPermissionMode(modeId as PermissionMode);
      return {};
    },
    "session/cancel": async ({ sessionId }) => {
      const open = this.#sessions.get(sessionId);
      if (open && open.handle.interrupt() === "idle" && open.prompting) open.cancelRequested = true;
      return {};
    },
  };

  constructor(options: AcpAgentOptions) {
    this.#options = options;
    this.#peer = new JsonRpcPeer({
      send: options.send,
      handleRequest: (method, params) => this.#dispatch(method, params),
      handleNotification: async (method, params) => {
        // `$/cancel_request` and unknown notifications are ignored; a prompt is cancelled with session/cancel.
        if (method === "session/cancel") await this.#dispatch(method, params);
      },
      mapError,
      logError: options.logError,
    });
  }

  receive(line: string): Promise<void> {
    return this.#peer.receive(line);
  }

  async dispose(): Promise<void> {
    await this.#runtimePending?.catch(() => {});
    for (const open of this.#sessions.values()) open.unsubscribe();
    this.#sessions.clear();
    await this.#runtime?.dispose();
    this.#peer.rejectPending(new JsonRpcError(AcpErrorCode.RequestCancelled, "The agent is shutting down."));
  }

  async #dispatch(method: string, params: unknown): Promise<unknown> {
    if (!Object.hasOwn(this.#handlers, method)) {
      throw new JsonRpcError(JsonRpcErrorCode.MethodNotFound, `Method not found: ${method}`);
    }
    const name = method as AcpMethod;
    const schema: z.ZodType = AcpParams[name];
    const parsed = schema.safeParse(params ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new JsonRpcError(
        JsonRpcErrorCode.InvalidParams,
        `Invalid params for ${name}: ${issue ? `${issue.path.join(".") || "params"}: ${issue.message}` : "invalid"}`,
      );
    }
    return (this.#handlers[name] as (params: unknown) => Promise<unknown>)(parsed.data);
  }

  // ─── Connection ───────────────────────────────────────────────────────

  #initialize(params: AcpParamsOf<"initialize">) {
    const capabilities = params.clientCapabilities ?? {};
    this.#client = {
      elicitationForm: capabilities.elicitation?.form != null,
      // `_meta["terminal-auth"]` is how clients announced terminal login before `auth.terminal` existed.
      terminalAuth: capabilities.auth?.terminal === true || capabilities._meta?.["terminal-auth"] === true,
    };
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
        sessionCapabilities: { list: {}, delete: {}, resume: {}, close: {} },
      },
      agentInfo: { name: "eagent", title: "Easy Agent", version: this.#options.version },
      authMethods: this.#client.terminalAuth ? [{ ...LOGIN_AUTH_METHOD, args: [...LOGIN_AUTH_METHOD.args] }] : [],
    };
  }

  /** The runtime for `cwd`, created on first use. */
  async #ensureRuntime(cwd: string): Promise<AgentRuntime> {
    if (!path.isAbsolute(cwd)) throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, `cwd must be absolute: ${cwd}`);
    await this.#runtimePending?.catch(() => {});
    const target = await realpath(cwd).catch(() => {
      throw new JsonRpcError(AcpErrorCode.ResourceNotFound, `No such directory: ${cwd}`);
    });
    const current = this.#runtime;
    if (current && (await realpath(current.cwd).catch(() => current.cwd)) === target) return current;
    if (current) {
      if (this.#sessions.size > 0) {
        throw new JsonRpcError(
          JsonRpcErrorCode.InvalidParams,
          `This agent process serves ${current.cwd}; close its sessions before opening ${cwd}.`,
        );
      }
      this.#runtime = null;
      await current.dispose();
    }
    const starting = this.#startRuntime(target);
    this.#runtimePending = starting;
    try {
      this.#runtime = await starting;
      return this.#runtime;
    } finally {
      this.#runtimePending = null;
    }
  }

  async #startRuntime(cwd: string): Promise<AgentRuntime> {
    // Settings, `.env`, and tools resolve relative paths against the process directory.
    if (process.cwd() !== cwd) process.chdir(cwd);
    const runtime = await this.#options.createRuntime({
      cwd,
      pluginDirs: this.#options.pluginDirs,
      hardenPrivateData: false,
      services: false,
      ...(this.#options.trustWorkspace ? { trust: "session" as const } : {}),
      logger: { warn: this.#options.logError, error: this.#options.logError },
    });
    // ACP connects MCP servers before a session is ready, so their tools are there for the first prompt.
    await runtime.startServices({ mcpServers: true, wait: true });
    return runtime;
  }

  /** Runtime, credentials, and editor-provided MCP servers, before a session opens. */
  async #prepare(cwd: string, mcpServers: readonly McpServerSpec[]): Promise<AgentRuntime> {
    const runtime = await this.#ensureRuntime(cwd);
    if (!(await this.#hasCredentials())) throw authRequired();
    if (mcpServers.length > 0) {
      const { skipped } = await runtime.connectMcpServers(mcpServerConfigs(mcpServers));
      for (const name of skipped) {
        this.#options.logError(
          `[easy-agent] MCP server "${name}" from the editor is already configured; using the configured one.`,
        );
      }
    }
    return runtime;
  }

  async #hasCredentials(): Promise<boolean> {
    return this.#runtime ? this.#runtime.hasModelCredentials() : true;
  }

  // ─── Sessions ─────────────────────────────────────────────────────────

  #sessionOptions() {
    const interactions: InteractionKind[] = this.#client.elicitationForm
      ? ["permission", "plan_approval", "question"]
      : ["permission", "plan_approval"];
    return {
      interactions,
      defaultMaxTurns: INTERACTIVE_DEFAULT_MAX_TURNS,
      // A background agent's result is delivered with the next prompt instead of starting an unprompted turn.
      autoWake: false,
    };
  }

  async #reopen(sessionId: string, cwd: string, mcpServers: readonly McpServerSpec[]): Promise<OpenSession> {
    const existing = this.#sessions.get(sessionId);
    if (existing) return existing;
    const runtime = await this.#prepare(cwd, mcpServers);
    try {
      return this.#open(await runtime.resumeSession(sessionId, this.#sessionOptions()));
    } catch (error) {
      if (error instanceof AgentSdkError && (error.code === "not_found" || error.code === "invalid_argument")) {
        throw new JsonRpcError(AcpErrorCode.ResourceNotFound, `No saved session ${sessionId}.`);
      }
      throw error;
    }
  }

  #open(handle: AgentSession): OpenSession {
    const open: OpenSession = {
      id: handle.id,
      handle,
      tools: new Map(),
      asking: new Map(),
      lastError: null,
      prompting: false,
      cancelRequested: false,
      unsubscribe: () => {},
    };
    open.unsubscribe = handle.subscribe((event) => this.#onEvent(open, event));
    this.#sessions.set(open.id, open);
    const runtime = this.#runtime!;
    // Sent after the response that announces the session id.
    setImmediate(() => {
      if (this.#sessions.get(open.id) !== open) return;
      this.#update(open, {
        sessionUpdate: "available_commands_update",
        availableCommands: availableCommands(runtime.getCapabilities()),
      });
    });
    return open;
  }

  #session(sessionId: string): OpenSession {
    const open = this.#sessions.get(sessionId);
    if (!open) throw new JsonRpcError(AcpErrorCode.ResourceNotFound, `No open session ${sessionId}.`);
    return open;
  }

  async #close(open: OpenSession): Promise<void> {
    this.#sessions.delete(open.id);
    open.unsubscribe();
    for (const cancel of open.asking.values()) cancel();
    await open.handle.close();
  }

  async #list(cwd: string | undefined, cursor: string | undefined) {
    const runtime = await this.#listRuntime(cwd);
    if (!runtime) return { sessions: [] };
    let offset = 0;
    if (cursor) {
      offset = Number(Buffer.from(cursor, "base64url").toString("utf8"));
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, "Invalid cursor.");
    }
    const page = (await runtime.listSessions(offset + LIST_PAGE_SIZE + 1)).slice(offset);
    return {
      sessions: page.slice(0, LIST_PAGE_SIZE).map((summary) => ({
        sessionId: summary.sessionId,
        cwd: summary.cwd,
        title: summary.title ?? (summary.firstPrompt || null),
        updatedAt: summary.updatedAt,
      })),
      ...(page.length > LIST_PAGE_SIZE
        ? { nextCursor: Buffer.from(String(offset + LIST_PAGE_SIZE)).toString("base64url") }
        : {}),
    };
  }

  /** The runtime whose sessions a `session/list` for `cwd` covers; none when it is another workspace. */
  async #listRuntime(cwd: string | undefined): Promise<AgentRuntime | null> {
    if (!cwd) return this.#ensureRuntime(this.#runtime?.cwd ?? process.cwd());
    if (!path.isAbsolute(cwd)) throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, `cwd must be absolute: ${cwd}`);
    const target = await realpath(cwd).catch(() => null);
    if (!target) return null;
    const current = this.#runtime;
    if (current && (await realpath(current.cwd).catch(() => current.cwd)) !== target) return null;
    return this.#ensureRuntime(target);
  }

  // ─── Prompts ──────────────────────────────────────────────────────────

  async #prompt(open: OpenSession, prompt: ContentBlock[]) {
    let input: ReturnType<typeof promptToInput>;
    try {
      input = promptToInput(prompt);
    } catch (error) {
      if (error instanceof PromptContentError) throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, error.message);
      throw error;
    }
    open.lastError = null;
    open.prompting = true;
    open.cancelRequested = false;
    let result: TurnResult;
    try {
      for (;;) {
        await open.handle.waitForIdle();
        if (open.cancelRequested) return { stopReason: "cancelled" as const };
        try {
          result = await open.handle.send(input.text, { images: input.images });
          break;
        } catch (error) {
          // A local command or a previous prompt still runs; wait for it like a queued message.
          if (!(error instanceof AgentSdkError && error.code === "busy")) throw error;
        }
      }
    } finally {
      open.prompting = false;
    }
    const outcome = stopReason(result);
    if ("failed" in outcome) {
      throw new JsonRpcError(JsonRpcErrorCode.InternalError, open.lastError ?? "The model request failed.");
    }
    return outcome;
  }

  // ─── Events → session/update ──────────────────────────────────────────

  #update(open: OpenSession, update: SessionUpdate): void {
    this.#peer.notify("session/update", { sessionId: open.id, update });
  }

  #say(open: OpenSession, text: string): void {
    this.#update(open, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  }

  #onEvent(open: OpenSession, event: SessionEvent): void {
    switch (event.type) {
      case "text_delta":
        this.#say(open, event.text);
        return;
      case "thinking_delta":
        this.#update(open, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: event.thinking } });
        return;
      case "tool_started":
        open.tools.set(event.toolUseId, { name: event.name, running: false });
        this.#update(open, {
          sessionUpdate: "tool_call",
          toolCallId: event.toolUseId,
          title: toolTitle(event.name),
          kind: toolKind(event.name),
          status: "pending",
        });
        return;
      case "assistant_message": {
        const content = event.message.content;
        if (typeof content === "string") return;
        for (const block of content) {
          if (block.type !== "tool_use") continue;
          const input = (block.input ?? {}) as Record<string, unknown>;
          this.#update(open, {
            sessionUpdate: "tool_call_update",
            ...describeToolCall(block.id, block.name, input),
            content: toolDiffs(block.name, input),
          });
        }
        return;
      }
      case "tool_progress": {
        const tool = open.tools.get(event.toolUseId);
        if (!tool || tool.running) return;
        if (event.progress.kind === "status" && event.progress.status === "waiting-permission") return;
        tool.running = true;
        this.#update(open, { sessionUpdate: "tool_call_update", toolCallId: event.toolUseId, status: "in_progress" });
        return;
      }
      case "tool_completed": {
        open.tools.delete(event.toolUseId);
        const text = toolResultText(event.result.content);
        const diffs = event.result.isError ? [] : toolDiffs(event.name, event.input);
        this.#update(open, {
          sessionUpdate: "tool_call_update",
          toolCallId: event.toolUseId,
          status: event.result.isError ? "failed" : "completed",
          content: diffs.length > 0 ? diffs : text ? [{ type: "content", content: { type: "text", text } }] : [],
        });
        return;
      }
      case "request_opened":
        void this.#ask(open, event.request);
        return;
      case "request_resolved":
        open.asking.get(event.requestId)?.();
        return;
      case "mode_changed":
        this.#update(open, { sessionUpdate: "current_mode_update", currentModeId: event.mode });
        return;
      case "todos_changed":
        this.#update(open, {
          sessionUpdate: "plan",
          entries: event.todos.map((todo) => ({ content: todo.content, priority: "medium", status: todo.status })),
        });
        return;
      case "tasks_changed":
        this.#update(open, {
          sessionUpdate: "plan",
          entries: event.tasks.map((task) => ({ content: task.subject, priority: "medium", status: task.status })),
        });
        return;
      case "usage_changed":
        if (event.usage.context) {
          this.#update(open, {
            sessionUpdate: "usage_update",
            used: event.usage.context.tokens,
            size: event.usage.context.window,
          });
        }
        return;
      case "command_output":
        this.#say(open, `${event.message}\n`);
        return;
      case "command_view":
        this.#say(open, "This command opens a view the editor cannot show. Run it in the terminal with `eagent`.\n");
        return;
      case "editor_requested":
        this.#say(open, `Open ${event.filePath} in your editor to edit ${event.label}.\n`);
        return;
      case "error":
        open.lastError = event.message;
        return;
      case "session_replaced": {
        const successor = this.#runtime?.getSession(event.sessionId);
        if (successor) open.handle = successor;
        return;
      }
      default:
        return;
    }
  }

  // ─── Interaction requests → editor ────────────────────────────────────

  async #ask(open: OpenSession, request: InteractionRequest): Promise<void> {
    if (request.kind === "question") {
      const { id, response } = this.#peer.request("elicitation/create", {
        sessionId: open.id,
        mode: "form",
        ...questionForm(request),
      });
      open.asking.set(request.id, () => this.#peer.notify("$/cancel_request", { requestId: id }));
      const answer = await response.then(
        (result) => result as { action: string; content?: Record<string, unknown> | null },
        () => undefined,
      );
      open.asking.delete(request.id);
      open.handle.respond(request.id, questionResponse(request, answer));
      return;
    }

    const toolCallId = request.toolUseId ?? request.id;
    const toolCall =
      request.kind === "plan_approval"
        ? {
            toolCallId,
            title: "Ready to leave plan mode",
            kind: "switch_mode",
            status: "pending",
            rawInput: request.input,
            content: [{ type: "content", content: { type: "text", text: request.planContent ?? request.summary } }],
          }
        : {
            ...describeToolCall(toolCallId, request.toolName, request.input),
            title: toolTitle(request.toolName, request.input),
            status: "pending",
            content: toolDiffs(request.toolName, request.input),
          };
    const { id, response } = this.#peer.request("session/request_permission", {
      sessionId: open.id,
      toolCall,
      options: request.kind === "plan_approval" ? planApprovalOptions() : permissionOptions(request),
    });
    open.asking.set(request.id, () => this.#peer.notify("$/cancel_request", { requestId: id }));
    const outcome = await response.then(
      (result) => (result as { outcome?: PermissionOutcome }).outcome,
      () => undefined,
    );
    open.asking.delete(request.id);
    // The editor answers "cancelled" after session/cancel; end the turn rather than let the model continue.
    if (outcome?.outcome === "cancelled") open.handle.interrupt();
    else open.handle.respond(request.id, permissionResponse(request, outcome));
  }
}

function authRequired(): JsonRpcError {
  return new JsonRpcError(
    AcpErrorCode.AuthRequired,
    "Authentication required: no model API key is configured. Run `eagent --login`, or set ANTHROPIC_AUTH_TOKEN.",
  );
}

function mapError(error: unknown): JsonRpcError | undefined {
  if (error instanceof AgentSdkError) {
    const code = error.code === "not_found" ? AcpErrorCode.ResourceNotFound : JsonRpcErrorCode.InternalError;
    return new JsonRpcError(code, error.message, { code: error.code });
  }
  if (error instanceof TypeError) return new JsonRpcError(JsonRpcErrorCode.InvalidParams, error.message);
  return undefined;
}
