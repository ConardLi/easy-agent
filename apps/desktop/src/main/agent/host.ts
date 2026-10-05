import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { AgentMethod, HostStatus, InitializeResult, ParamsOf, ResultOf, SessionEvent, SessionState } from "../../shared/agent";
import { RPC_PROTOCOL_VERSION } from "../../shared/agent";
import { RpcClient, RpcError } from "./rpc";

export interface HostOptions {
  cwd: string;
  /** The `eagent` entry script, run with Electron's bundled Node. */
  script: string;
  clientVersion: string;
  autoRestart: boolean;
  onStatus(status: HostStatus): void;
  onEvent(event: SessionEvent): void;
  onLog(level: "warn" | "error", message: string): void;
}

type Trust = "persisted" | "session";

/** Give up restarting after this many crashes within the window. */
const CRASH_LIMIT = 3;
const CRASH_WINDOW_MS = 60_000;
const RESTART_DELAY_MS = 1000;
const SHUTDOWN_TIMEOUT_MS = 3000;

/**
 * One `eagent --rpc` process serving one workspace. It initializes the
 * process with the trust mode the user chose, forwards session events, keeps
 * track of the sessions it opened, and restarts a crashed process, reopening
 * those sessions.
 */
export class AgentHost {
  readonly #options: HostOptions;
  #status: HostStatus = { state: "stopped" };
  #child: ChildProcessWithoutNullStreams | null = null;
  #rpc: RpcClient | null = null;
  #ready: Promise<void> | null = null;
  #trust: Trust = "persisted";
  #stopping = false;
  #crashes: number[] = [];
  readonly #open = new Set<string>();
  /** Last event sequence per session, so a snapshot can say which events it already contains. */
  readonly #lastSeq = new Map<string, number>();

  constructor(options: HostOptions) {
    this.#options = options;
  }

  get status(): HostStatus {
    return this.#status;
  }

  openSessions(): string[] {
    return [...this.#open];
  }

  /** Start the process unless it is already running or starting. */
  start(trust?: Trust): Promise<void> {
    if (trust) this.#trust = trust;
    if (this.#ready && this.#status.state !== "crashed" && this.#status.state !== "stopped") return this.#ready;
    return this.#launch([]);
  }

  /** Restart with another trust mode; trust is decided when the workspace initializes. */
  async restart(trust: Trust): Promise<void> {
    const reopen = this.openSessions();
    await this.stop();
    this.#trust = trust;
    await this.#launch(reopen);
  }

  async call<M extends AgentMethod>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    const rpc = await this.#connection();
    const result = await rpc.request<ResultOf<M>>(method, params);
    if (method === "session/create" || method === "session/resume") this.#open.add((result as ResultOf<"session/create">).sessionId);
    if (method === "session/close") this.#open.delete((params as ParamsOf<"session/close">).sessionId);
    return result;
  }

  /**
   * The session state together with the sequence number of the last event
   * it includes. Events and responses share one ordered stream, so every
   * event sent before the response has been counted when it arrives.
   */
  async snapshot(sessionId: string): Promise<{ state: SessionState; seq: number }> {
    const state = await this.call("session/state", { sessionId });
    return { state, seq: this.#lastSeq.get(sessionId) ?? -1 };
  }

  async stop(): Promise<void> {
    const child = this.#child;
    const rpc = this.#rpc;
    if (!child || !rpc) return;
    this.#stopping = true;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const timeout = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
    await Promise.race([rpc.request("shutdown").catch(() => {}), timeout(SHUTDOWN_TIMEOUT_MS, undefined)]);
    if ((await Promise.race([exited.then(() => true), timeout(SHUTDOWN_TIMEOUT_MS, false)])) === false) child.kill("SIGKILL");
    await exited;
  }

  async #connection(): Promise<RpcClient> {
    if (!this.#ready) throw new RpcError({ code: 0, message: "Agent 进程没有启动" });
    await this.#ready;
    if (!this.#rpc) throw new RpcError({ code: 0, message: "Agent 进程已经退出" });
    return this.#rpc;
  }

  #setStatus(status: HostStatus): void {
    this.#status = status;
    this.#options.onStatus(status);
  }

  #launch(reopen: string[]): Promise<void> {
    this.#stopping = false;
    this.#open.clear();
    this.#lastSeq.clear();
    this.#setStatus({ state: "starting" });

    const { cwd, script } = this.#options;
    const child = spawn(process.execPath, [script, "--rpc"], { cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "pipe" });
    const rpc = new RpcClient(child.stdout, child.stdin, (method, params) => this.#notify(method, params));
    this.#child = child;
    this.#rpc = rpc;

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8000);
    });
    // A write after the process died must not take the main process down.
    child.stdin.on("error", () => {});
    let exited = false;
    const onExit = (detail: string) => {
      if (exited) return;
      exited = true;
      this.#onExit(child, detail, stderr);
    };
    child.once("exit", (code, signal) => onExit(signal ? `信号 ${signal}` : `退出码 ${code}`));
    child.once("error", (error) => onExit(error.message));

    const ready = (async () => {
      const trust = this.#trust;
      const init = await rpc.request<InitializeResult>("initialize", {
        protocolVersion: RPC_PROTOCOL_VERSION,
        clientInfo: { name: "easy-agent-desktop", version: this.#options.clientVersion },
        trust,
        interactions: ["permission", "plan_approval", "question"],
        services: "background",
      });
      // Reopen before reporting ready, straight on the connection: `call()` waits for this very promise.
      for (const sessionId of reopen) {
        try {
          await rpc.request("session/resume", { sessionId });
          this.#open.add(sessionId);
        } catch (error) {
          this.#options.onLog("warn", `会话 ${sessionId} 没能恢复：${(error as Error).message}`);
        }
      }
      this.#setStatus({ state: "ready", init, trust });
    })();
    this.#ready = ready;
    ready.catch(() => {});
    return ready;
  }

  #notify(method: string, params: unknown): void {
    if (method === "session/event") {
      const event = params as SessionEvent;
      this.#lastSeq.set(event.sessionId, event.seq);
      // `/resume <id>` moves an open session to another id; events from then on carry the new one.
      if (event.type === "session_replaced") this.#open.add(event.sessionId);
      this.#options.onEvent(event);
    } else if (method === "runtime/log") {
      const { level, message } = params as { level: "warn" | "error"; message: string };
      this.#options.onLog(level, message);
    }
  }

  #onExit(child: ChildProcessWithoutNullStreams, detail: string, stderr: string): void {
    if (child !== this.#child) return;
    this.#rpc?.close("Agent 进程已经退出");
    this.#child = null;
    this.#rpc = null;
    if (this.#stopping) {
      this.#setStatus({ state: "stopped" });
      return;
    }
    const reopen = this.openSessions();
    const now = Date.now();
    this.#crashes = [...this.#crashes.filter((at) => now - at < CRASH_WINDOW_MS), now];
    const lastLine = stderr.trim().split("\n").filter(Boolean).pop();
    const message = lastLine ? `${lastLine}（${detail}）` : `Agent 进程意外退出（${detail}）`;
    const restarting = this.#options.autoRestart && this.#crashes.length < CRASH_LIMIT;
    this.#setStatus({ state: "crashed", message, restarting });
    if (restarting) setTimeout(() => void this.#launch(reopen).catch(() => {}), RESTART_DELAY_MS);
  }
}
