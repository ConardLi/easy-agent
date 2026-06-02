/**
 * Hooks settings loader — reads the `hooks` block from
 * ~/.easy-agent/settings.json and <cwd>/.easy-agent/settings.json,
 * normalizes it into the strongly-typed `HooksSettings` shape,
 * and exposes a `findMatchingHooks(...)` helper that picks the
 * right matcher groups for a given event + match field.
 *
 * The on-disk shape is intentionally identical to Claude Code's so
 * existing `.claude/settings.json` hook blocks paste-in cleanly.
 *
 * Merge precedence:
 *   user (loaded first)  →  project (loaded second; later wins)
 *
 * Source uses 5 scopes (policy / managed / user / project / local);
 * we ship 2 — matching the existing permission + MCP loaders.
 */

import { getSettingsPaths } from "../utils/paths.js";
import { readJsonSettingsFile, isAllHooksDisabled } from "../utils/settings.js";
import {
  loadTrustedSettingSources,
  type LoadedSource,
} from "../config/sources.js";
import {
  HOOK_EVENTS,
  isHookEvent,
  type HookCommand,
  type HookEvent,
  type HookMatcherGroup,
  type HooksSettings,
} from "./types.js";

interface RawSettingsBlock {
  hooks?: unknown;
}

/** Default per-hook timeout in seconds when the entry omits it. */
const DEFAULT_HOOK_TIMEOUT_SEC = 60;

/**
 * Normalize one `hooks` entry from raw JSON into a typed
 * `HookMatcherGroup`. Silently drops malformed entries — we never
 * crash startup on a bad hook block, just skip the offending item so
 * the rest of the user's config still works.
 */
function normalizeMatcherGroup(value: unknown): HookMatcherGroup | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;

  const matcher =
    typeof obj.matcher === "string" && obj.matcher.length > 0
      ? obj.matcher
      : undefined;

  if (!Array.isArray(obj.hooks)) return null;
  const hooks: HookCommand[] = [];
  for (const raw of obj.hooks) {
    if (!raw || typeof raw !== "object") continue;
    const h = raw as Record<string, unknown>;
    const type = h.type ?? "command";
    if (type !== "command") continue; // we only support command-type hooks
    if (typeof h.command !== "string" || h.command.length === 0) continue;
    const timeout =
      typeof h.timeout === "number" && Number.isFinite(h.timeout) && h.timeout > 0
        ? h.timeout
        : DEFAULT_HOOK_TIMEOUT_SEC;
    const shell = h.shell === "sh" || h.shell === "bash" ? h.shell : undefined;
    const entry: HookCommand = { type: "command", command: h.command, timeout };
    if (shell) entry.shell = shell;
    hooks.push(entry);
  }
  if (hooks.length === 0) return null;

  const group: HookMatcherGroup = { hooks };
  if (matcher) group.matcher = matcher;
  return group;
}

function normalizeHooksBlock(raw: unknown): HooksSettings {
  const result: HooksSettings = {};
  if (!raw || typeof raw !== "object") return result;
  for (const [eventName, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isHookEvent(eventName)) continue;
    if (!Array.isArray(value)) continue;
    const groups: HookMatcherGroup[] = [];
    for (const item of value) {
      const normalized = normalizeMatcherGroup(item);
      if (normalized) groups.push(normalized);
    }
    if (groups.length > 0) result[eventName] = groups;
  }
  return result;
}

async function readHooksFromSettings(filePath: string): Promise<HooksSettings> {
  const { raw } = await readJsonSettingsFile<RawSettingsBlock>(filePath);
  if (!raw) return {};
  return normalizeHooksBlock(raw.hooks);
}

function hooksFromSource(src: LoadedSource): HooksSettings {
  if (!src.raw) return {};
  return normalizeHooksBlock((src.raw as RawSettingsBlock).hooks);
}

/**
 * Load + merge hook configs across every settings source for the given cwd.
 * Per-event arrays concatenate in source order (user → project → local →
 * flag → policy), so all configured hooks fire and earlier sources run first.
 *
 * SECURITY: hooks execute arbitrary shell commands. We read from the TRUSTED
 * source set — until the user has trusted this folder, project + local hooks
 * are dropped so an untrusted repository can't run code on session start /
 * tool use. The user's own (~/.easy-agent) hooks always apply.
 */
export async function loadHooksSettings(cwd: string): Promise<HooksSettings> {
  const sources = await loadTrustedSettingSources(cwd);
  const perSource = sources.map(hooksFromSource);

  const merged: HooksSettings = {};
  for (const event of HOOK_EVENTS) {
    const groups: HookMatcherGroup[] = [];
    for (const hooks of perSource) {
      const g = hooks[event];
      if (g && g.length > 0) groups.push(...g);
    }
    if (groups.length > 0) merged[event] = groups;
  }
  return merged;
}

/**
 * Introspection helper used by the `/hooks` slash command. Returns
 * per-source views of the on-disk config (without merging), so the UI
 * can show the user WHICH settings file each hook came from. Returns
 * the absolute file paths it consulted too, so the user can `vim`
 * straight to them when they want to edit.
 */
