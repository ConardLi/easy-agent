/**
 * Public entry point for the hooks subsystem.
 *
 * Callers should import from "src/hooks/index.js" — not from the
 * individual sub-modules — so we can refactor internals later
 * without touching the agentic loop / queryEngine.
 */

export {
  runPreToolUseHooks,
  runPostToolUseHooks,
  runUserPromptSubmitHooks,
  runSessionStartHooks,
  runStopHooks,
  runSubagentStopHooks,
  _resetHooksSettingsCache,
} from "./runHooks.js";

export {
  loadHooksSettings,
  loadHooksDiagnosticReport,
  findMatchingHooks,
  hooksGloballyDisabled,
  HOOK_EVENTS,
} from "./settings.js";
export type { HooksDiagnosticReport } from "./settings.js";

export type {
  AggregatedHookOutcome,
  HookCommand,
  HookEvent,
  HookInput,
  HookJSONOutput,
  HookMatcherGroup,
  HookResult,
  HooksSettings,
  PermissionBehavior,
  PreToolUseHookInput,
  PostToolUseHookInput,
  UserPromptSubmitHookInput,
  SessionStartHookInput,
  StopHookInput,
  SubagentStopHookInput,
} from "./types.js";
