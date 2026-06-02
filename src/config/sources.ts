/**
 * Multi-source settings layer — the single place that knows the ordered list
 * of settings.json sources and how to read them.
 *
 * Source order (low → high priority; later overrides earlier):
 *
 *     user → project → local → flag → policy
 *
 *   user    ~/.easy-agent/settings.json            cross-project, shareable
 *   project <cwd>/.easy-agent/settings.json        per-repo, committed
 *   local   <cwd>/.easy-agent/settings.local.json  per-repo, gitignored
 *   flag    CLI flags (in-memory)                   this invocation only
 *   policy  managed-settings.json                   machine-wide (extension slot)
 *
 * Every feature loader (permissions / mcp / hooks / sandbox / outputStyle /
 * statusLine) consumes THIS layer instead of re-deriving paths and re-merging
 * user+project by hand. That keeps merge semantics consistent and means new
 * sources (local, flag, policy) light up everywhere at once.
 *
 * Two merge rules every consumer must respect:
 *   - array fields  → concatenate across sources, then de-duplicate.
 *   - scalar/object → later source wins.
 *
 * Security: some settings are privilege-escalating (e.g. permission `mode:
 * auto`, which disables all confirmation prompts). Those must never be honored
 * from a project's committed/local files, or a hostile repo could silently
 * escalate. Loaders read such keys only from non-project sources — see
 * `isTrustedScopeForSensitiveKeys`.
 */

import * as fs from "node:fs/promises";
import {
  getLocalSettingsPath,
  getProjectSettingsPath,
  getUserSettingsPath,
} from "../utils/paths.js";
import { readJsonSettingsFile } from "../utils/settings.js";
import { getManagedSettingsPath } from "./managedPath.js";
import { isProjectTrusted } from "./globalState.js";
import { validateSettings } from "./schema.js";

export type SettingSource = "user" | "project" | "local" | "flag" | "policy";

/** Source priority, low → high. Later entries override earlier ones. */
export const SETTING_SOURCE_ORDER: readonly SettingSource[] = [
  "user",
  "project",
  "local",
  "flag",
  "policy",
] as const;

export interface LoadedSource {
  source: SettingSource;
  /** Absolute file path, or null for the in-memory flag source. */
  path: string | null;
  /** Parsed + schema-validated JSON object, or null when missing/unreadable. */
  raw: Record<string, unknown> | null;
  /** Set when the file existed but could not be parsed. */
  parseError?: string;
  /** Per-field schema repairs (dropped rules / ignored fields), if any. */
  validationErrors?: string[];
}

// ─── flag source (set once by the CLI entrypoint) ────────────────────────

let flagSettings: Record<string, unknown> | null = null;

/** Install the flag-derived settings object (built from argv in cli.ts). */
export function setFlagSettings(settings: Record<string, unknown> | null): void {
  flagSettings = settings && Object.keys(settings).length > 0 ? settings : null;
  // Flags are part of the merge signature; busting the cache keeps every
  // consumer consistent with the new flag layer on the next read.
  resetSettingsCache();
}

export function getFlagSettings(): Record<string, unknown> | null {
  return flagSettings;
}

// ─── read cache (mtime-invalidated) ──────────────────────────────────────

interface CacheEntry {
  /** Signature of all source files + flag settings at load time. */
  signature: string;
  sources: LoadedSource[];
}

const sourceCache = new Map<string, CacheEntry>();

/**
 * Drop all cached source reads. Called automatically when flags change or a
 * settings file is written (see `writeSettingsPatch`); `/config set` relies on
 * this so a freshly-written value is visible to the very next read.
 */
export function resetSettingsCache(): void {
  sourceCache.clear();
}

