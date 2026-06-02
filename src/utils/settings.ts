/**
 * Safe JSON config-file reader, shared by every loader that consumes a
 * settings.json (currently: MCP servers + permission rules).
 *
 * What "safe" means here:
 *   - File missing  → returns { raw: null } silently. settings.json is
 *     optional; users without one should still get a working CLI.
 *   - Invalid JSON  → returns { raw: null, parseError: "..." } so the
 *     caller can decide whether to log a warning, abort startup, or
 *     fall back to defaults. The raw JSON parse error message is
 *     included verbatim so the user can find the offending line.
 *   - Other I/O err → returns { raw: null, parseError: "..." } likewise,
 *     prefixed with "Failed to read".
 *
 * What this DOES NOT do:
 *   - Schema validation. Every consumer (MCP / permissions / future
 *     settings) has its own schema and merge semantics, and they should
 *     own that logic. This util is just the file-reading primitive.
 *   - Caching. Settings change rarely and the file is small; the loaders
 *     above this layer can cache if they want.
 *   - Merging across scopes. The user/project merge logic lives in the
 *     caller because the rules differ per feature (MCP overrides per
 *     server name, permissions concatenate arrays, etc.).
 *
 * Reference: this consolidates the two near-identical
 * `readSettingsFile()` helpers that lived in `services/mcp/config.ts`
 * and `permissions/permissions.ts`.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  getLocalSettingsPath,
  getProjectEasyAgentDir,
  getProjectSettingsPath,
  getUserSettingsPath,
} from "./paths.js";
import {
  loadSettingSources,
  loadTrustedSettingSources,
  resetSettingsCache,
} from "../config/sources.js";

export interface SettingsFileResult<T = unknown> {
  /** Parsed JSON object, or null if missing / unreadable / invalid. */
  raw: T | null;
  /** Human-readable error if the file existed but couldn't be parsed. */
  parseError?: string;
}

/**
 * Read and JSON-parse a settings file. Never throws — the caller decides
 * how to surface failures (log a warning, fall back to defaults, etc.).
 *
 * @param filePath Absolute path to the settings file. Use the path
 *   helpers in `./paths.ts` to construct this; do NOT inline-build it.
 */
export async function readJsonSettingsFile<T = unknown>(
  filePath: string,
): Promise<SettingsFileResult<T>> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf-8");
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") return { raw: null };
    return {
      raw: null,
      parseError: `Failed to read ${filePath}: ${(error as Error).message}`,
    };
  }

  try {
    const parsed = JSON.parse(text) as T;
    return { raw: parsed };
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return {
        raw: null,
        parseError: `Invalid JSON in ${filePath}: ${error.message}`,
      };
    }
    return {
      raw: null,
      parseError: `Failed to parse ${filePath}: ${(error as Error).message}`,
    };
  }
}

/**
 * Read-merge-write a shallow patch into the USER settings file
 * (`~/.easy-agent/settings.json`). Used by `/output-style` (and future
 * `/config`) to persist a top-level preference like `outputStyle`.
 *
 * Semantics:
 *   - Missing / unparseable file → starts from `{}` (we don't want a single
 *     malformed character to make a preference un-persistable; the original
 *     bad content is overwritten with the merged result).
 *   - Shallow merge only — nested objects are replaced, not deep-merged.
 *     That's all the current callers need.
 *   - Creates `~/.easy-agent/` if it doesn't exist yet.
 */
export async function updateUserSettings(
  patch: Record<string, unknown>,
): Promise<void> {
  await writeSettingsPatch(getUserSettingsPath(), patch);
}

/**
 * Read-merge-write a shallow patch into the PROJECT settings file
 * (`<cwd>/.easy-agent/settings.json`). Used by `/config set --project`.
 * A `value === undefined` in the patch deletes that key (mirrors the
 * single-source write semantics in the plan).
 */
export async function updateProjectSettings(
  cwd: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await writeSettingsPatch(getProjectSettingsPath(cwd), patch);
}

/**
 * Read-merge-write a shallow patch into the LOCAL settings file
 * (`<cwd>/.easy-agent/settings.local.json`), and make sure that file is
 * gitignored so personal overrides never get committed.
 */
