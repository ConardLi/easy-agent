import { app, BrowserWindow } from "electron";
import { AGENT_METHODS, type AgentMethod, type CallOutcome, type HostStatus, type OpenSessionInfo, type ParamsOf, type ResultOf } from "../../shared/agent";
import { IPC } from "../../shared/contract";
import type { PrefsStore } from "../services/prefs";
import type { SecretStore } from "../services/secrets";
import type { WorkspaceStore } from "../services/workspaces";
import { AgentHost } from "./host";
import { RpcError } from "./rpc";
import { launchCommand } from "./runtime";

const broadcast = (channel: string, ...args: unknown[]) => {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, ...args);
};

async function outcome<T>(run: () => Promise<T>): Promise<CallOutcome<T>> {
  try {
    return { ok: true, result: await run() };
  } catch (error) {
    if (error instanceof RpcError) return { ok: false, error: error.toInfo() };
    return { ok: false, error: { code: 0, message: error instanceof Error ? error.message : String(error) } };
  }
}

type Trust = "persisted" | "session";

/** A process for one workspace and one Agent; `agent` is null for the workspace's default Agent. */
interface HostEntry {
  workspaceId: string;
  agent: string | null;
  host: AgentHost;
}

const keyOf = (workspaceId: string, agent: string | null) => `${workspaceId}\u0000${agent ?? ""}`;

/** Methods that open a session; their `agent` param picks the process. */
const OPENING = new Set<AgentMethod>(["session/create", "session/resume"]);

/**
 * The Agent processes of every workspace. A workspace's default-Agent
 * process (started without an Agent, so it runs the workspace's default)
 * starts on first use; a process for another Agent starts when a session is
 * opened with that Agent. Calls about an open session go to the process
 * that has it open, everything else to the default-Agent process. All of
 * them stop when the app quits or the workspace is removed.
 */
export class HostManager {
  readonly #hosts = new Map<string, HostEntry>();
  readonly #workspaces: WorkspaceStore;
  readonly #prefs: PrefsStore;
  readonly #secrets: SecretStore;

  constructor(workspaces: WorkspaceStore, prefs: PrefsStore, secrets: SecretStore) {
    this.#workspaces = workspaces;
    this.#prefs = prefs;
    this.#secrets = secrets;
  }

  async start(workspaceId: string): Promise<HostStatus> {
    let host: AgentHost;
    try {
      host = this.#host(workspaceId, null);
    } catch (error) {
      // No eagent build to run, or the workspace is gone.
      return { state: "crashed", message: error instanceof Error ? error.message : String(error), restarting: false };
    }
    await host.start().catch(() => {});
    return host.status;
  }

  /**
   * Restart every process of the workspace with the trust mode; trust is
   * decided when a process initializes, and the other Agents' processes take
   * it from the default-Agent process.
   */
  async restart(workspaceId: string, trust: Trust): Promise<HostStatus> {
    const primary = this.#host(workspaceId, null);
    const others = this.#entries(workspaceId).filter((entry) => entry.agent !== null);
    await Promise.all([primary, ...others.map((entry) => entry.host)].map((host) => host.restart(trust).catch(() => {})));
    return primary.status;
  }