/** Cheap per-file fingerprint: mtime + size, or "none" when absent. */
async function fileSignature(filePath: string): Promise<string> {
  try {
    const stat = await fs.stat(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "none";
  }
}

/** Build a `LoadedSource` from a raw file/flag read, applying schema validation. */
function buildSource(
  source: SettingSource,
  filePath: string | null,
  raw: Record<string, unknown> | null,
  parseError: string | undefined,
): LoadedSource {
  if (raw == null) {
    return { source, path: filePath, raw: null, ...(parseError ? { parseError } : {}) };
  }
  const { value, errors } = validateSettings(raw, filePath ?? source);
  return {
    source,
    path: filePath,
    raw: value,
    ...(errors.length ? { validationErrors: errors } : {}),
  };
}

// ─── source loading ──────────────────────────────────────────────────────

/**
 * Read every settings source for `cwd`, in priority order (low → high).
 * Never throws — unreadable/invalid files surface as `raw: null` plus a
 * `parseError` the caller can report.
 */
export async function loadSettingSources(cwd: string): Promise<LoadedSource[]> {
  const userPath = getUserSettingsPath();
  const projectPath = getProjectSettingsPath(cwd);
  const localPath = getLocalSettingsPath(cwd);
  const policyPath = getManagedSettingsPath();
  const flag = getFlagSettings();

  // Cache key off file fingerprints + the flag layer. A write (which changes
  // mtime/size) or a flag change invalidates the entry; an external hand-edit
  // is picked up too. Parsing + validating 4 files on every permission check
  // would otherwise be pure overhead since settings change rarely.
  const [userSig, projectSig, localSig, policySig] = await Promise.all([
    fileSignature(userPath),
    fileSignature(projectPath),
    fileSignature(localPath),
    fileSignature(policyPath),
  ]);
  const signature = [userSig, projectSig, localSig, policySig, JSON.stringify(flag)].join("|");

  const cached = sourceCache.get(cwd);
  if (cached && cached.signature === signature) return cached.sources;

  const [user, project, local, policy] = await Promise.all([
    readJsonSettingsFile<Record<string, unknown>>(userPath),
    readJsonSettingsFile<Record<string, unknown>>(projectPath),
    readJsonSettingsFile<Record<string, unknown>>(localPath),
    readJsonSettingsFile<Record<string, unknown>>(policyPath),
  ]);

  const sources: LoadedSource[] = [
    buildSource("user", userPath, user.raw, user.parseError),
    buildSource("project", projectPath, project.raw, project.parseError),
    buildSource("local", localPath, local.raw, local.parseError),
    buildSource("flag", null, flag, undefined),
    buildSource("policy", policyPath, policy.raw, policy.parseError),
  ];

  sourceCache.set(cwd, { signature, sources });
  return sources;
}

/**
 * Like {@link loadSettingSources}, but drops the project + local sources when
 * the cwd is NOT trusted. Loaders that EXECUTE config-defined shell commands
 * (hooks, statusLine) use this so an untrusted repository's settings can't run
 * arbitrary commands before the user has trusted it.
 */
export async function loadTrustedSettingSources(cwd: string): Promise<LoadedSource[]> {
  const all = await loadSettingSources(cwd);
  if (await isProjectTrusted(cwd)) return all;
  return all.filter((s) => s.source !== "project" && s.source !== "local");
}

/**
 * Sources from which privilege-escalating keys (e.g. permission `mode`) may be
 * read. Project + local are excluded so a committed/checked-in config can't
 * escalate privileges on its own.
 */
export function isTrustedScopeForSensitiveKeys(source: SettingSource): boolean {
  return source !== "project" && source !== "local";
}

// ─── generic accessors ───────────────────────────────────────────────────

/**
 * Last defined value for a top-level key across sources (later source wins).
 * `excludeSensitive` restricts the read to non-project/local sources for
 * privilege-escalating keys.
 */
export function getScalarSetting<T = unknown>(
  sources: LoadedSource[],
  key: string,
  opts: { excludeSensitive?: boolean; predicate?: (v: unknown) => boolean } = {},
): T | undefined {
  let result: T | undefined;
  for (const src of sources) {
    if (!src.raw) continue;
    if (opts.excludeSensitive && !isTrustedScopeForSensitiveKeys(src.source)) continue;
    const value = src.raw[key];
    if (value === undefined) continue;
    if (opts.predicate && !opts.predicate(value)) continue;
    result = value as T;
  }
  return result;
}

/**
 * Concatenate a string-array field across all sources (low → high) and
 * de-duplicate, preserving first-seen order. `normalize` extracts/cleans the
 * per-source array (each loader brings its own validation).
 */
export function getMergedStringArray(
  sources: LoadedSource[],
  normalize: (raw: Record<string, unknown> | null) => string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const src of sources) {
    for (const item of normalize(src.raw)) {
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}