export async function updateLocalSettings(
  cwd: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await writeSettingsPatch(getLocalSettingsPath(cwd), patch);
  await ensureLocalSettingsGitignored(cwd);
}

/**
 * Shared shallow read-merge-write primitive. A `value === undefined` deletes
 * the key; otherwise the top-level key is replaced. Creates the parent
 * directory if needed and never throws on a missing/garbled source file (the
 * bad content is overwritten by the merged result).
 */
async function writeSettingsPatch(
  filePath: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { raw } = await readJsonSettingsFile<Record<string, unknown>>(filePath);
  const merged: Record<string, unknown> = { ...(raw ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  // Bust the merged-read cache so the freshly written value is visible to the
  // next `loadSettingSources` call (e.g. `/config set` → live reload), even if
  // the filesystem's mtime resolution is too coarse to register the change.
  resetSettingsCache();
}

/**
 * Append `settings.local.json` to `<cwd>/.easy-agent/.gitignore` if it isn't
 * already ignored, so local overrides aren't accidentally committed.
 */
async function ensureLocalSettingsGitignored(cwd: string): Promise<void> {
  const dir = getProjectEasyAgentDir(cwd);
  const gitignorePath = path.join(dir, ".gitignore");
  const entry = "settings.local.json";
  try {
    let existing = "";
    try {
      existing = await fs.readFile(gitignorePath, "utf-8");
    } catch {
      existing = "";
    }
    const lines = existing.split("\n").map((l) => l.trim());
    if (lines.includes(entry)) return;
    const next = existing && !existing.endsWith("\n") ? `${existing}\n${entry}\n` : `${existing}${entry}\n`;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(gitignorePath, next, "utf-8");
  } catch {
    // Best-effort — failing to update .gitignore must not block the write.
  }
}

/**
 * Resolved status-line command config. `null` means "no custom command —
 * render the built-in segmented status line".
 */
export interface StatusLineCommandConfig {
  command: string;
  /** Optional left padding (columns) the user can request. */
  padding?: number;
}

/**
 * Read the `statusLine` setting, merging user + project (PROJECT wins). Accepts
 * two shapes for ergonomics, mirroring how source treats `statusLine`:
 *   - a bare string  → treated as the command
 *   - an object       → { type?: "command", command: string, padding?: number }
 * Returns null when unset or malformed (the UI then shows its default line).
 */
export async function readStatusLineConfig(
  cwd: string,
): Promise<StatusLineCommandConfig | null> {
  // `disableAllHooks` also kills the statusLine (it runs a shell command every
  // turn, same execution surface as hooks) — mirrors source's behavior.
  if (await isAllHooksDisabled(cwd)) return null;

  // Trust-gated: the statusLine command is executed as a shell command on
  // every turn. An untrusted repo's project/local settings must not be able
  // to run code, so we read from the trusted source set (project + local are
  // dropped until the user trusts this folder).
  const sources = await loadTrustedSettingSources(cwd);
  let raw: unknown;
  for (const src of sources) {
    if (src.raw?.["statusLine"] !== undefined) raw = src.raw["statusLine"];
  }
  if (!raw) return null;
  if (typeof raw === "string") {
    return raw.trim() ? { command: raw.trim() } : null;
  }
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const command = typeof obj["command"] === "string" ? obj["command"].trim() : "";
    if (!command) return null;
    const padding = typeof obj["padding"] === "number" ? obj["padding"] : undefined;
    return padding !== undefined ? { command, padding } : { command };
  }
  return null;
}

/**
 * Read a single top-level string setting, merging user + project scopes
 * with PROJECT winning (project overrides user — same precedence as the
 * MCP / permissions loaders). Returns undefined when the key is absent or
 * not a string in both scopes.
 */
export async function readMergedStringSetting(
  cwd: string,
  key: string,
): Promise<string | undefined> {
  const sources = await loadSettingSources(cwd);
  let result: string | undefined;
  for (const src of sources) {
    const value = src.raw?.[key];
    if (typeof value === "string" && value.trim()) result = value.trim();
  }
  return result;
}

/**
 * Read a single top-level numeric setting, merging all sources with the later
 * source winning. Returns undefined when absent / non-numeric everywhere.
 * Used by `cleanupPeriodDays`.
 */
export async function readMergedNumberSetting(
  cwd: string,
  key: string,
): Promise<number | undefined> {
  const sources = await loadSettingSources(cwd);
  let result: number | undefined;
  for (const src of sources) {
    const value = src.raw?.[key];
    if (typeof value === "number" && Number.isFinite(value)) result = value;
  }
  return result;
}

/**
 * Read a single top-level boolean setting, merging all sources with the later
 * source winning. Returns undefined when absent / non-boolean everywhere, so
 * callers can apply their own default. Used by `respectGitignore`,
 * `syntaxHighlightingDisabled`, `prefersReducedMotion`.
 */
export async function readMergedBooleanSetting(
  cwd: string,
  key: string,
): Promise<boolean | undefined> {
  const sources = await loadSettingSources(cwd);
  let result: boolean | undefined;
  for (const src of sources) {
    const value = src.raw?.[key];
    if (typeof value === "boolean") result = value;
  }
  return result;
}

/**
 * True if ANY settings source sets `disableAllHooks: true`. Uses OR semantics
 * (not last-wins) because this is a fail-safe kill switch — disabling hooks
 * only REMOVES execution, so a project/local file should be able to turn it on
 * for itself, and no source should be able to silently turn it back off.
 */
export async function isAllHooksDisabled(cwd: string): Promise<boolean> {
  const sources = await loadSettingSources(cwd);
  return sources.some((src) => src.raw?.["disableAllHooks"] === true);
}

/**
 * Read a single top-level string setting from TRUSTED sources only (project +
 * local dropped until the folder is trusted), later source winning. Use this
 * for settings whose value is EXECUTED (e.g. `apiKeyHelper` runs a script), so
 * an untrusted repo can't run code or redirect auth.
 */
export async function readTrustedStringSetting(
  cwd: string,
  key: string,
): Promise<string | undefined> {
  const sources = await loadTrustedSettingSources(cwd);
  let result: string | undefined;
  for (const src of sources) {
    const value = src.raw?.[key];
    if (typeof value === "string" && value.trim()) result = value.trim();
  }
  return result;
}

/**
 * Merge the `env` map across TRUSTED sources (later source wins per key). The
 * values become process environment for spawned commands, so project/local env
 * is honored only once the folder is trusted. Values are coerced to strings.
 */
export async function readMergedEnv(cwd: string): Promise<Record<string, string>> {
  const sources = await loadTrustedSettingSources(cwd);
  const out: Record<string, string> = {};
  for (const src of sources) {
    const env = src.raw?.["env"];
    if (!env || typeof env !== "object" || Array.isArray(env)) continue;
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (value === undefined || value === null) continue;
      out[key] = typeof value === "string" ? value : String(value);
    }
  }
  return out;
}

/**
 * Concatenate + de-duplicate a string-array setting across TRUSTED sources.
 * Used by `additionalDirectories`, which widens the filesystem access boundary
 * — so an untrusted repo must not be able to grant itself extra directories.
 */
export async function readTrustedStringArraySetting(
  cwd: string,
  key: string,
): Promise<string[]> {
  const sources = await loadTrustedSettingSources(cwd);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const src of sources) {
    const arr = src.raw?.[key];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (typeof item !== "string") continue;
      const trimmed = item.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * Aggregate parse + schema-validation diagnostics across every settings source
 * for `cwd`. The UI calls this at startup to surface a single non-fatal notice
 * when a settings file is malformed or has invalid fields — a bad file/field
 * degrades to "ignored", it never crashes the CLI.
 */
export async function loadSettingsDiagnostics(cwd: string): Promise<string[]> {
  const sources = await loadSettingSources(cwd);
  const out: string[] = [];
  for (const s of sources) {
    if (s.parseError) out.push(s.parseError);
    if (s.validationErrors) out.push(...s.validationErrors);
  }
  return out;
}
