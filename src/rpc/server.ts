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
import { JsonRpcError as RpcError, JsonRpcPeer } from "../jsonrpc/peer.js";
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

export { RpcError };

type Handler = (params: never) => Promise<unknown>;

export class RpcServer {
  readonly #options: RpcServerOptions;
  #runtime: AgentRuntime | null = null;
  /** Settles when a running `initialize` finishes; later requests wait for it. */
  #initializing: Promise<unknown> | null = null;
  #interactions: InteractionKind[] | undefined;
  /** Sessions this connection opened, by id. A `/resume` switch adds the new id. */
  readonly #sessions = new Map<string, AgentSession>();
  readonly #peer: JsonRpcPeer;

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
    "session/send": async ({ sessionId, input, queue, images }) => {
      const session = this.#session(sessionId);
      const options = images ? { images } : {};
      if (!queue) return session.send(input, options);
      for (;;) {
        await session.waitForIdle();
        try {
          return await session.send(input, options);
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
    "session/setPermissionMode": async ({ sessionId, mode }) => {
      this.#session(sessionId).setPermissionMode(mode);
      return {};
    },
    "session/setModel": async ({ sessionId, model }) => {
      this.#session(sessionId).setModel(model);
      return {};
    },
    "session/setThinking": async ({ sessionId, thinking }) => {
      this.#session(sessionId).setThinking(thinking);
      return {};
    },
    "session/setEffort": async ({ sessionId, effort }) => {
      this.#session(sessionId).setEffort(effort);
      return {};
    },
    "session/stopBackgroundAgent": async ({ sessionId, agentId }) => ({
      stopped: this.#session(sessionId).stopBackgroundAgent(agentId),
    }),
    "session/close": async ({ sessionId }) => {
      await this.#session(sessionId).close();
      this.#forgetClosedSessions();
      return {};
    },
    shutdown: async () => {
      // Runs after the response below is written.
      setImmediate(() => this.#options.onShutdown());
      return {};
    },
  };

  constructor(options: RpcServerOptions) {
    this.#options = options;
    this.#peer = new JsonRpcPeer({
      send: options.send,
      handleRequest: (method, params) => this.#dispatch(method, params),
      mapError: toRpcError,
      logError: options.logError,
    });
  }

  /** Handle one line from the client. Never throws; every failure becomes a response or a log line. */
  receive(line: string): Promise<void> {
    return this.#peer.receive(line);
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
    this.#peer.notify(method, params);
  }
}

function toRpcError(error: unknown): RpcError | undefined {
  if (error instanceof AgentSdkError) return new RpcError(RpcErrorCode.AgentError, error.message, { code: error.code });
  // The SDK throws TypeError for a response that does not answer the request's kind.
  if (error instanceof TypeError) return new RpcError(RpcErrorCode.InvalidParams, error.message);
  return undefined;
}
