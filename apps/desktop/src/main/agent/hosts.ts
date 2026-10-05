import { app, BrowserWindow } from "electron";
import { AGENT_METHODS, type AgentMethod, type CallOutcome, type HostStatus, type ParamsOf, type ResultOf } from "../../shared/agent";
import { IPC } from "../../shared/contract";
import type { WorkspaceStore } from "../services/workspaces";
import { AgentHost } from "./host";
import { RpcError } from "./rpc";
import { bundledAgentScript } from "./runtime";

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

/** One Agent process per workspace, started on first use and stopped when the app quits. */
export class HostManager {
  readonly #hosts = new Map<string, AgentHost>();
  readonly #workspaces: WorkspaceStore;

  constructor(workspaces: WorkspaceStore) {
    this.#workspaces = workspaces;
  }

  async start(workspaceId: string): Promise<HostStatus> {
    let host: AgentHost;
    try {
      host = this.#host(workspaceId);
    } catch (error) {
      // No eagent build to run, or the workspace is gone.
      return { state: "crashed", message: error instanceof Error ? error.message : String(error), restarting: false };
    }
    await host.start().catch(() => {});
    return host.status;
  }

  async restart(workspaceId: string, trust: "persisted" | "session"): Promise<HostStatus> {
    const host = this.#host(workspaceId);
    await host.restart(trust).catch(() => {});
    return host.status;
  }

  call<M extends AgentMethod>(workspaceId: string, method: M, params: ParamsOf<M>): Promise<CallOutcome<ResultOf<M>>> {
    return outcome(async () => {
      // Only session methods are open to the renderer; the host owns initialize and shutdown.
      if (!(AGENT_METHODS as readonly string[]).includes(method)) throw new RpcError({ code: -32601, message: `Method not allowed: ${method}` });
      return this.#existing(workspaceId).call(method, params);
    });
  }

  snapshot(workspaceId: string, sessionId: string) {
    return outcome(() => this.#existing(workspaceId).snapshot(sessionId));
  }

  openSessions(workspaceId: string): string[] {
    return this.#hosts.get(workspaceId)?.openSessions() ?? [];
  }

  async stop(workspaceId: string): Promise<void> {
    const host = this.#hosts.get(workspaceId);
    this.#hosts.delete(workspaceId);
    await host?.stop();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#hosts.keys()].map((id) => this.stop(id)));
  }

  get running(): boolean {
    return [...this.#hosts.values()].some((host) => host.status.state !== "stopped");
  }

  #existing(workspaceId: string): AgentHost {
    const host = this.#hosts.get(workspaceId);
    if (!host) throw new RpcError({ code: 0, message: "这个工作区的 Agent 进程还没有启动" });
    return host;
  }

  #host(workspaceId: string): AgentHost {
    const existing = this.#hosts.get(workspaceId);
    if (existing) return existing;
    const workspace = this.#workspaces.find(workspaceId);
    if (!workspace) throw new Error(`Unknown workspace ${workspaceId}`);
    const host = new AgentHost({
      cwd: workspace.path,
      script: bundledAgentScript(),
      clientVersion: app.getVersion(),
      autoRestart: true,
      onStatus: (status) => broadcast(IPC.agentStatus, workspaceId, status),
      onEvent: (event) => broadcast(IPC.agentEvent, { workspaceId, event }),
      onLog: (level, message) => broadcast(IPC.agentLog, { workspaceId, level, message }),
    });
    this.#hosts.set(workspaceId, host);
    return host;
  }
}