  /**
   * Restart the processes that run one of `agents` (the default-Agent process
   * included), reopening their sessions; other processes keep running.
   */
  async restartAgents(workspaceId: string, agents: readonly string[]): Promise<string[]> {
    const restarting = this.#entries(workspaceId).filter(({ host }) => {
      const status = host.status;
      return status.state === "ready" && agents.includes(status.harness.name);
    });
    await Promise.all(restarting.map(({ host }) => host.restart(host.trust).catch(() => {})));
    return restarting.map(({ host, agent }) => (host.status.state === "ready" ? host.status.harness.name : (agent ?? "")));
  }

  call<M extends AgentMethod>(workspaceId: string, method: M, params: ParamsOf<M>): Promise<CallOutcome<ResultOf<M>>> {
    return outcome(async () => {
      // Only session methods are open to the renderer; the host owns initialize and shutdown.
      if (!(AGENT_METHODS as readonly string[]).includes(method)) throw new RpcError({ code: -32601, message: `Method not allowed: ${method}` });
      if (OPENING.has(method)) {
        const { agent, ...rest } = params as ParamsOf<"session/create"> & { sessionId?: string };
        const sessionId = rest.sessionId;
        // Resuming a session that is already open goes to the process that has it.
        const owner = sessionId ? this.#owner(workspaceId, sessionId) : undefined;
        const host = owner ?? (await this.#hostForAgent(workspaceId, agent));
        return host.call(method, rest as ParamsOf<M>);
      }
      const sessionId = (params as { sessionId?: unknown }).sessionId;
      const owner = typeof sessionId === "string" ? this.#owner(workspaceId, sessionId) : undefined;
      return (owner ?? this.#existing(workspaceId)).call(method, params);
    });
  }

  snapshot(workspaceId: string, sessionId: string) {
    return outcome(() => (this.#owner(workspaceId, sessionId) ?? this.#existing(workspaceId)).snapshot(sessionId));
  }

  openSessions(workspaceId: string): OpenSessionInfo[] {
    return this.#entries(workspaceId).flatMap(({ host }) => {
      const status = host.status;
      return status.state === "ready" ? host.openSessions().map((sessionId) => ({ sessionId, agent: status.harness.name })) : [];
    });
  }

  async stop(workspaceId: string): Promise<void> {
    const entries = this.#entries(workspaceId);
    for (const entry of entries) this.#hosts.delete(keyOf(workspaceId, entry.agent));
    await Promise.all(entries.map((entry) => entry.host.stop()));
  }

  async stopAll(): Promise<void> {
    const ids = new Set([...this.#hosts.values()].map((entry) => entry.workspaceId));
    await Promise.all([...ids].map((id) => this.stop(id)));
  }

  get running(): boolean {
    return [...this.#hosts.values()].some(({ host }) => host.status.state !== "stopped");
  }

  #entries(workspaceId: string): HostEntry[] {
    return [...this.#hosts.values()].filter((entry) => entry.workspaceId === workspaceId);
  }

  #owner(workspaceId: string, sessionId: string): AgentHost | undefined {
    return this.#entries(workspaceId).find(({ host }) => host.openSessions().includes(sessionId))?.host;
  }

  #existing(workspaceId: string): AgentHost {
    const entry = this.#hosts.get(keyOf(workspaceId, null));
    if (!entry) throw new RpcError({ code: 0, message: "这个工作区的 Agent 进程还没有启动" });
    return entry.host;
  }

  /**
   * The process for a session that runs `agent`: the default-Agent process
   * when it runs that Agent (or none is named), otherwise one started for it.
   * A process whose Agent does not resolve is stopped and the call fails with
   * the reason.
   */
  async #hostForAgent(workspaceId: string, agent: string | undefined): Promise<AgentHost> {
    const primary = this.#existing(workspaceId);
    await primary.start().catch(() => {});
    const status = primary.status;
    if (!agent || (status.state === "ready" && status.harness.name === agent)) return primary;
    const host = this.#host(workspaceId, agent);
    try {
      await host.start(primary.trust);
    } catch (error) {
      this.#hosts.delete(keyOf(workspaceId, agent));
      await host.stop();
      throw new RpcError({ code: 0, message: `Agent「${agent}」的进程没能启动：${(error as Error).message}` });
    }
    return host;
  }

  #host(workspaceId: string, agent: string | null): AgentHost {
    const existing = this.#hosts.get(keyOf(workspaceId, agent));
    if (existing) return existing.host;
    const workspace = this.#workspaces.find(workspaceId);
    if (!workspace) throw new Error(`Unknown workspace ${workspaceId}`);
    const host = new AgentHost({
      cwd: workspace.path,
      ...(agent ? { harness: agent } : {}),
      launch: () => launchCommand(this.#prefs.get(), this.#secrets.env()),
      clientVersion: app.getVersion(),
      autoRestart: () => this.#prefs.get().autoRestart,
      onStatus: (status) => broadcast(IPC.agentStatus, workspaceId, status, agent),
      onEvent: (event) => broadcast(IPC.agentEvent, { workspaceId, event }),
      onLog: (level, message) => broadcast(IPC.agentLog, { workspaceId, level, message }),
    });
    this.#hosts.set(keyOf(workspaceId, agent), { workspaceId, agent, host });
    return host;
  }
}
