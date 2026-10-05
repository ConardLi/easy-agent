import { execFile } from "node:child_process";

/** Current branch of the repository at `cwd`, or null outside a repository or without git. */
export function currentBranch(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 3000 }, (error, stdout) => {
      const branch = stdout.trim();
      resolve(error || !branch ? null : branch === "HEAD" ? "detached" : branch);
    });
  });
}
