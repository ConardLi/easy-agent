/**
 * Team metadata helpers (stage 21).
 *
 * Reference: claude-code-source-code/src/utils/swarm/teamHelpers.ts
 *
 * On-disk shape (mirrors source, minus tmux/iTerm2/pane fields):
 *
 *   ~/.easy-agent/teams/<sanitized-team-name>/
 *   ├── team.json              ← TeamFile (this file's read/write helpers)
 *   ├── inboxes/               ← TeammateMailbox lives here
 *   │   ├── <name>.json
 *   │   └── <name>.json.lock
 *   └── (worktree paths recorded inside TeamFile.members[].worktreePath)
 *
 * One team per process is the source-aligned constraint — `TeamCreate`
 * refuses to spawn a second team while one is active. That keeps the
 * mental model simple ("I'm leading exactly one team right now") and
 * spares us from cross-team routing logic in SendMessage.
 *
 * What this file does NOT do — and intentionally so:
 *   - tmux pane id / backendType tracking (source-only, no terminal mux here)
 *   - hidden pane registry, member mode broadcasting
 *   - cross-machine plan_approval / shutdown protocols
 *   - registerTeamForSessionCleanup (source uses it for SIGINT cleanup;
 *     we rely on the existing graceful-shutdown path + best-effort
 *     `cleanupTeamDirectories` from TeamDelete instead).
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getTeamsRoot } from "./paths.js";

/**
 * Snapshot of one team member. A "member" includes the team lead
 * (always `name === TEAM_LEAD_NAME`) plus any teammates the lead has
 * spawned via `Agent({ name, team_name, ... })`.
 *
 * Source's member record has ~15 fields (tmuxPaneId, backendType, mode,
 * subscriptions, hiddenPaneIds, ...). We keep only the ones the
 * teaching version needs to coordinate sends + cleanup.
 */
export interface TeamMember {
  /** Deterministic id: `<name>@<teamName>` (e.g. "backend@my-team"). */
  agentId: string;
  /** Human-friendly handle used by SendMessage as the `to` value. */
  name: string;
  /** Which agent definition backs this teammate (e.g. "general-purpose"). */
  agentType?: string;
  /** Optional model override the teammate is running under. */
  model?: string;
  /** ms since epoch when the member was added to the team. */
  joinedAt: number;
  /**
   * False once the teammate's loop terminates (completed/failed/killed).
   * The lead is always active while the session is alive. Used by
   * TeamDelete to refuse cleanup while real work is still happening,
   * and by SendMessage to warn the model that the recipient is offline.
   */
  isActive: boolean;
  /**
   * Path to the teammate's `.output` JSONL transcript. Populated for
   * non-lead members; the lead writes to the main session transcript
   * instead. Lets the lead Read a teammate's progress on demand.
   */
  outputFile?: string;
  /**
   * Worktree path the teammate is operating in, if `isolation:
   * "worktree"` was requested at spawn time. Recorded so TeamDelete can
   * `git worktree remove` it during cleanup.
   */
  worktreePath?: string;
  /** Branch name paired with `worktreePath`. */
  worktreeBranch?: string;
  /**
   * Repository root from which the worktree was created. Stored
   * alongside worktreePath because `removeAgentWorktree` runs `git`
   * inside the gitRoot (the worktree itself may already be gone by
   * the time TeamDelete runs).
   */
  gitRoot?: string;
}

export interface TeamFile {
  name: string;
  description?: string;
  /** ms since epoch when TeamCreate ran. */
  createdAt: number;
  /** agentId of the team lead — also the first entry in `members`. */
  leadAgentId: string;
  members: TeamMember[];
}

/**
 * The conventional "name" of the team lead in every team. Mirrors
 * source's `TEAM_LEAD_NAME` (claude-code-source-code/src/utils/swarm/
 * constants.ts:1). Hard-coded by convention so SendMessage can target
 * the lead from inside a teammate without knowing the lead's agentId.
 */
export const TEAM_LEAD_NAME = "team-lead";

/**
 * Filesystem-safe slug for a team name (used as the directory segment).
 * Source's `sanitizeName` (teamHelpers.ts:100) replaces any
 * non-alphanumeric with `-` and lowercases — same here so a team called
 * "My Team!" lands under `.../teams/my-team-/...`.
 *
 * Why so aggressive: TeammateMailbox tacks the team name onto a path
 * that's later passed to `lockfile.lock(...)`. Spaces / unicode / `..`
 * in that path are a portability + path-traversal risk we'd rather not
 * audit each time someone adds a new tool.
 */
export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
}

/** Format a deterministic agent id from a member name + team name. */
export function formatAgentId(name: string, teamName: string): string {
  return `${name}@${teamName}`;
}

/** Returns `~/.easy-agent/teams/<sanitized-team-name>`. */
export function getTeamDir(teamName: string): string {
  return join(getTeamsRoot(), sanitizeName(teamName));
}

