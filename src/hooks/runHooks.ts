import {
  hooksGloballyDisabled,
  loadHooksSettings,
  findMatchingHooks,
  resetHooksSettingsSnapshot,
  refreshHookDisableFromSettings,
} from "./settings.js";
import { executeHookCommand, newHookCorrelationId } from "./executor.js";
import { getActivePluginHooks } from "../plugins/runtime.js";
import { HOOK_EVENTS } from "./types.js";
import type { AggregatedHookOutcome, HookEvent, HookInput, HookResult, HooksSettings } from "./types.js";

async function getSettings(cwd: string): Promise<HooksSettings> {
  const base = await loadHooksSettings(cwd);
  return mergePluginHooks(base, getActivePluginHooks());
}

/** Concatenate two HooksSettings per event (left first, then right). */
function mergePluginHooks(base: HooksSettings, plugin: HooksSettings): HooksSettings {
  const merged: HooksSettings = {};
  for (const event of HOOK_EVENTS) {
    const groups = [...(base[event] ?? []), ...(plugin[event] ?? [])];
    if (groups.length > 0) merged[event] = groups;
  }
  return merged;
}

export function _resetHooksSettingsCache(): void {
  resetHooksSettingsSnapshot();
}

// ─── Aggregator ───────────────────────────────────────────────────────

/**
 * Roll up an array of per-hook results into one decision the caller
 * can act on. Precedence:
 *
 *   permissionBehavior   deny > ask > allow
 *   blockingError        first hook to set it wins
 *   preventContinuation  any hook can trigger it
 *   additionalContext    all hooks' contexts concatenate (in order)
 *   systemMessage        all hooks' messages concatenate
 */
function aggregate(results: HookResult[]): AggregatedHookOutcome {
  const out: AggregatedHookOutcome = { results };

  const PERM_PRIORITY: Record<NonNullable<HookResult["permissionBehavior"]>, number> = {
    deny: 3,
    ask: 2,
    allow: 1,
  };

  let bestPerm: HookResult["permissionBehavior"] | undefined;
  let bestPermReason: string | undefined;
  const contexts: string[] = [];
  const sysMessages: string[] = [];

  for (const r of results) {
    if (r.permissionBehavior) {
      const cur = bestPerm ? PERM_PRIORITY[bestPerm] : 0;
      const next = PERM_PRIORITY[r.permissionBehavior];
      if (next > cur) {
        bestPerm = r.permissionBehavior;
        bestPermReason = r.permissionDecisionReason;
      }
    }
    if (r.blockingError && !out.blockingError) {
      out.blockingError = r.blockingError;
    }
    if (r.preventContinuation) {
      out.preventContinuation = true;
      out.stopReason ??= r.stopReason;
    }
    if (r.additionalContext) contexts.push(r.additionalContext);
    if (r.systemMessage) sysMessages.push(r.systemMessage);
  }

  if (bestPerm) {
    out.permissionBehavior = bestPerm;
    if (bestPermReason) out.permissionDecisionReason = bestPermReason;
  }
  if (contexts.length > 0) out.additionalContext = contexts.join("\n\n");
  if (sysMessages.length > 0) out.systemMessage = sysMessages.join("\n\n");

  return out;
}

// ─── Common runner ────────────────────────────────────────────────────

async function runHooksForEvent(params: {
  event: HookEvent;
  matchField?: string;
  hookInput: HookInput;
  cwd: string;
  signal?: AbortSignal;
}): Promise<AggregatedHookOutcome> {
  await refreshHookDisableFromSettings(params.cwd);
  if (hooksGloballyDisabled(params.cwd)) {
    return { results: [] };
  }

  const settings = await getSettings(params.cwd);
  const hooks = findMatchingHooks(settings, params.event, params.matchField);
  if (hooks.length === 0) return { results: [] };

  const matchLabel = params.matchField ? `:${params.matchField}` : "";
  const hookName = `${params.event}${matchLabel}`;

  // Each hook has its own timeout; Promise.all preserves configuration order.
  const settled = await Promise.all(
    hooks.map((hook) =>
      executeHookCommand({
        hook,
        hookEvent: params.event,
        hookName,
        hookInput: params.hookInput,
        cwd: params.cwd,
        signal: params.signal,
      }),
    ),
  );

  return aggregate(settled);
}

