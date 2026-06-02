/**
 * Machine-level State store (`~/.easy-agent/state.json`).
 *
 * This is the second of Easy Agent's two configuration systems. Unlike
 * settings.json (shareable, version-controllable configuration), the State
 * store holds per-machine runtime + security state that must never be
 * committed to a repository — most importantly, which project directories
 * the user has marked as trusted.
 *
 * Why trust lives HERE and not in a project's settings.json:
 *   If trust were recorded inside the project directory, a hostile repository
 *   could ship a settings file that pre-marks itself as trusted, defeating the
 *   whole point of the trust prompt. Trust is therefore a property the user's
 *   own machine remembers ABOUT a directory, keyed by the directory's
 *   canonical identity.
 *
 * Project key:
 *   - inside a git repo → the canonical repo root (so every subdirectory of a
 *     trusted repo inherits trust, and worktrees of the same repo agree).
 *   - otherwise         → the absolute cwd.
 *   Keys are normalized to forward slashes for cross-platform stability.
 *
 * Durability:
 *   Writes go through a temp file + atomic rename so a crash mid-write can
 *   never leave a half-written, unparseable state file. A bad/missing file is
 *   treated as empty state (fail-soft) — losing trust state is annoying, not
 *   dangerous (the user just gets re-prompted).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getEasyAgentHome, getStatePath } from "../utils/paths.js";
import { findGitRoot } from "../utils/worktree.js";

interface ProjectState {
  trusted?: boolean;
}

export interface GlobalState {
  version: number;
  /** Per-machine preferences (theme, verbose, …). Extensible. */
  prefs: Record<string, unknown>;
  /** Per-project state keyed by canonical project key. */
  projects: Record<string, ProjectState>;
}

const CURRENT_VERSION = 1;

function emptyState(): GlobalState {
  return { version: CURRENT_VERSION, prefs: {}, projects: {} };
}

// In-memory cache of the parsed state. The file is small and read often
// (every trust check), so we parse once and reuse. Mutating writers update
// the cache in place so subsequent reads see their changes without re-reading.
let cache: GlobalState | null = null;

// Home-directory trust is intentionally NOT persisted — running the agent in
// $HOME is common and we don't want to permanently trust the entire home tree.
// Instead we remember the acceptance for this process only.
const sessionTrusted = new Set<string>();

/** Reset the in-memory cache. Test-only seam. */
export function resetGlobalStateCache(): void {
  cache = null;
  sessionTrusted.clear();
}

function normalizeKey(p: string): string {
  return path.resolve(p).split(path.sep).join("/");
}

/**
 * Canonical key for a working directory: the enclosing git repo root when
 * present, otherwise the absolute cwd. Normalized to forward slashes.
 */
export async function getProjectKey(cwd: string): Promise<string> {
  const gitRoot = await findGitRoot(cwd).catch(() => null);
  return normalizeKey(gitRoot ?? cwd);
}

export async function getGlobalState(): Promise<GlobalState> {
  if (cache) return cache;
  try {
    const text = await fs.readFile(getStatePath(), "utf-8");
    const parsed = JSON.parse(text) as Partial<GlobalState>;
    cache = {
      version: typeof parsed.version === "number" ? parsed.version : CURRENT_VERSION,
      prefs: parsed.prefs && typeof parsed.prefs === "object" ? parsed.prefs : {},
      projects:
        parsed.projects && typeof parsed.projects === "object" ? parsed.projects : {},
    };
  } catch {
    // Missing or unparseable → start from empty state (fail-soft).
    cache = emptyState();
  }
  return cache;
}

/**
 * Read-modify-write the State store under an atomic rename. The updater
 * receives a mutable draft; return value is ignored (mutate in place or
 * reassign fields). The in-memory cache is updated to the written value.
 */
export async function saveGlobalState(
  update: (draft: GlobalState) => void,
): Promise<void> {
  const current = await getGlobalState();
  const draft: GlobalState = {
    version: CURRENT_VERSION,
    prefs: { ...current.prefs },
    projects: { ...current.projects },
  };
  update(draft);

  const filePath = getStatePath();
  await fs.mkdir(getEasyAgentHome(), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(draft, null, 2) + "\n", "utf-8");
  await fs.rename(tmpPath, filePath);
  cache = draft;
}

function isHomeDir(key: string): boolean {
  return key === normalizeKey(os.homedir());
}

function isAncestorOrSelf(ancestor: string, key: string): boolean {
  return key === ancestor || key.startsWith(`${ancestor}/`);
}

/**
 * Is this working directory trusted? True when the project key, or any of its
 * ancestor keys, has been marked trusted — so trusting a repo root trusts all
 * its subdirectories. Home-dir trust is honored from session memory only.
 */
export async function isProjectTrusted(cwd: string): Promise<boolean> {
  const key = await getProjectKey(cwd);
  if (sessionTrusted.has(key)) return true;
  const state = await getGlobalState();
  for (const [storedKey, value] of Object.entries(state.projects)) {
    if (value.trusted && isAncestorOrSelf(storedKey, key)) return true;
  }
  return false;
}

/**
 * Mark this working directory as trusted. Home directory trust is kept in
 * session memory only (never written to disk); every other directory is
 * persisted under its canonical project key.
 */
export async function trustProject(cwd: string): Promise<void> {
  const key = await getProjectKey(cwd);
  if (isHomeDir(key)) {
    sessionTrusted.add(key);
    return;
  }
  await saveGlobalState((draft) => {
    draft.projects[key] = { ...draft.projects[key], trusted: true };
  });
}
