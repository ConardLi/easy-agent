/**
 * RPC server: the session SDK behind a JSON-RPC 2.0 connection.
 *
 * Every method maps onto one `AgentRuntime` or `AgentSession` call; the server
 * keeps no conversation state of its own beyond which sessions this
 * connection opened. Session events are forwarded as they are, so the RPC
 * layer cannot drift from the in-process SDK.
 *
 * The workspace bootstrap runs on `initialize`, not at startup, so a client
 * can choose the trust mode and learn about ignored project configuration
 * before anything from the workspace executes.
 */

import type { z } from "zod";
import {
  AgentSdkError,
  INTERACTIVE_DEFAULT_MAX_TURNS,
  SESSION_PROTOCOL_VERSION,
  type AgentRuntime,
  type AgentRuntimeOptions,
  type AgentSession,
  type InteractionKind,
  type InteractionResponse,
  type SessionEvent,
} from "../sdk/index.js";
import {
  type MethodName,
  MethodParams,
  type ParamsOf,
  RPC_PROTOCOL_VERSION,
  RpcErrorCode,
  SUPPORTED_RPC_PROTOCOL_VERSIONS,
} from "./protocol.js";

export interface RpcServerOptions {
  cwd: string;
  pluginDirs: readonly string[];
  version: string;
  /** Sends one serialized message to the client. */
  send(line: string): void;
  /** Called after `shutdown` was answered; the host should exit. */
  onShutdown(): void;
  /** Creates the workspace runtime; injectable for tests of the protocol layer. */
  createRuntime(options: AgentRuntimeOptions): Promise<AgentRuntime>;
  /** Diagnostics that must not go to the protocol stream. */
  logError(message: string): void;
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

type RequestId = string | number;
type Handler = (params: never) => Promise<unknown>;

export class RpcServer {
  readonly #options: RpcServerOptions;
  #runtime: AgentRuntime | null = null;
  /** Settles when a running `initialize` finishes; later requests wait for it. */
  #initializing: Promise<unknown> | null = null;
  #interactions: InteractionKind[] | undefined;
  /** Sessions this connection opened, by id. A `/resume` switch adds the new id. */
  readonly #sessions = new Map<string, AgentSession>();
  #shuttingDown = false;