/** Returns `<teamDir>/team.json`. */
export function getTeamFilePath(teamName: string): string {
  return join(getTeamDir(teamName), "team.json");
}

// ─── read / write (sync + async) ────────────────────────────────────
//
// Source ships both flavors because some render paths (`isTeamLead` in
// AppState selectors) run in synchronous React contexts. Easy Agent
// doesn't have those today, but we mirror the API surface so future
// readers cross-referencing source aren't surprised.

/** Sync read — returns null on ENOENT, swallows other parse errors as null. */
export function readTeamFile(teamName: string): TeamFile | null {
  try {
    const content = readFileSync(getTeamFilePath(teamName), "utf-8");
    return JSON.parse(content) as TeamFile;
  } catch {
    return null;
  }
}

/** Async read — same semantics as readTeamFile. */
export async function readTeamFileAsync(
  teamName: string,
): Promise<TeamFile | null> {
  try {
    const content = await readFile(getTeamFilePath(teamName), "utf-8");
    return JSON.parse(content) as TeamFile;
  } catch {
    return null;
  }
}

/** Sync write — primarily for member-list mutations from sync contexts. */
export function writeTeamFile(teamName: string, file: TeamFile): void {
  mkdirSync(getTeamDir(teamName), { recursive: true });
  writeFileSync(getTeamFilePath(teamName), JSON.stringify(file, null, 2));
}

/** Async write — preferred path from tool handlers. */
export async function writeTeamFileAsync(
  teamName: string,
  file: TeamFile,
): Promise<void> {
  await mkdir(getTeamDir(teamName), { recursive: true });
  await writeFile(getTeamFilePath(teamName), JSON.stringify(file, null, 2));
}

// ─── member-list mutations ──────────────────────────────────────────
//
// These three helpers (add / setActive / remove) are the only mutation
// vocabulary the rest of the codebase needs. Each one reads-then-writes
// the TeamFile in a single op — there's no per-file lock here because:
//
//   1. The only writers are the team lead's process (Easy Agent is
//      single-process — no tmux teammates), and
//   2. The lead's writes happen serially inside one event loop turn
//      (AgentTool launches a teammate → registers them; nothing
//      concurrent races us).
//
// Source uses async file writes with no lock here for the same reason.

/**
 * Append a member to the team. Idempotent on `name` collision —
 * a same-named member is replaced (covers the "respawn a teammate
 * that crashed" case rather than silently keeping two entries).
 */
export async function addTeamMember(
  teamName: string,
  member: TeamMember,
): Promise<TeamFile | null> {
  const file = await readTeamFileAsync(teamName);
  if (!file) return null;
  const filtered = file.members.filter((m) => m.name !== member.name);
  filtered.push(member);
  const next: TeamFile = { ...file, members: filtered };
  await writeTeamFileAsync(teamName, next);
  return next;
}

/**
 * Toggle a member's active flag (used when the runChildAgent loop
 * transitions out of "running"). Returns the updated TeamFile so
 * callers don't have to re-read.
 */
export async function setMemberActive(
  teamName: string,
  memberName: string,
  isActive: boolean,
): Promise<TeamFile | null> {
  const file = await readTeamFileAsync(teamName);
  if (!file) return null;
  let changed = false;
  const next: TeamFile = {
    ...file,
    members: file.members.map((m) => {
      if (m.name === memberName && m.isActive !== isActive) {
        changed = true;
        return { ...m, isActive };
      }
      return m;
    }),
  };
  if (!changed) return file;
  await writeTeamFileAsync(teamName, next);
  return next;
}

/** Remove a member by name (no-op if not present). */
export async function removeTeamMember(
  teamName: string,
  memberName: string,
): Promise<TeamFile | null> {
  const file = await readTeamFileAsync(teamName);
  if (!file) return null;
  const filtered = file.members.filter((m) => m.name !== memberName);
  if (filtered.length === file.members.length) return file;
  const next: TeamFile = { ...file, members: filtered };
  await writeTeamFileAsync(teamName, next);
  return next;
}

// ─── cleanup ────────────────────────────────────────────────────────

/**
 * Recursive delete of the team's on-disk state. Used by TeamDelete and
 * by tests. Best-effort — missing directory is not an error.
 *
 * Worktree cleanup is NOT done here; the caller (TeamDelete) reads the
 * member list first and runs `removeAgentWorktree` per member before
 * blowing away the team dir. Doing it here would leave us with no
 * member list to iterate.
 */
export async function cleanupTeamDirectory(teamName: string): Promise<void> {
  try {
    await rm(getTeamDir(teamName), { recursive: true, force: true });
  } catch {
    // Best-effort.
  }
}

/**
 * Enumerate every team currently on disk. Used by TeamCreate to refuse
 * duplicates and by the `/teams` listing command (future stage).
 */
export async function listTeamNames(): Promise<string[]> {
  try {
    const entries = await readdir(getTeamsRoot(), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
