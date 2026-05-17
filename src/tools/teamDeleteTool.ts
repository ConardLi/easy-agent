/**
 * TeamDelete — disband the active Agent Teams session.
 *
 * Reference: claude-code-source-code/src/tools/TeamDeleteTool/TeamDeleteTool.ts
 *
 * Lifecycle:
 *   1. Refuse if no team is active (no-op error so the model doesn't
 *      retry blindly).
 *   2. Refuse if any non-lead teammate is still `isActive: true` —
 *      mirrors source's `activeMembers.length > 0` check. The model is
 *      instructed to message the teammates first (or wait for them to
 *      finish) before deleting the team. Stage 21 does not implement
 *      the shutdown_request protocol, so the model handles cleanup
 *      manually.
 *   3. Best-effort `removeAgentWorktree` for each teammate that left
 *      uncommitted changes in an isolated worktree.
 *   4. `rm -rf ~/.easy-agent/teams/<sanitized>/` — atomically removes
 *      the team file, every inbox, and any leftover lock files.
 *   5. Clear the in-process teamContext singleton.
 *
 * What we omit vs source:
 *   - Analytics event.
 *   - Color-assignment registry cleanup (we don't track teammate colors).
 *   - tmux pane / orphan-process cleanup (no tmux backend).
 *   - `clearLeaderTeamName()` (we don't share the task-list-id namespace
 *     between lead and teammates; each teammate has its own session id).
 */

import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { isAgentTeamsEnabled } from "../utils/agentTeamsEnabled.js";
import {
  cleanupTeamDirectory,
  readTeamFileAsync,
  TEAM_LEAD_NAME,
} from "../utils/teamHelpers.js";
import {
  clearActiveTeam,
  getActiveTeam,
} from "../state/teamContext.js";
import { removeAgentWorktree } from "../utils/worktree.js";

export const teamDeleteTool: Tool = {
  name: "TeamDelete",
  description:
    "Disband the currently active Agent Teams session. " +
    "Removes the on-disk team file, every teammate's inbox, and any worktrees the teammates were operating in (when those worktrees are clean). " +
    "Refuses if any teammate is still `isActive: true` — finish or interrupt their work first (use `SendMessage` to ask them to stop, or wait for the `<task-notification>`). " +
    "Use this when the team's mission is complete and you want to return the session to single-agent mode.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },

  async call(
    _input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolResult> {
    const active = getActiveTeam();
    if (!active) {
      return {
        content: "Error: no team is currently active. Nothing to delete.",
        isError: true,
      };
    }

    const file = await readTeamFileAsync(active.teamName);
    if (!file) {
      // On-disk file vanished out from under us. Clean up the in-memory
      // state anyway — a stale teamContext is worse than a missing file.
      clearActiveTeam();
      return {
        content:
          `Team "${active.teamName}" was already missing on disk. Cleared the in-process team context.`,
      };
    }

    // Source-aligned safety: refuse cleanup while real work is running.
    // The lead's own entry is always `isActive: true` while the session
    // is alive — exclude it from the check.
    const activeTeammates = file.members.filter(
      (m) => m.name !== TEAM_LEAD_NAME && m.isActive,
    );
    if (activeTeammates.length > 0) {
      const names = activeTeammates.map((m) => m.name).join(", ");
      return {
        content:
          `Error: cannot delete team "${active.teamName}" — ${activeTeammates.length} teammate(s) still active: ${names}.\n` +
          `Either wait for them to finish (you'll get a <task-notification> for each), or SendMessage them to wrap up. ` +
          `Once every teammate's isActive flag flips to false, retry TeamDelete.`,
        isError: true,
      };
    }

    // Best-effort worktree cleanup. Dirty worktrees are intentionally
    // skipped — the per-teammate finalizer (runAsyncAgent's
    // cleanupWorktreeIfNeeded) already removed clean ones at the end
    // of each teammate's run, so anything still present here is either
    // (a) dirty, or (b) clean-but-failed-to-remove. Case (a) is
    // explicitly preserved by source's worktree policy; we surface a
    // pointer rather than auto-deleting.
    const worktreeWarnings: string[] = [];
    const preservedWorktrees: string[] = [];
    for (const member of file.members) {
      if (!member.worktreePath || !member.worktreeBranch || !member.gitRoot) {
        continue;
      }
      try {
        const result = await removeAgentWorktree({
          worktreePath: member.worktreePath,
          worktreeBranch: member.worktreeBranch,
          gitRoot: member.gitRoot,
        });
        if (!result.ok) {
          // Most likely dirty — log + preserve. The user can review the
          // worktree dir and pick out anything worth keeping.
          preservedWorktrees.push(
            `  - ${member.name}: ${member.worktreePath} (${result.error})`,
          );
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        worktreeWarnings.push(
          `  - ${member.name}: failed to remove worktree ${member.worktreePath} (${msg})`,
        );
      }
    }

    await cleanupTeamDirectory(active.teamName);
    clearActiveTeam();

    const lines = [
      `Team "${active.teamName}" disbanded. Removed team file and inboxes.`,
      preservedWorktrees.length > 0
        ? `Preserved worktrees (likely have uncommitted changes — review manually):\n${preservedWorktrees.join("\n")}`
        : "",
      worktreeWarnings.length > 0
        ? `Warnings during worktree cleanup:\n${worktreeWarnings.join("\n")}`
        : "",
      "The session is back to single-agent mode. Call TeamCreate again to start a new team.",
    ]
      .filter(Boolean)
      .join("\n");

    return { content: lines };
  },

  isReadOnly(): boolean {
    return false;
  },

  isEnabled(): boolean {
    return isAgentTeamsEnabled();
  },

  isConcurrencySafe(): boolean {
    return false;
  },
};
