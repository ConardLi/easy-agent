/**
 * Git helpers for the plugin subsystem.
 *
 * SECURITY: git is ALWAYS invoked with an argument array via `execFile` — we
 * never build a shell string, so a malicious ref / URL can't inject shell
 * metacharacters. Every call has a timeout and captures stderr so a hang or an
 * auth failure surfaces as a clean error instead of blocking forever.
 *
 * Network access only happens here, and only from the explicit
 * `marketplace add/update` + `plugin install/update` flows — never at startup.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";

const DEFAULT_TIMEOUT_MS = 120_000;

export class GitError extends Error {
  constructor(
    message: string,
    readonly kind: "auth" | "network" | "notfound" | "generic",
    readonly stderr?: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

interface RunResult {
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd?: string, timeout = DEFAULT_TIMEOUT_MS): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout,
        maxBuffer: 16 * 1024 * 1024,
        // Never prompt for credentials interactively — fail fast instead of hanging.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(classify(error, stderr));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function classify(error: unknown, stderr: string): GitError {
  const text = `${(error as Error).message}\n${stderr}`.toLowerCase();
  const summary = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
  if (/authentication|could not read username|permission denied|403/.test(text)) {
    return new GitError("git authentication failed", "auth", summary);
  }
  if (/could not resolve host|network|timed out|connection/.test(text)) {
    return new GitError("git network error", "network", summary);
  }
  if (/not found|does not exist|repository not found|404/.test(text)) {
    return new GitError("git repository not found", "notfound", summary);
  }
  return new GitError(`git failed: ${summary || (error as Error).message}`, "generic", summary);
}

/**
 * Clone `url` (optionally at `ref`) into `dest`. `dest` must not already exist
 * (callers clone into a fresh temp dir, then atomically rename into place).
 */
export async function gitClone(url: string, dest: string, ref?: string): Promise<void> {
  if (!ref) {
    await run(["clone", "--depth", "1", "--", url, dest]);
    return;
  }

  // `git clone --branch <ref>` only accepts branch/tag names; a pinned commit
  // SHA is a valid marketplace ref too. Init + fetch + detached checkout works
  // uniformly for branches, tags, and raw SHAs.
  await fs.mkdir(dest, { recursive: true });
  await run(["init"], dest);
  await run(["remote", "add", "origin", url], dest);
  await run(["fetch", "--depth", "1", "origin", ref], dest);
  await run(["checkout", "--detach", "FETCH_HEAD"], dest);
}

/** Fetch + hard-reset an existing managed clone to the latest `ref` (or HEAD). */
export async function gitUpdate(dir: string, ref?: string): Promise<void> {
  await run(["fetch", "--depth", "1", "origin", ...(ref ? [ref] : [])], dir);
  // FETCH_HEAD works for branches, tags, and raw commit SHAs. `origin/<ref>`
  // does not exist for a pinned SHA.
  await run(["reset", "--hard", "FETCH_HEAD"], dir);
}

/** Short (12-char) HEAD commit SHA of a checkout, or undefined when unavailable. */
export async function gitHeadCommit(dir: string): Promise<string | undefined> {
  try {
    const { stdout } = await run(["rev-parse", "--short=12", "HEAD"], dir, 15_000);
    const sha = stdout.trim();
    return sha || undefined;
  } catch {
    return undefined;
  }
}

/** True when `dir` is (or is inside) a git working tree. */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await fs.access(dir);
    await run(["rev-parse", "--is-inside-work-tree"], dir, 15_000);
    return true;
  } catch {
    return false;
  }
}