  readonly #handlers: { [M in MethodName]: (params: ParamsOf<M>) => Promise<unknown> } = {
    initialize: (params) => this.#initialize(params),
    "runtime/capabilities": async () => this.#requireRuntime().getCapabilities(),
    "session/create": async ({ persist, ...open }) =>
      this.#attach(
        await this.#requireRuntime().createSession({
          ...this.#sessionOptions(open),
          ...(persist === false ? { persist } : {}),
        }),
      ),
    "session/resume": async ({ sessionId, ...open }) =>
      this.#attach(await this.#requireRuntime().resumeSession(sessionId, this.#sessionOptions(open))),
    "session/list": async ({ limit }) => ({ sessions: await this.#requireRuntime().listSessions(limit) }),
    "session/read": async ({ sessionId }) => this.#requireRuntime().readSession(sessionId),
    "session/rename": async ({ sessionId, title }) => ({
      session: await this.#requireRuntime().renameSession(sessionId, title),
    }),
    "session/delete": async ({ sessionId }) => {
      await this.#requireRuntime().deleteSession(sessionId);
      return {};
    },
    "session/fork": async ({ sessionId, title }) => ({
      session: await this.#requireRuntime().forkSession(sessionId, title !== undefined ? { title } : {}),
    }),
    "session/send": async ({ sessionId, input, queue }) => {
      const session = this.#session(sessionId);
      if (!queue) return session.send(input);
      for (;;) {
        await session.waitForIdle();
        try {
          return await session.send(input);
        } catch (error) {
          // Lost a race with a turn the session started on its own; wait again.
          if (!(error instanceof AgentSdkError && error.code === "busy")) throw error;
        }
      }
    },
    "session/command": async ({ sessionId, name, args }) => this.#session(sessionId).runCommand(name, args ?? []),
    "session/respond": async ({ sessionId, requestId, response }) => ({
      outcome: this.#session(sessionId).respond(requestId, response as InteractionResponse),
    }),
    "session/interrupt": async ({ sessionId }) => ({ outcome: this.#session(sessionId).interrupt() }),
    "session/state": async ({ sessionId }) => this.#session(sessionId).getState(),
    "session/shell": async ({ sessionId, command }) => this.#session(sessionId).runShell(command),
    "session/close": async ({ sessionId }) => {
      await this.#session(sessionId).close();
      this.#forgetClosedSessions();
      return {};
    },
    shutdown: async () => {
      this.#shuttingDown = true;
      return {};
    },
  };

  constructor(options: RpcServerOptions) {
    this.#options = options;
  }

  /** Handle one line from the client. Never throws; every failure becomes a response or a log line. */
  async receive(line: string): Promise<void> {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.#reply(null, { error: new RpcError(RpcErrorCode.ParseError, "Parse error: the line is not valid JSON.") });
      return;
    }
    if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      const id = isObject(message) && isRequestId(message.id) ? message.id : null;
      // A response from the client: the server sends no requests, so there is nothing to match.
      if (isObject(message) && ("result" in message || "error" in message) && !("method" in message)) return;
      this.#reply(id, {
        error: new RpcError(RpcErrorCode.InvalidRequest, "Invalid request: expected a JSON-RPC 2.0 request."),
      });
      return;
    }
    const hasId = "id" in message;
    if (hasId && !isRequestId(message.id)) {
      this.#reply(null, {
        error: new RpcError(RpcErrorCode.InvalidRequest, "Invalid request: id must be a string or number."),
      });
      return;
    }
    const id = hasId ? (message.id as RequestId) : undefined;
    try {
      const result = await this.#dispatch(message.method, message.params);
      if (id !== undefined) this.#reply(id, { result });
    } catch (error) {
      const rpcError = toRpcError(error);
      if (id !== undefined) this.#reply(id, { error: rpcError });
      else this.#options.logError(`[easy-agent] rpc notification ${message.method} failed: ${rpcError.message}`);
      if (rpcError.code === RpcErrorCode.InternalError) {
        this.#options.logError(`[easy-agent] rpc ${message.method}: ${(error as Error)?.stack ?? String(error)}`);
      }
    }
    if (this.#shuttingDown && message.method === "shutdown") this.#options.onShutdown();
  }

  /** Close every session and the runtime, after a running initialize settles. */
  async dispose(): Promise<void> {
    await this.#initializing?.catch(() => {});
    await this.#runtime?.dispose();
    this.#sessions.clear();
  }

  async #dispatch(method: string, params: unknown): Promise<unknown> {
    if (!Object.hasOwn(this.#handlers, method)) {
      throw new RpcError(RpcErrorCode.MethodNotFound, `Method not found: ${method}`);
    }
    const name = method as MethodName;
    // Clients may pipeline requests behind initialize; they run once it settles.
    if (name !== "initialize" && this.#initializing) await this.#initializing.catch(() => {});
    if (name !== "initialize" && !this.#runtime) {
      throw new RpcError(RpcErrorCode.NotInitialized, "Call initialize first.");
    }
    const schema: z.ZodType = MethodParams[name];
    const parsed = schema.safeParse(params ?? {});
    if (!parsed.success) {
      throw new RpcError(
        RpcErrorCode.InvalidParams,
        `Invalid params for ${name}: ${parsed.error.issues[0]?.message ?? "invalid"}`,
        {
          issues: parsed.error.issues.map(({ path, message }) => ({ path, message })),
        },
      );
    }
    return (this.#handlers[name] as Handler)(parsed.data as never);
  }

  #initialize(params: ParamsOf<"initialize">): Promise<unknown> {
    if (this.#runtime || this.#initializing) {
      return Promise.reject(new RpcError(RpcErrorCode.AlreadyInitialized, "initialize was already called."));
    }
    const running = this.#bootstrap(params);
    this.#initializing = running;
    return running.finally(() => {
      this.#initializing = null;
    });
  }

  async #bootstrap(params: ParamsOf<"initialize">): Promise<unknown> {
    if (!SUPPORTED_RPC_PROTOCOL_VERSIONS.includes(params.protocolVersion)) {
      throw new RpcError(
        RpcErrorCode.UnsupportedProtocolVersion,
        `Protocol version ${params.protocolVersion} is not supported.`,
        { supported: SUPPORTED_RPC_PROTOCOL_VERSIONS },
      );
    }
    const runtime = await this.#options.createRuntime({
      cwd: this.#options.cwd,
      pluginDirs: this.#options.pluginDirs,
      hardenPrivateData: false,
      services: false,
      ...(params.trust ? { trust: params.trust } : {}),
      logger: {
        warn: (message) => this.#log("warn", message),
        error: (message) => this.#log("error", message),
      },
    });
    this.#runtime = runtime;
    this.#interactions = params.interactions;
    await runtime.startServices({ mcpServers: true, wait: params.services === "wait" });
    return {
      protocolVersion: RPC_PROTOCOL_VERSION,
      sessionProtocolVersion: SESSION_PROTOCOL_VERSION,
      serverInfo: { name: "eagent", version: this.#options.version },
      workspace: { cwd: runtime.cwd, ...runtime.report },
      capabilities: runtime.getCapabilities(),
    };
  }

  #sessionOptions(open: { model?: string; permissionMode?: "default" | "plan" | "auto" }) {
    return {
      ...(open.model ? { model: open.model } : {}),
      ...(open.permissionMode ? { permissionMode: open.permissionMode } : {}),
      ...(this.#interactions ? { interactions: this.#interactions } : {}),
      // A long-running client is interactive, so it gets the terminal's tool-turn budget.
      defaultMaxTurns: INTERACTIVE_DEFAULT_MAX_TURNS,
    };
  }

  /** Forward the session's events and return its id and current state. */
  #attach(session: AgentSession): { sessionId: string; state: unknown } {
    this.#sessions.set(session.id, session);
    session.subscribe((event: SessionEvent) => {
      if (event.type === "session_replaced") {
        const successor = this.#runtime?.getSession(event.sessionId);
        if (successor) this.#sessions.set(successor.id, successor);
      }
      this.#notify("session/event", event);
    });
    return { sessionId: session.id, state: session.getState() };
  }

  #session(sessionId: string): AgentSession {
    const session = this.#sessions.get(sessionId);
    if (!session || session.closed) {
      throw new RpcError(RpcErrorCode.SessionNotFound, `No open session ${sessionId} on this connection.`, {
        sessionId,
      });
    }
    if (session.replacedBy !== null) {
      throw new RpcError(RpcErrorCode.AgentError, `Session ${sessionId} was replaced by ${session.replacedBy}.`, {
        code: "replaced",
        replacedBy: session.replacedBy,
      });
    }
    return session;
  }

  #forgetClosedSessions(): void {
    for (const [id, session] of this.#sessions) if (session.closed) this.#sessions.delete(id);
  }

  #requireRuntime(): AgentRuntime {
    if (!this.#runtime) throw new RpcError(RpcErrorCode.NotInitialized, "Call initialize first.");
    return this.#runtime;
  }

  #log(level: "warn" | "error", message: string): void {
    this.#options.logError(message);
    this.#notify("runtime/log", { level, message });
  }

  #notify(method: string, params: unknown): void {
    this.#options.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  #reply(id: RequestId | null, outcome: { result: unknown } | { error: RpcError }): void {
    const body =
      "result" in outcome
        ? { result: outcome.result ?? {} }
        : {
            error: {
              code: outcome.error.code,
              message: outcome.error.message,
              ...(outcome.error.data !== undefined ? { data: outcome.error.data } : {}),
            },
          };
    this.#options.send(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
  }
}

function toRpcError(error: unknown): RpcError {
  if (error instanceof RpcError) return error;
  if (error instanceof AgentSdkError) return new RpcError(RpcErrorCode.AgentError, error.message, { code: error.code });
  // The SDK throws TypeError for a response that does not answer the request's kind.
  if (error instanceof TypeError) return new RpcError(RpcErrorCode.InvalidParams, error.message);
  return new RpcError(RpcErrorCode.InternalError, error instanceof Error ? error.message : String(error));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}
