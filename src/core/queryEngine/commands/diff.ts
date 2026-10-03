/**
 * Diff command group — `/diff [n]`.
 *
 * Extracted verbatim from queryEngine.ts; behavior is unchanged. Shows
 * uncommitted git changes (working tree vs HEAD) as per-file unified patches
 * plus the agent's file-history edits over the last n turns, emitted as a
 * structured `diff_view` event for the UI to colorize.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { relative as relativePath } from "node:path";
import { parseGitDiff, parseGitStatus, parseShortStat } from "../helpers.js";
import {
  fileHistoryEnabled,
  fileHistoryGetDiffStats,
  getSnapshotByOffset,
  snapshotCount,
} from "../../../session/fileHistory.js";
import type { DiffFilePatch, DiffViewData, QueryEngineEvent } from "../types.js";
import type { CommandContext } from "./context.js";

const execFileAsync = promisify(execFile);

/** Run a git subcommand in the session cwd; never throws. */
async function runGit(
  ctx: CommandContext,
  args: string[],
): Promise<{ ok: boolean; stdout: string; error?: string }> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: ctx.cwd,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, stdout: "", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * `/diff [n]` — show what changed, as a colorized panel.
 *   - Uncommitted git changes (working tree vs HEAD): per-file unified
 *     patches the UI renders with green/red/cyan hunks. Falls back gracefully outside a git repo.
 *   - Agent file-history edits over the last n turns (default 1), reusing the
 *     same snapshot machinery `/rewind` relies on.
 *
 * Emits a structured `diff_view` event rather than a text blob so the diff
 * reads like a real diff instead of a raw `git diff` dump.
 */
export async function* handleDiffCommand(
  ctx: CommandContext,
  args: string[],
): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
  let turns = 1;
  const raw = args[0]?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      yield { type: "command", kind: "error", message: `Invalid turn count: ${raw}. Usage: /diff [n] where n ≥ 1.` };
      return { handled: true };
    }
    turns = parsed;
  }

  const cwd = ctx.cwd;
  // Total patch-line budget across all files so a huge working tree can't
  // flood the terminal. Past this the UI shows a "run git diff" hint.
  const MAX_PATCH_LINES = 400;

  let isRepo = false;
  let files: DiffFilePatch[] = [];
  let gitStat: DiffViewData["gitStat"] = null;
  let truncated = false;

  const repoCheck = await runGit(ctx, ["rev-parse", "--is-inside-work-tree"]);
  if (repoCheck.ok && repoCheck.stdout.trim() === "true") {
    isRepo = true;
    const [status, shortstat, patch] = await Promise.all([
      runGit(ctx, ["status", "--short"]),
      runGit(ctx, ["diff", "--shortstat"]),
      runGit(ctx, ["diff"]),
    ]);

    const statusByPath = parseGitStatus(status.stdout);
    gitStat = parseShortStat(shortstat.stdout);

    let budget = MAX_PATCH_LINES;
    for (const file of parseGitDiff(patch.stdout)) {
      const rel = relativePath(cwd, file.path);
      const displayPath = rel && !rel.startsWith("..") ? rel : file.path;
      if (budget <= 0) {
        truncated = true;
        break;
      }
      const lines = file.lines.slice(0, budget);
      if (lines.length < file.lines.length) truncated = true;
      budget -= lines.length;
      files.push({
        path: displayPath,
        status: statusByPath.get(file.path) ?? "M",
        lines,
      });
    }
  }

  // ── file-history per-turn edits ──
  let fileHistory: DiffViewData["fileHistory"];
  if (!fileHistoryEnabled() || snapshotCount() === 0) {
    fileHistory = !fileHistoryEnabled() ? { state: "disabled" } : { state: "empty" };
  } else {
    const target = getSnapshotByOffset(Math.min(turns, snapshotCount()));
    if (!target) {
      fileHistory = { state: "empty" };
    } else {
      const stats = await fileHistoryGetDiffStats(target.messageId);
      if (stats.filesChanged.length === 0) {
        fileHistory = { state: "empty" };
      } else {
        fileHistory = {
          state: "changes",
          filesChanged: stats.filesChanged.map((f) => {
            const rel = relativePath(cwd, f);
            return rel && !rel.startsWith("..") ? rel : f;
          }),
          insertions: stats.insertions,
          deletions: stats.deletions,
        };
      }
    }
  }

  yield {
    type: "diff_view",
    data: { isRepo, files, gitStat, truncated, turns, fileHistory },
  };
  return { handled: true };
}
