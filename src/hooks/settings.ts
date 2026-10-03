import { getSettingsPaths } from "../utils/paths.js";
import { logWarn } from "../utils/log.js";
import { loadTrustedSettingSources, loadSettingSources, type LoadedSource } from "../config/sources.js";
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

/** Normalize valid commands from one matcher group. */
function normalizeMatcherGroup(value: unknown): HookMatcherGroup | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;

  const matcher = typeof obj.matcher === "string" && obj.matcher.length > 0 ? obj.matcher : undefined;

  if (!Array.isArray(obj.hooks)) return null;
  const hooks: HookCommand[] = [];
  for (const raw of obj.hooks) {
    if (!raw || typeof raw !== "object") continue;
    const h = raw as Record<string, unknown>;
    const type = h.type ?? "command";
    if (type !== "command") continue;
    if (typeof h.command !== "string" || h.command.length === 0) continue;
    const timeout =
      typeof h.timeout === "number" && Number.isFinite(h.timeout) && h.timeout > 0
        ? h.timeout
        : DEFAULT_HOOK_TIMEOUT_SEC;
    const shell =
      h.shell === "sh" || h.shell === "bash" || h.shell === "powershell" || h.shell === "pwsh" ? h.shell : undefined;
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

function hooksFromSource(src: LoadedSource): HooksSettings {
  if (!src.raw) return {};
  return normalizeHooksBlock((src.raw as RawSettingsBlock).hooks);
}

const lastValidHooks = new Map<string, HooksSettings>();
const reportedErrors = new Map<string, string>();

export function resetHooksSettingsSnapshot(): void {
  lastValidHooks.clear();
  reportedErrors.clear();
  disableBySource.clear();
  disabledByCwd.clear();
  lastRefreshedCwd = undefined;
}

function reportSettingError(key: string, error: string): void {
  if (reportedErrors.get(key) === error) return;
  logWarn(`Hooks settings in ${key} could not be updated: ${error}. Keeping the last valid configuration.`);
  reportedErrors.set(key, error);
}

function hooksShapeError(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "hooks must be an object";
  for (const [event, groups] of Object.entries(raw)) {
    if (!isHookEvent(event)) continue;
    if (!Array.isArray(groups)) return `${event} must be an array`;
    for (const group of groups) {
      if (!group || typeof group !== "object" || Array.isArray(group))
        return `${event} contains an invalid matcher group`;
      const entry = group as Record<string, unknown>;
      if (entry.matcher !== undefined && typeof entry.matcher !== "string") return `${event} has an invalid matcher`;
      if (typeof entry.matcher === "string" && entry.matcher !== "*" && isRegexMatcher(entry.matcher)) {
        try {
          new RegExp(`^(?:${entry.matcher})$`);
        } catch {
          return `${event} has an invalid matcher expression`;
        }
      }
      if (!Array.isArray(entry.hooks) || entry.hooks.length === 0) return `${event} has an invalid hooks array`;
      for (const rawHook of entry.hooks) {
        if (!rawHook || typeof rawHook !== "object" || Array.isArray(rawHook))
          return `${event} contains an invalid hook`;
        const hook = rawHook as Record<string, unknown>;
        if (hook.type !== undefined && hook.type !== "command") return `${event} contains an unsupported hook type`;
        if (typeof hook.command !== "string" || hook.command.length === 0)
          return `${event} contains a hook without a command`;
        if (
          hook.timeout !== undefined &&
          (typeof hook.timeout !== "number" || !Number.isFinite(hook.timeout) || hook.timeout <= 0)
        ) {
          return `${event} contains an invalid timeout`;
        }
        if (hook.shell !== undefined && !["bash", "sh", "powershell", "pwsh"].includes(String(hook.shell))) {
          return `${event} contains an unsupported shell`;
        }
      }
    }
  }
  return undefined;
}

function sourceHooks(src: LoadedSource): HooksSettings {
  const key = src.path ?? src.source;
  const hookValidationError = src.validationErrors?.find(
    (error) => error.includes('field "hooks"') || error.includes("settings root must be"),
  );
  const error = src.parseError ?? hookValidationError ?? hooksShapeError(src.raw?.["hooks"]);
  if (error) {
    reportSettingError(key, error);
    return lastValidHooks.get(key) ?? hooksFromSource(src);
  }

  if (!src.validationErrors?.length) reportedErrors.delete(key);
  const hooks = hooksFromSource(src);
  if (src.raw) lastValidHooks.set(key, hooks);
  else lastValidHooks.delete(key);
  return hooks;
}

/**
 * Load + merge hook configs across every settings source for the given cwd.
 * Per-event arrays concatenate in source order (user → project → local →
 * flag → policy), so all configured hooks fire and earlier sources run first.
 *
 * Project and local hooks are excluded until the project is trusted.
 */
export async function loadHooksSettings(cwd: string): Promise<HooksSettings> {
  const sources = await loadTrustedSettingSources(cwd);
  const perSource = sources.map(sourceHooks);

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

/** Current user and project Hook configuration for `/hooks`. */
export interface HooksDiagnosticReport {
  userPath: string;
  projectPath: string;
  userHooks: HooksSettings;
  projectHooks: HooksSettings;
  errors: string[];
  globallyDisabled: boolean;
}

export async function loadHooksDiagnosticReport(cwd: string): Promise<HooksDiagnosticReport> {
  await refreshHookDisableFromSettings(cwd);
  const { user: userPath, project: projectPath } = getSettingsPaths(cwd);
  const sources = await loadSettingSources(cwd);
  const user = sources.find((source) => source.source === "user");
  const project = sources.find((source) => source.source === "project");
  const userHooks = user ? sourceHooks(user) : {};
  const projectHooks = project ? sourceHooks(project) : {};
  const errors = [user, project].flatMap((source) =>
    source
      ? [source.parseError, ...(source.validationErrors ?? []), hooksShapeError(source.raw?.["hooks"])].filter(
          (error): error is string => Boolean(error),
        )
      : [],
  );
  return {
    userPath,
    projectPath,
    userHooks,
    projectHooks,
    errors,
    globallyDisabled: hooksGloballyDisabled(cwd),
  };
}

// ─── Matcher selection ────────────────────────────────────────────────

/** Plain identifiers match exactly; patterns with regex syntax are compiled. */
function isRegexMatcher(matcher: string): boolean {
  return /[*.?+()[\]{}|^$\\]/.test(matcher);
}

function matcherFires(matcher: string | undefined, matchField: string | undefined): boolean {
  // No matcher / "*" / empty → fires for everything.
  if (!matcher || matcher === "*") return true;
  // Events without a match field ignore the matcher.
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
export function findMatchingHooks(settings: HooksSettings, event: HookEvent, matchField?: string): HookCommand[] {
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
export function hasHookForEvent(settings: HooksSettings, event: HookEvent, matchField?: string): boolean {
  return findMatchingHooks(settings, event, matchField).length > 0;
}

// ─── Toggle / introspection helpers ───────────────────────────────────

const disableBySource = new Map<string, boolean>();
const disabledByCwd = new Map<string, boolean>();
let lastRefreshedCwd: string | undefined;

/** Refresh the per-directory disable state from current settings. */
export async function refreshHookDisableFromSettings(cwd: string): Promise<void> {
  try {
    const sources = await loadSettingSources(cwd);
    let disabled = false;
    for (const src of sources) {
      const key = src.path ?? src.source;
      const disableValidationError = src.validationErrors?.find(
        (error) => error.includes('field "disableAllHooks"') || error.includes("settings root must be"),
      );
      const error = src.parseError ?? disableValidationError;
      if (error) reportSettingError(key, error);
      else if (!src.validationErrors?.length && !hooksShapeError(src.raw?.["hooks"])) reportedErrors.delete(key);
      if (!error) disableBySource.set(key, src.raw?.["disableAllHooks"] === true);
      if (disableBySource.get(key)) disabled = true;
    }
    disabledByCwd.set(cwd, disabled);
    lastRefreshedCwd = cwd;
  } catch {
    // Keep the last effective value on read failure.
  }
}

/** Environment and settings kill switch for command hooks. */
export function hooksGloballyDisabled(cwd?: string): boolean {
  if (disabledByCwd.get(cwd ?? lastRefreshedCwd ?? "")) return true;
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
