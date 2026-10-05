import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";

/** How many files a workspace listing holds, and how long it is reused. */
const MAX_FILES = 50_000;
const TTL_MS = 15_000;
const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "coverage", "target", "vendor"]);

const cache = new Map<string, { at: number; files: Promise<string[]> }>();

/** Tracked and untracked files git does not ignore, relative to `root`. */
function gitFiles(root: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: root, timeout: 5000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => resolve(error ? null : stdout.split("\0").filter(Boolean).slice(0, MAX_FILES)),
    );
  });
}

/** Outside a repository: walk the tree, skipping hidden and build directories. */
async function walk(root: string): Promise<string[]> {
  const files: string[] = [];
  const queue = [root];
  while (queue.length > 0 && files.length < MAX_FILES) {
    const dir = queue.shift()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) queue.push(path);
      } else if (entry.isFile()) files.push(relative(root, path));
    }
  }
  return files;
}

function listFiles(root: string): Promise<string[]> {
  const cached = cache.get(root);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.files;
  const files = gitFiles(root).then((list) => list ?? walk(root));
  cache.set(root, { at: Date.now(), files });
  return files;
}

/** Workspace files matching `query`, best matches first: file name prefix, then file name, then path. */
export async function searchFiles(root: string, query: string, limit = 40): Promise<string[]> {
  const files = await listFiles(root);
  const q = query.toLowerCase();
  if (!q) return files.slice(0, limit);
  const scored: [number, string][] = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const name = basename(lower);
    const score = name.startsWith(q) ? 0 : name.includes(q) ? 1 : lower.includes(q) ? 2 : -1;
    if (score >= 0) scored.push([score * 10_000 + file.length, file]);
  }
  return scored
    .sort((a, b) => a[0] - b[0])
    .slice(0, limit)
    .map(([, file]) => file);
}
