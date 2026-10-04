/**
 * In-process active-team registry.
 *
 * A single object that encodes "this Easy Agent process is currently
 * leading team X". The constraint of one team per process is intentional
 * (TeamCreate refuses while a teamContext is set).
 *
 * The team metadata itself lives on disk (TeamFile, see
 * utils/teamHelpers.ts). This module is the in-memory cache that lets
 * tools — SendMessage, AgentTool, the QueryEngine inbox poller —
 * answer "what team am I in?" without a disk read per call.
 *
 * Why a module-level singleton:
 *   The team lead IS the main session. Wiring this through app state
 *   would force every tool to thread state through ToolContext, which is
 *   deliberately kept small. A module-level Map matches the shape we use
 *   for asyncAgentStore / todoStore / etc.
 *
 * Ownership:
 *   The team belongs to the session scope that created it (see
 *   sessionScope.ts). Other sessions in the same process see no active team
 *   and cannot create one until the owner disbands it, so mailbox draining
 *   and team tools never act on another session's team.
 */

import { touchTeamHeartbeat } from "../utils/teamHelpers.js";
import { currentSessionScope } from "./sessionScope.js";

export interface TeamContext {
  /** Same as TeamFile.name — the canonical team name. */
  teamName: string;
  /** Lead's deterministic agentId (`<TEAM_LEAD_NAME>@<teamName>`). */
  leadAgentId: string;
  /** Absolute path to `team.json` — handy for status logs. */
  teamFilePath: string;
  /** ms since epoch when the team was created. */
  createdAt: number;
}

let current: TeamContext | null = null;
let ownerScopeId: string | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

type Listener = (ctx: TeamContext | null) => void;
const listeners = new Set<Listener>();

function notify(): void {
  for (const l of listeners) {
    try {
      l(current);
    } catch {
      // Never let a UI subscriber break a state transition.
    }
  }
}

/**
 * Set the active team. Returns the previous context (if any) so a
 * future TeamUpdate can detect "team replaced" cleanly. Throws when a
 * team is already active — TeamCreate enforces the "one team per
 * process" rule by checking with `getActiveTeam()` first; this throw
 * is the defense-in-depth backup.
 */
export function setActiveTeam(ctx: TeamContext): void {
  const scopeId = currentSessionScope().id;
  if (current !== null && ownerScopeId !== scopeId) {
    throw new Error(`Another session in this process is leading team "${current.teamName}".`);
  }
  if (current !== null && current.teamName !== ctx.teamName) {
    throw new Error(`Already in team "${current.teamName}". Run TeamDelete before creating a new team.`);
  }
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  current = ctx;
  ownerScopeId = scopeId;
  heartbeatTimer = setInterval(() => {
    if (current?.teamName === ctx.teamName) void touchTeamHeartbeat(ctx.teamName).catch(() => {});
  }, 30_000);
  heartbeatTimer.unref();
  notify();
}

/** Disband the active team. A no-op for sessions that do not own it. */
export function clearActiveTeam(): void {
  if (current === null || ownerScopeId !== currentSessionScope().id) return;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  current = null;
  ownerScopeId = null;
  notify();
}

/** The team led by the current session scope, if any. */
export function getActiveTeam(): TeamContext | null {
  return current !== null && ownerScopeId === currentSessionScope().id ? current : null;
}

export function isInActiveTeam(): boolean {
  return getActiveTeam() !== null;
}

export function subscribeActiveTeam(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