export interface HooksDiagnosticReport {
  userPath: string;
  projectPath: string;
  userHooks: HooksSettings;
  projectHooks: HooksSettings;
  globallyDisabled: boolean;
}

export async function loadHooksDiagnosticReport(
  cwd: string,
): Promise<HooksDiagnosticReport> {
  const { user: userPath, project: projectPath } = getSettingsPaths(cwd);
  const [userHooks, projectHooks] = await Promise.all([
    readHooksFromSettings(userPath),
    readHooksFromSettings(projectPath),
  ]);
  return {
    userPath,
    projectPath,
    userHooks,
    projectHooks,
    globallyDisabled: hooksGloballyDisabled(),
  };
}

// ─── Matcher selection ────────────────────────────────────────────────

/**
 * Heuristic from source: treat a matcher as a regex iff it contains
 * any regex meta-character. Plain identifiers like "Bash" stay as
 * exact string comparisons (which short-circuits the regex compile
 * for the common case).
 *
 * NB: this is the same heuristic source uses — `|` is the most common
 * meta-char users reach for ("Bash|Edit|Write"), but `*`, `.`, `[`,
 * `(`, etc., all trigger regex mode.
 */
function isRegexMatcher(matcher: string): boolean {
  return /[*.?+()[\]{}|^$\\]/.test(matcher);
}

function matcherFires(matcher: string | undefined, matchField: string | undefined): boolean {
  // No matcher / "*" / empty → fires for everything.
  if (!matcher || matcher === "*") return true;
  // If the event has no match field but the matcher is non-trivial,
  // we err on the side of NOT firing — source does the same (matcher
  // is silently ignored for events that don't expose a match field).
  if (!matchField) return true;

  if (!isRegexMatcher(matcher)) {
    return matcher === matchField;
  }
  try {
    const re = new RegExp(`^(?:${matcher})$`);
    return re.test(matchField);
  } catch {
    return false;
  }
}

/**
 * Find all hook commands that should fire for `event` given the
 * event's match field (tool name for PreToolUse/PostToolUse, source
 * label for SessionStart, undefined for the others). Returns a flat
 * list in the order they should execute.
 */
export function findMatchingHooks(
  settings: HooksSettings,
  event: HookEvent,
  matchField?: string,
): HookCommand[] {
  const groups = settings[event];
  if (!groups || groups.length === 0) return [];
  const out: HookCommand[] = [];
  for (const group of groups) {
    if (matcherFires(group.matcher, matchField)) {
      out.push(...group.hooks);
    }
  }
  return out;
}

/**
 * Cheap "do we have ANY hook configured for this event?" check.
 * Used by the agentic loop / queryEngine to short-circuit the (cheap
 * but non-zero) JSON-stringify + spawn machinery when no user has any
 * hook in this slot — keeps the hot path free for the >99% case.
 */
export function hasHookForEvent(
  settings: HooksSettings,
  event: HookEvent,
  matchField?: string,
): boolean {
  return findMatchingHooks(settings, event, matchField).length > 0;
}

// ─── Toggle / introspection helpers ───────────────────────────────────

// Cached `disableAllHooks` settings value. Sync `hooksGloballyDisabled()` is on
// the hot path, but settings reads are async — so we snapshot the merged value
// at startup (and after `/config set`) into this flag. Mirrors source's
// `disableAllHooks`, which also gates hooks AND the statusLine.
let settingsHooksDisabled = false;

/**
 * Refresh the cached `disableAllHooks` flag from settings. Call at startup and
 * whenever settings change live (e.g. after `/config set disableAllHooks ...`).
 */
export async function refreshHookDisableFromSettings(cwd: string): Promise<void> {
  try {
    settingsHooksDisabled = await isAllHooksDisabled(cwd);
  } catch {
    // keep previous value on read failure
  }
}

/**
 * Master kill-switch. True when EITHER the `EASY_AGENT_DISABLE_HOOKS` env var is
 * truthy (mirrors source's `CLAUDE_CODE_DISABLE_HOOKS`) OR any settings source
 * sets `disableAllHooks: true`. When on, the executor returns empty for every
 * event regardless of settings.json.
 */
export function hooksGloballyDisabled(): boolean {
  if (settingsHooksDisabled) return true;
  const v = process.env.EASY_AGENT_DISABLE_HOOKS;
  if (!v) return false;
  const lower = v.toLowerCase();
  return lower === "1" || lower === "true" || lower === "yes";
}

/**
 * Empty settings constant — handed back by every higher-level helper
 * when hooks are globally disabled. Frozen so a misbehaving caller
 * can't mutate the shared singleton.
 */
export const EMPTY_HOOKS_SETTINGS: HooksSettings = Object.freeze({}) as HooksSettings;

// Re-export to keep the public surface tight at one import site.
export { HOOK_EVENTS, type HookCommand, type HookEvent, type HookMatcherGroup, type HooksSettings };
