import type { AgentMethod, ParamsOf, ResultOf, RpcErrorInfo, SessionState } from "../../shared/agent";
import { desktop } from "../lib/desktop";

/** A failed Agent call: a JSON-RPC error, or `code` 0 when the process itself failed. */
export class AgentCallError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor({ code, message, data }: RpcErrorInfo) {
    super(message);
    this.code = code;
    this.data = data;
  }
  /** The SDK error code (`busy`, `not_found`, …) for `-32000` errors. */
  get sdkCode(): string | undefined {
    return (this.data as { code?: string } | undefined)?.code;
  }
}

/** Calls into a workspace's Agent process; results are unwrapped and failures thrown. */
export const agent = {
  async call<M extends AgentMethod>(workspaceId: string, method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    const outcome = await desktop.agent.call(workspaceId, method, params);
    if (!outcome.ok) throw new AgentCallError(outcome.error);
    return outcome.result;
  },
  async snapshot(workspaceId: string, sessionId: string): Promise<{ state: SessionState; seq: number }> {
    const outcome = await desktop.agent.snapshot(workspaceId, sessionId);
    if (!outcome.ok) throw new AgentCallError(outcome.error);
    return outcome.result;
  },
};

/** A message for the person, from any failure. */
export function describeError(error: unknown): string {
  if (error instanceof AgentCallError && error.sdkCode === "busy") return "Agent 正在处理上一条消息";
  return error instanceof Error ? error.message : String(error);
}
