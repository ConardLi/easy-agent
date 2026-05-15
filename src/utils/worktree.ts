/**
 * Git worktree utilities for sub-agent isolation (stage 20).
 *
 * Reference: claude-code-source-code/src/utils/worktree.ts.
 * The source's worktree.ts is ~1200 lines and supports hook-based
 * worktrees, sparse checkout, husky/hooksPath propagation,
 * settings.local.json copy, and a separate user-session "Enter/Exit
 * worktree" flow. Stage 20 keeps just the slice the AgentTool needs:
 *
 *   - findGitRoot(cwd)        : walk up to the canonical repo root
 *   - createAgentWorktree(slug): `git worktree add -B <branch> <path> HEAD`
 *   - removeAgentWorktree(...) : `git worktree remove --force` + `branch -D`
 *   - hasWorktreeChanges(...)  : status + rev-list HEAD~base — fail-closed
 *
 * Path / branch convention (matches source's flatten-then-prefix shape
 * but uses `.easy-agent/` instead of `.claude/`):
 *
 *   <gitRoot>/.easy-agent/worktrees/<slug>/        ← worktree directory
 *   worktree-<slug>                                ← branch name
 *
 * `slug` is provided by the caller (typically `agent-<short-id>`); the
 * helpers also flatten any embedded slashes (`/` → `+`) so that sluggy
 * inputs like `agent/explore/abc` produce a single-level dir + a legal
 * branch name.
 *
 * Fail-closed semantics:
 *   `hasWorktreeChanges` treats *any* git error as "has changes" so we
 *   never auto-delete a worktree that we can't prove is clean. The
 *   AgentTool then preserves the worktree and surfaces its path in the
 *   `<task-notification>`/result so the user can recover the work.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WORKTREES_SUBDIR = path.join(".easy-agent", "worktrees");

export interface WorktreeInfo {
  /** Absolute path to the worktree directory. */
  worktreePath: string;
  /** Branch name created/reset for this worktree. */
  worktreeBranch: string;
  /** HEAD SHA at creation time — baseline for `hasWorktreeChanges`. */
  headCommit: string;
  /** Repo root the worktree was created against. */
  gitRoot: string;
}

/** Flatten `/` so a slug containing it becomes a single dir-safe + branch-safe name. */
function flattenSlug(slug: string): string {
  return slug.replaceAll("/", "+");
}

export function worktreeBranchName(slug: string): string {
  return `worktree-${flattenSlug(slug)}`;
}

export function worktreePathFor(repoRoot: string, slug: string): string {
  return path.join(repoRoot, WORKTREES_SUBDIR, flattenSlug(slug));
}

/**
 * Walk upwards from `cwd` looking for a directory that contains a `.git`
 * entry (file or directory — submodules and worktrees use a `.git` file).
 * Returns null when no enclosing repo is found.
 *
 * We deliberately avoid shelling out to `git rev-parse --show-toplevel`:
 * (1) it's slower than a few `stat` calls; (2) it returns the worktree
 * root rather than the canonical repo root if we're already inside one,
 * which would let nested-worktree mistakes happen. Same reasoning as
 * `findCanonicalGitRoot` in source.
 */
