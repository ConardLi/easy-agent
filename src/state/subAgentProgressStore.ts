/**
 * Sub-agent progress store — global mailbox for live updates from
 * `AgentTool.call()` while a sub-agent is running.
 *
 * Why a store and not the agentic-loop event stream:
 *   The Agent tool runs INSIDE `runTools()` in agenticLoop.ts. While
 *   `await tool.call()` is blocked on the sub-agent's full execution,
 *   there's no path for the tool to yield events back into the parent
 *   loop's AsyncGenerator. Mirroring `todoStore` / `taskStore` (which
 *   already use this pattern for cross-cutting state updates) gives us
 *   a clean side-channel: the tool publishes, the UI subscribes.
 *
 *   Each entry carries what the SubAgentCard renders:
 *     - Agent type + description
 *     - Live tool-use count
 *     - Most recent tool name (so user sees "Read", "Grep", etc.)
 *     - Final stats (turns / tokens / duration) on completion
 *
 * Keying:
 *   Each sub-agent run is keyed by the parent's `tool_use.id`, set on
 *   ToolContext per call by `runTools()`. The UI matches store entries
 *   to ToolCallInfo by the same id — no name-based fallback (parallel
 *   Agent calls would collide).
 */

import type { LoopTerminationReason } from "../core/agenticLoop.js";
import { defineSessionState } from "./sessionScope.js";

export type SubAgentStatus = "running" | "completed" | "error" | "max_turns" | "aborted";

/** Live snapshot of one sub-agent's progress. */
export interface SubAgentProgress {
  /** AgentDefinition.agentType (e.g. "Explore", "general-purpose"). */
  agentType: string;
  /**
   * Teammate handle when this sub-agent was launched via
   * `Agent({ name, team_name, ... })`. Set the UI prefers this to
   * `agentType` because two teammates can share the same agentType
   * (e.g. both backend + frontend are `general-purpose`), and showing
   * "Agent[general-purpose]" twice loses the only information that
   * distinguishes them. Undefined for plain sub-agents.
   */
  teammateName?: string;
  /** Human-friendly task description from the model's input. */
  description?: string;
  /** Number of tool_use blocks the sub-agent has emitted so far. */
  toolUseCount: number;
  /** Most recent tool name observed (whatever the sub-agent called last). */
  lastToolName?: string;
  /** Whether the most recent tool call errored (resets on next call). */
  lastToolIsError?: boolean;
  /** Wall-clock start time (ms since epoch) — used to derive elapsed. */
  startTime: number;
  /** Updated only on completion. */
  durationMs?: number;
  /** Final loop termination reason — populated after the sub-agent ends. */
  reason?: LoopTerminationReason;
  /** Final aggregate token count (input + output). */
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** High-level lifecycle. UI uses this to pick spinner vs check vs cross. */
  status: SubAgentStatus;
}

type Listener = (toolUseId: string, snapshot: SubAgentProgress | null) => void;

/** Live sub-agent snapshots for this session scope's Agent tool calls. */
const subAgentProgressState = defineSessionState("subAgentProgress", () => ({
  store: new Map<string, SubAgentProgress>(),
  listeners: new Set<Listener>(),
}));

function notify(toolUseId: string, snapshot: SubAgentProgress | null): void {
  for (const l of subAgentProgressState().listeners) l(toolUseId, snapshot);
}

export function getSubAgentProgress(toolUseId: string): SubAgentProgress | undefined {
  return subAgentProgressState().store.get(toolUseId);
}

/**
 * Insert a fresh entry. Called once when AgentTool.call() starts so the
 * UI can render "Initializing…" immediately instead of waiting for the
 * first sub-agent tool_use_start event (which only fires after the LLM
 * round-trip — could be seconds of dead air on slow models).
 */
export function startSubAgentProgress(
  toolUseId: string,
  init: Pick<SubAgentProgress, "agentType" | "description" | "teammateName">,
): void {
  const snapshot: SubAgentProgress = {
    agentType: init.agentType,
    ...(init.teammateName ? { teammateName: init.teammateName } : {}),
    ...(init.description ? { description: init.description } : {}),
    toolUseCount: 0,
    startTime: Date.now(),
    status: "running",
  };
  subAgentProgressState().store.set(toolUseId, snapshot);
  notify(toolUseId, snapshot);
}

/**
 * Apply a partial update. Caller passes only the fields that changed —
 * the subAgentProgressState().store does the merge. Returns silently if the entry was never
 * started (defensive: shouldn't happen, but tests / hot reloads).
 */
export function updateSubAgentProgress(toolUseId: string, patch: Partial<Omit<SubAgentProgress, "startTime">>): void {
  const cur = subAgentProgressState().store.get(toolUseId);
  if (!cur) return;
  const next: SubAgentProgress = { ...cur, ...patch };
  subAgentProgressState().store.set(toolUseId, next);
  notify(toolUseId, next);
}

/**
 * Mark a sub-agent as finished and fold in the final stats. Once the
 * UI's tool-call card transitions out of the live ToolCallList (after
 * `tool_result_message` fires), the entry can be dropped — see
 * `clearSubAgentProgress`.
 */
export function completeSubAgentProgress(
  toolUseId: string,
  result: {
    reason: LoopTerminationReason;
    durationMs: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    toolUseCount: number;
    isError?: boolean;
  },
): void {
  const cur = subAgentProgressState().store.get(toolUseId);
  if (!cur) return;
  const status: SubAgentStatus = result.isError
    ? "error"
    : result.reason === "completed"
      ? "completed"
      : result.reason === "max_turns"
        ? "max_turns"
        : result.reason === "aborted"
          ? "aborted"
          : // model_error / blocking_limit both surface as "error" — the
            // user just needs to know the sub-agent didn't finish cleanly.
            "error";
  const next: SubAgentProgress = {
    ...cur,
    status,
    reason: result.reason,
    durationMs: result.durationMs,
    totalTokens: result.totalTokens,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    toolUseCount: result.toolUseCount,
  };
  subAgentProgressState().store.set(toolUseId, next);
  notify(toolUseId, next);
}

/** Drop one entry — UI calls this after the tool-call card archives. */
export function clearSubAgentProgress(toolUseId: string): void {
  if (!subAgentProgressState().store.has(toolUseId)) return;
  subAgentProgressState().store.delete(toolUseId);
  notify(toolUseId, null);
}

/** Drop everything — used by tests and `/clear`. */
export function clearAllSubAgentProgress(): void {
  const ids = [...subAgentProgressState().store.keys()];
  subAgentProgressState().store.clear();
  for (const id of ids) notify(id, null);
}

export function subscribeSubAgentProgress(listener: Listener): () => void {
  const { listeners } = subAgentProgressState();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Snapshot all entries — useful for tests + future debug commands. */
export function getAllSubAgentProgress(): Array<[string, SubAgentProgress]> {
  return [...subAgentProgressState().store.entries()];
}