// ─── Per-event entry points ───────────────────────────────────────────

export async function runPreToolUseHooks(params: {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
  cwd: string;
  sessionId?: string;
  signal?: AbortSignal;
}): Promise<AggregatedHookOutcome> {
  return runHooksForEvent({
    event: "PreToolUse",
    matchField: params.toolName,
    cwd: params.cwd,
    signal: params.signal,
    hookInput: {
      hook_event_name: "PreToolUse",
      session_id: params.sessionId ?? "",
      cwd: params.cwd,
      tool_name: params.toolName,
      tool_input: params.toolInput,
      tool_use_id: params.toolUseId,
    },
  });
}

export async function runPostToolUseHooks(params: {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResponse: unknown;
  toolUseId: string;
  cwd: string;
  sessionId?: string;
  signal?: AbortSignal;
}): Promise<AggregatedHookOutcome> {
  return runHooksForEvent({
    event: "PostToolUse",
    matchField: params.toolName,
    cwd: params.cwd,
    signal: params.signal,
    hookInput: {
      hook_event_name: "PostToolUse",
      session_id: params.sessionId ?? "",
      cwd: params.cwd,
      tool_name: params.toolName,
      tool_input: params.toolInput,
      tool_response: params.toolResponse,
      tool_use_id: params.toolUseId,
    },
  });
}

export async function runUserPromptSubmitHooks(params: {
  prompt: string;
  cwd: string;
  sessionId?: string;
  signal?: AbortSignal;
}): Promise<AggregatedHookOutcome> {
  return runHooksForEvent({
    event: "UserPromptSubmit",
    cwd: params.cwd,
    signal: params.signal,
    hookInput: {
      hook_event_name: "UserPromptSubmit",
      session_id: params.sessionId ?? "",
      cwd: params.cwd,
      prompt: params.prompt,
    },
  });
}

export async function runSessionStartHooks(params: {
  source: "startup" | "resume" | "clear" | "compact";
  cwd: string;
  sessionId?: string;
  signal?: AbortSignal;
}): Promise<AggregatedHookOutcome> {
  return runHooksForEvent({
    event: "SessionStart",
    matchField: params.source,
    cwd: params.cwd,
    signal: params.signal,
    hookInput: {
      hook_event_name: "SessionStart",
      session_id: params.sessionId ?? "",
      cwd: params.cwd,
      source: params.source,
    },
  });
}

export async function runStopHooks(params: {
  lastAssistantMessage?: string;
  cwd: string;
  sessionId?: string;
  signal?: AbortSignal;
}): Promise<AggregatedHookOutcome> {
  return runHooksForEvent({
    event: "Stop",
    cwd: params.cwd,
    signal: params.signal,
    hookInput: {
      hook_event_name: "Stop",
      session_id: params.sessionId ?? "",
      cwd: params.cwd,
      ...(params.lastAssistantMessage ? { last_assistant_message: params.lastAssistantMessage } : {}),
    },
  });
}

export async function runSubagentStopHooks(params: {
  agentId: string;
  agentType: string;
  lastAssistantMessage?: string;
  cwd: string;
  sessionId?: string;
  signal?: AbortSignal;
}): Promise<AggregatedHookOutcome> {
  return runHooksForEvent({
    event: "SubagentStop",
    matchField: params.agentType,
    cwd: params.cwd,
    signal: params.signal,
    hookInput: {
      hook_event_name: "SubagentStop",
      session_id: params.sessionId ?? "",
      cwd: params.cwd,
      agent_id: params.agentId,
      agent_type: params.agentType,
      ...(params.lastAssistantMessage ? { last_assistant_message: params.lastAssistantMessage } : {}),
    },
  });
}

// Re-export the correlation-id helper for callers that need to mint
// their own tool_use_id (e.g. tests).
export { newHookCorrelationId };
