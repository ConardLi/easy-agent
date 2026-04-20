/**
 * Single source of truth for every Easy Agent on-disk path.
 *
 * Why this exists:
 *   The `~/.easy-agent/` directory layout used to be re-derived in 9
 *   different files (taskStore, plans, memdir, session storage, MCP config,
 *   permission settings, AGENT.md loader, stream debug, …). Every refactor
 *   risked typo-ing the directory name (`.easy-agent` vs `.agent`) or
 *   computing the home dir slightly differently (`os.homedir()` vs
 *   `process.env.HOME || "~"`, the latter producing a literal `~` string
 *   when HOME was unset).
 *
 *   This module centralizes ALL of those paths — both the global
 *   `~/.easy-agent/...` family AND the per-project `<cwd>/.easy-agent/...`
 *   family. Callers should NEVER recompute these paths inline; doing so
 *   defeats the purpose and reintroduces the drift this file was created
 *   to prevent.
 *
 * Layout:
 *
 *   Global (per-user, machine-wide):
 *     ~/.easy-agent/
 *     ├── settings.json         ← user-scope settings (perms, mcpServers, ...)
 *     ├── AGENT.md              ← user-scope memory loaded into system prompt
 *     ├── tasks/                ← Task V2 persisted task graphs (per session)
 *     ├── plans/                ← Plan-mode plan files
 *     ├── projects/             ← per-cwd memory + session JSONL transcripts
 *     └── stream-debug.log      ← opt-in raw SSE log
 *
 *   Project (per-cwd, repo-local):
 *     <cwd>/.easy-agent/
 *     └── settings.json         ← project-scope overrides (perms, mcpServers)
 *
 * Path resolution rules:
 *   - Global paths use `os.homedir()` exclusively (NOT `process.env.HOME`,
 *     which is unreliable on Windows and can be unset/empty).
 *   - All path joins go through `node:path` so platform separators are
 *     handled correctly.
 *   - These functions are PURE — they don't read or create anything on
 *     disk. Callers that want the directory to exist must `mkdir -p` it
 *     themselves (none of these helpers eagerly mkdir, to keep them
 *     side-effect-free for tests).
 */

import * as os from "node:os";
import * as path from "node:path";

const DIR_NAME = ".easy-agent";
const SETTINGS_FILE = "settings.json";

// ─── Global (~/.easy-agent/...) ──────────────────────────────────────

/** Returns `~/.easy-agent`. */
export function getEasyAgentHome(): string {
  return path.join(os.homedir(), DIR_NAME);
}

/** Returns `~/.easy-agent/<name>` — for any subdirectory or file by name. */
export function getEasyAgentPath(...segments: string[]): string {
  return path.join(getEasyAgentHome(), ...segments);
}

/** Returns `~/.easy-agent/settings.json`. */
export function getUserSettingsPath(): string {
  return getEasyAgentPath(SETTINGS_FILE);
}

/** Returns `~/.easy-agent/AGENT.md`. */
export function getGlobalAgentMdPath(): string {
  return getEasyAgentPath("AGENT.md");
}

/** Returns `~/.easy-agent/tasks`. */
export function getTasksRoot(): string {
  return getEasyAgentPath("tasks");
}

/** Returns `~/.easy-agent/plans`. */
export function getPlansRoot(): string {
  return getEasyAgentPath("plans");
}

/** Returns `~/.easy-agent/projects` — both memory + session storage live here. */
export function getProjectsRoot(): string {
  return getEasyAgentPath("projects");
}

/** Returns `~/.easy-agent/stream-debug.log`. */
export function getStreamDebugLogPath(): string {
  return getEasyAgentPath("stream-debug.log");
}

// ─── Project (<cwd>/.easy-agent/...) ─────────────────────────────────

/** Returns `<cwd>/.easy-agent`. */
export function getProjectEasyAgentDir(cwd: string): string {
  return path.join(cwd, DIR_NAME);
}

/** Returns `<cwd>/.easy-agent/settings.json`. */
export function getProjectSettingsPath(cwd: string): string {
  return path.join(getProjectEasyAgentDir(cwd), SETTINGS_FILE);
}

// ─── Tuple helpers ───────────────────────────────────────────────────

/**
 * Returns both settings file paths in scope order (user, then project).
 * Convenient for code that loads + merges both, like the MCP config and
 * permission settings loaders. Project overrides user, so iterate in this
 * order and let later writes win.
 */
export function getSettingsPaths(cwd: string): { user: string; project: string } {
  return { user: getUserSettingsPath(), project: getProjectSettingsPath(cwd) };
}
