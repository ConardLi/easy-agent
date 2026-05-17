/**
 * In-process active-team registry (stage 21).
 *
 * Mirrors source's `AppState.teamContext` slice — a single object that
 * encodes "this Easy Agent process is currently leading team X". The
 * constraint of one team per process is intentional and source-aligned
 * (TeamCreate refuses while a teamContext is set).
 *
 * The team metadata itself lives on disk (TeamFile, see
 * utils/teamHelpers.ts). This module is the in-memory cache that lets
 * tools — SendMessage, AgentTool, the QueryEngine inbox poller —
 * answer "what team am I in?" without a disk read per call.
 *
 * Why a module-level singleton:
 *   The team lead IS the main session. Wiring this through AppState
 *   would force every tool to thread state through ToolContext (which
 *   stage 8 deliberately kept small). A module-level Map mirrors the
 *   shape we use for asyncAgentStore / todoStore / etc.
 */

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
  if (current !== null && current.teamName !== ctx.teamName) {
    throw new Error(
      `Already in team "${current.teamName}". Run TeamDelete before creating a new team.`,
    );
  }
  current = ctx;
  notify();
}

/** Clear the active team. Called by TeamDelete and by /clear. */
export function clearActiveTeam(): void {
  if (current === null) return;
  current = null;
  notify();
}

/** Current team context, or null when no team is active. */
export function getActiveTeam(): TeamContext | null {
  return current;
}

/**
 * Cheap "are we in a team right now?" check that doesn't expose the
 * underlying mutable reference. Used by promptInjection.ts to decide
 * whether to add the team-coordination guidance block.
 */
export function isInActiveTeam(): boolean {
  return current !== null;
}

/** Subscribe to team-context changes. Returns an unsubscribe handle. */
export function subscribeActiveTeam(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
