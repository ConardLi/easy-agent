/**
 * TeamDelete — disband the active Agent Teams session.
 *
 * Reference: claude-code-source-code/src/tools/TeamDeleteTool/TeamDeleteTool.ts
 *
 * Lifecycle:
 *   1. Refuse if no team is active (no-op error so the model doesn't
 *      retry blindly).
 *   2. Refuse while live teammates remain. Stale members require an
 *      explicit forceStale request after their work has been reviewed.
 *   3. Best-effort `removeAgentWorktree` for each teammate that left
 *      uncommitted changes in an isolated worktree.
 *   4. Remove the shared task list and team directory.
 *   5. Clear the in-process teamContext singleton.
 *
 * What we omit vs source:
 *   - Analytics event.
 *   - Color-assignment registry cleanup (we don't track teammate colors).
 *   - tmux pane / orphan-process cleanup (no tmux backend).
 */

import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { isAgentTeamsEnabled } from "../utils/agentTeamsEnabled.js";
import {
  cleanupTeamDirectory,
  isProcessAlive,
  prepareTeamDelete,
  readTeamFileAsync,
} from "../utils/teamHelpers.js";
import {
  clearActiveTeam,
  getActiveTeam,
} from "../state/teamContext.js";
import { removeAgentWorktree } from "../utils/worktree.js";
import { getTeamTaskListId, resetTaskList } from "../state/taskStore.js";

export const teamDeleteTool: Tool = {
  name: "TeamDelete",
  searchHint: "disband a swarm team and clean up",
  shouldDefer: true,
  description:
    "Disband the currently active Agent Teams session. " +
    "Removes the on-disk team file, every teammate's inbox, and any worktrees the teammates were operating in (when those worktrees are clean). " +
    "Refuses while any live teammate is active. Ask them to stop with a structured `SendMessage` shutdown request, or wait for their completion notification. " +
    "After a process crash, pass `team_name` and `forceStale: true` only after reviewing stale work. " +
    "Use this when the team's mission is complete and you want to return the session to single-agent mode.",
  inputSchema: {
    type: "object",
    properties: {
      team_name: { type: "string", description: "Existing team name, required when recovering after a process restart." },
      forceStale: { type: "boolean", description: "Delete a team whose previous members are confirmed stale. Live members are never forced." },
    },
    additionalProperties: false,
  },

  async call(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    if (context.teammateIdentity || context.taskScope === "session") {
      return { content: "Error: only the team lead can delete a team.", isError: true };
    }
    const active = getActiveTeam();
    const requestedName = typeof input.team_name === "string" ? input.team_name.trim() : "";
    const teamName = active?.teamName ?? requestedName;
    if (!teamName) {
      return {
        content: "Error: no team is currently active. Nothing to delete.",
        isError: true,
      };
    }

    if (active && requestedName && requestedName !== active.teamName) {
      return { content: `Error: active team is "${active.teamName}".`, isError: true };
    }
    const file = await readTeamFileAsync(teamName);
    if (!file) {
      // On-disk file vanished out from under us. Clean up the in-memory
      // state anyway — a stale teamContext is worse than a missing file.
      if (active) clearActiveTeam();
      return {
        content:
          `Team "${teamName}" was already missing on disk. Cleared the in-process team context.`,
      };
    }
    if (!active && isProcessAlive(file.leadPid)) {
      return { content: `Error: team "${teamName}" still has a live lead process.`, isError: true };
    }

    // Source-aligned safety: refuse cleanup while real work is running.
    // The lead's own entry is always `isActive: true` while the session
    // is alive — exclude it from the check.
    let prepared: Awaited<ReturnType<typeof prepareTeamDelete>>;
    try {
      prepared = await prepareTeamDelete(teamName, input.forceStale === true);
    } catch (error) {
      return {
        content: `Error: cannot delete team "${teamName}" — ${error instanceof Error ? error.message : String(error)}`,
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
    for (const member of prepared.file.members) {
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

    try {
      await resetTaskList(getTeamTaskListId(teamName));
      await cleanupTeamDirectory(teamName);
    } catch (error) {
      return { content: `Error: team cleanup failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
    }
    if (active) clearActiveTeam();

    const lines = [
      `Team "${teamName}" disbanded. Removed team file, inboxes, and shared task list.`,
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