export async function findGitRoot(cwd: string): Promise<string | null> {
  let current = path.resolve(cwd);
  // Bound the walk — we shouldn't traverse more than ~50 levels in any
  // realistic filesystem.
  for (let i = 0; i < 64; i++) {
    try {
      const dotGit = path.join(current, ".git");
      // .git can be a directory (normal repo) OR a file (submodule /
      // linked worktree). Either is enough to call `current` the root.
      await fs.stat(dotGit);
      return current;
    } catch {
      // not present here — keep walking
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/** True if the cwd is inside a git repo. Cheap wrapper around findGitRoot. */
export async function isInsideGitRepo(cwd: string): Promise<boolean> {
  return (await findGitRoot(cwd)) !== null;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `git ...` and return code/stdout/stderr without throwing. We use this
 * everywhere instead of `execFileAsync` so callers can branch on exit code
 * and inspect stderr without try/catch noise.
 */
async function git(args: string[], cwd: string): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      // Cap output so a runaway log can't OOM us.
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error: unknown) {
    const e = error as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    // execFile rejection: code is the exit code, OR the spawn errno
    // string (e.g. "ENOENT" when git isn't installed). Normalize.
    const code = typeof e?.code === "number" ? e.code : 127;
    return {
      code,
      stdout: e?.stdout ?? "",
      stderr: e?.stderr ?? (error instanceof Error ? error.message : String(error)),
    };
  }
}

/**
 * Create a worktree dedicated to one sub-agent invocation.
 *
 * Steps (all against `gitRoot`):
 *   1. Resolve HEAD SHA — used later as the baseline for change detection.
 *   2. mkdir -p `<gitRoot>/.easy-agent/worktrees/`.
 *   3. `git worktree add -B worktree-<slug> <path> HEAD` — `-B` resets
 *      the branch if it already exists, mirroring source's behaviour
 *      so a stale leftover from a previous run gets reused cleanly.
 *
 * Throws on failure. Caller (AgentTool) catches and falls back to "no
 * isolation" with a warning rather than aborting the whole sub-agent.
 */
export async function createAgentWorktree(
  slug: string,
  cwd: string,
): Promise<WorktreeInfo> {
  const gitRoot = await findGitRoot(cwd);
  if (!gitRoot) {
    throw new Error(
      `Cannot create worktree: ${cwd} is not inside a git repository.`,
    );
  }

  // Capture baseline HEAD before we touch anything.
  const head = await git(["rev-parse", "HEAD"], gitRoot);
  if (head.code !== 0) {
    throw new Error(
      `Failed to read HEAD in ${gitRoot}: ${head.stderr.trim() || "git rev-parse HEAD failed"}`,
    );
  }
  const headCommit = head.stdout.trim();

  const worktreePath = worktreePathFor(gitRoot, slug);
  const worktreeBranch = worktreeBranchName(slug);

  // Make sure the parent dir exists. `git worktree add` is happy to mkdir
  // its target, but the *parent* must exist on some platforms.
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });

  const add = await git(
    ["worktree", "add", "-B", worktreeBranch, worktreePath, "HEAD"],
    gitRoot,
  );
  if (add.code !== 0) {
    throw new Error(
      `git worktree add failed: ${add.stderr.trim() || `exit ${add.code}`}`,
    );
  }

  return { worktreePath, worktreeBranch, headCommit, gitRoot };
}

/**
 * Detect whether the worktree has any changes worth preserving.
 *
 * Two signals, OR-ed together:
 *   - `git status --porcelain` non-empty → uncommitted files (working
 *     tree dirty, staged, or untracked).
 *   - `git rev-list --count <baseline>..HEAD` > 0 → new commits made
 *     by the sub-agent on this branch.
 *
 * Fail-closed: any git error returns true. Better to leave a redundant
 * worktree behind than to delete unsaved work.
 */
export async function hasWorktreeChanges(
  worktreePath: string,
  headCommit: string,
): Promise<boolean> {
  const status = await git(["status", "--porcelain"], worktreePath);
  if (status.code !== 0) return true;
  if (status.stdout.trim().length > 0) return true;

  const revList = await git(
    ["rev-list", "--count", `${headCommit}..HEAD`],
    worktreePath,
  );
  if (revList.code !== 0) return true;
  const count = Number.parseInt(revList.stdout.trim(), 10);
  if (Number.isFinite(count) && count > 0) return true;

  return false;
}

/**
 * Tear down a worktree: `git worktree remove --force` then `git branch -D`.
 *
 * Returns `{ ok, error? }` — caller decides whether to surface the error.
 * Both steps are best-effort; if `worktree remove` fails we still try the
 * branch delete (the worktree might already be gone from a previous run).
 */
export async function removeAgentWorktree(
  info: Pick<WorktreeInfo, "worktreePath" | "worktreeBranch" | "gitRoot">,
): Promise<{ ok: boolean; error?: string }> {
  const errors: string[] = [];

  const remove = await git(
    ["worktree", "remove", "--force", info.worktreePath],
    info.gitRoot,
  );
  if (remove.code !== 0) {
    errors.push(`worktree remove: ${remove.stderr.trim() || `exit ${remove.code}`}`);
  }

  const branchDelete = await git(
    ["branch", "-D", info.worktreeBranch],
    info.gitRoot,
  );
  if (branchDelete.code !== 0) {
    errors.push(`branch -D: ${branchDelete.stderr.trim() || `exit ${branchDelete.code}`}`);
  }

  if (errors.length > 0) return { ok: false, error: errors.join("; ") };
  return { ok: true };
}
