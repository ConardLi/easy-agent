/**
 * Async sub-agent registry (stage 20).
 *
 * Holds the in-memory state of every background sub-agent the model has
 * launched in the current session. Mirrors the `tasks: { type:
 * 'local_agent', ... }` slice of source's AppState (LocalAgentTask.tsx)
 * but keeps only the fields the teaching version needs.
 *
 * Lifecycle:
 *
 *   register(agentId, init)
 *      ↓ status = "running", abortController fresh
 *   updateProgress(agentId, partial)         ← optional, called as the
 *      ↓                                       sub-agent emits events
 *   complete(agentId, result)  OR  fail(agentId, error)  OR  kill(agentId)
 *      ↓ status = "completed" / "failed" / "killed"
 *   (entry stays around so the UI / `/agents` listing can show
 *    historical runs; cleared by `clearAll()` on session reset.)
 *
 * Why a store instead of just spawning Promise.race junk inside
 * agentTool: the parent sub-agent loop must return synchronously after
 * registering. The store gives us a single source of truth that the
 * background lifecycle wrapper writes to and the QueryEngine /
 * notification queue / UI all read from.
 *
 * The parent's AbortController is intentionally NOT linked to the
 * background agent — pressing ESC on the main thread should stop the
 * model from talking, not interrupt a sub-agent that's already cooking.
 * The only way to stop a background agent is `kill(agentId)`.
 */

import type { AgentRunResult } from "../agents/types.js";

export type AsyncAgentStatus = "running" | "completed" | "failed" | "killed";

export interface AsyncAgentEntry {
  agentId: string;
  agentType: string;
  description?: string;
  prompt: string;
  /** ISO timestamp at register(). */
  startedAt: string;
  status: AsyncAgentStatus;

  /** Independent abort handle — caller can kill the sub-agent. */
  abortController: AbortController;

  /** Path to the `.output` JSONL file. */
  outputFile: string;

  /** True when launched with `isolation: "worktree"`. */
  isolated: boolean;
  /** Worktree info (path/branch) if the run created one. */
  worktreePath?: string;
  worktreeBranch?: string;

  // ─── Live progress (mutated as the sub-agent runs) ────────────────
  /** Number of completed tool_use blocks. */
  toolUseCount: number;
  /** Last tool name observed. */
  lastToolName?: string;
  /** Cumulative token totals from the most recent turn_usage event. */
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  turnCount?: number;

  // ─── Final fields, populated by complete()/fail()/kill() ──────────
  finalText?: string;
  error?: string;
  durationMs?: number;
  /** Loop termination reason (e.g. "completed", "max_turns", "model_error"). */
  reason?: string;
}

type Listener = (agentId: string, snapshot: AsyncAgentEntry | null) => void;

const entries = new Map<string, AsyncAgentEntry>();
const listeners = new Set<Listener>();

function notify(agentId: string, snapshot: AsyncAgentEntry | null): void {
  for (const l of listeners) l(agentId, snapshot);
}

export interface RegisterAsyncAgentInit {
  agentId: string;
  agentType: string;
  description?: string;
  prompt: string;
  outputFile: string;
  isolated?: boolean;
  worktreePath?: string;
  worktreeBranch?: string;
}

/**
 * Register a fresh background sub-agent. Returns the entry (caller usually
 * wants the AbortController so it can pass it into `runChildAgent`).
 *
 * Throws if the same agentId is already registered — agentIds are random
 * short strings, a collision means a programming bug we want to surface.
 */
export function registerAsyncAgent(init: RegisterAsyncAgentInit): AsyncAgentEntry {
  if (entries.has(init.agentId)) {
    throw new Error(`Async agent '${init.agentId}' is already registered.`);
  }
  const entry: AsyncAgentEntry = {
    agentId: init.agentId,
    agentType: init.agentType,
    ...(init.description ? { description: init.description } : {}),
    prompt: init.prompt,
    startedAt: new Date().toISOString(),
    status: "running",
    abortController: new AbortController(),
    outputFile: init.outputFile,
    isolated: init.isolated ?? false,
    ...(init.worktreePath ? { worktreePath: init.worktreePath } : {}),
    ...(init.worktreeBranch ? { worktreeBranch: init.worktreeBranch } : {}),
    toolUseCount: 0,
  };
  entries.set(entry.agentId, entry);
  notify(entry.agentId, entry);
  return entry;
}

/** Apply a partial update to one entry (live progress fields only). */
export function updateAsyncAgentProgress(
  agentId: string,
  patch: Partial<
    Pick<
      AsyncAgentEntry,
      | "toolUseCount"
      | "lastToolName"
      | "totalTokens"
      | "inputTokens"
      | "outputTokens"
      | "turnCount"
    >
  >,
): void {
  const cur = entries.get(agentId);
  if (!cur || cur.status !== "running") return;
  const next: AsyncAgentEntry = { ...cur, ...patch };
  entries.set(agentId, next);
  notify(agentId, next);
}

/** Mark as completed and fold in the final stats. */
export function completeAsyncAgent(
  agentId: string,
  result: AgentRunResult,
  extra?: { worktreePath?: string; worktreeBranch?: string },
): void {
  const cur = entries.get(agentId);
  if (!cur) return;
  const next: AsyncAgentEntry = {
    ...cur,
    status: "completed",
    finalText: result.finalText,
    durationMs: result.totalDurationMs,
    totalTokens: result.totalTokens,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    toolUseCount: result.totalToolUseCount,
    turnCount: result.turnCount,
    reason: result.reason,
    ...(extra?.worktreePath ? { worktreePath: extra.worktreePath } : {}),
    ...(extra?.worktreeBranch ? { worktreeBranch: extra.worktreeBranch } : {}),
  };
  entries.set(agentId, next);
  notify(agentId, next);
}

/** Mark as failed with an error message. */
export function failAsyncAgent(
  agentId: string,
  error: string,
  durationMs: number,
): void {
  const cur = entries.get(agentId);
  if (!cur) return;
  const next: AsyncAgentEntry = {
    ...cur,
    status: "failed",
    error,
    durationMs,
    reason: "model_error",
  };
  entries.set(agentId, next);
  notify(agentId, next);
}

/**
 * Abort a running async agent. Idempotent — second call is a no-op.
 * Returns true when the entry transitioned from `running` to `killed`.
 */
export function killAsyncAgent(agentId: string): boolean {
  const cur = entries.get(agentId);
  if (!cur || cur.status !== "running") return false;
  cur.abortController.abort();
  const next: AsyncAgentEntry = {
    ...cur,
    status: "killed",
    reason: "aborted",
  };
  entries.set(agentId, next);
  notify(agentId, next);
  return true;
}

export function getAsyncAgent(agentId: string): AsyncAgentEntry | undefined {
  return entries.get(agentId);
}

export function getAllAsyncAgents(): AsyncAgentEntry[] {
  return [...entries.values()];
}

/** Snapshot all RUNNING agents — used by the QueryEngine to list active background tasks. */
export function getRunningAsyncAgents(): AsyncAgentEntry[] {
  return [...entries.values()].filter((e) => e.status === "running");
}

export function subscribeAsyncAgents(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Drop everything — used by tests and `/clear`. */
export function clearAllAsyncAgents(): void {
  const ids = [...entries.keys()];
  entries.clear();
  for (const id of ids) notify(id, null);
}
