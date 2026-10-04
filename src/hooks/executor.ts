import { randomUUID } from "node:crypto";
import { formatCapturedOutput, runControlledProcess } from "../utils/controlledProcess.js";
import type { HookCommand, HookEvent, HookInput, HookJSONOutput, HookResult } from "./types.js";

const DEFAULT_TIMEOUT_SEC = 60;
const MAX_HOOK_OUTPUT_BYTES = 64 * 1024;

function resolveShell(hook: HookCommand): { executable: string; args: string[] } {
  const shell = hook.shell ?? (process.platform === "win32" ? "powershell" : "bash");
  if (shell === "powershell" || shell === "pwsh") {
    return {
      executable: shell === "powershell" && process.platform === "win32" ? "powershell.exe" : shell,
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", hook.command],
    };
  }
  return { executable: shell, args: ["-c", hook.command] };
}

async function runShellCommand(
  hook: HookCommand,
  jsonInput: string,
  signal: AbortSignal | undefined,
  cwd: string,
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  aborted: boolean;
  timedOut: boolean;
  outputTruncated: boolean;
  durationMs: number;
}> {
  const shell = resolveShell(hook);
  const timeoutMs = (hook.timeout ?? DEFAULT_TIMEOUT_SEC) * 1000;
  const startedAt = Date.now();
  try {
    const run = await runControlledProcess({
      executable: shell.executable,
      args: shell.args,
      cwd,
      env: {
        ...process.env,
        EASY_AGENT_PROJECT_DIR: cwd,
        ...(hook.env ?? {}),
      },
      stdin: jsonInput,
      signal,
      timeoutMs,
      idleTimeoutMs: timeoutMs,
      maxOutputBytes: MAX_HOOK_OUTPUT_BYTES,
    });
    return {
      stdout: formatCapturedOutput(run.stdout, run.stdoutOmittedBytes),
      stderr: run.spawnError
        ? `Hook spawn failed: ${run.spawnError.message}`
        : run.stdinError && !run.stderr
          ? `Hook stdin failed: ${run.stdinError.message}`
          : formatCapturedOutput(run.stderr, run.stderrOmittedBytes),
      exitCode: run.exitCode ?? (run.reason === "aborted" ? 130 : 1),
      aborted: run.reason === "aborted",
      timedOut: run.reason === "timeout" || run.reason === "idle_timeout",
      outputTruncated: run.stdoutTruncated || run.stderrTruncated,
      durationMs: run.durationMs,
    };
  } catch (error) {
    return {
      stdout: "",
      stderr: `Hook execution failed: ${error instanceof Error ? error.message : String(error)}`,
      exitCode: 1,
      aborted: false,
      timedOut: false,
      outputTruncated: false,
      durationMs: Date.now() - startedAt,
    };
  }
}

// ─── Output parsing + interpretation ──────────────────────────────────

/**
 * Try to parse stdout as JSON. Returns the parsed object if it looks
 * like a hook output payload (an object — primitives don't count);
 * otherwise undefined and the caller treats stdout as plain text.
 *
 * We do NOT throw on parse failure — many hooks legitimately return
 * plain text (e.g. `git status -s` for SessionStart context injection).
 */
function tryParseJsonOutput(stdout: string): HookJSONOutput | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as HookJSONOutput;
    }
  } catch {
    // Not JSON — treat as plain text.
  }
  return undefined;
}

/** Decode a JSON hook response into the runtime decision fields. */
function decodeJsonOutput(json: HookJSONOutput, hookEvent: HookEvent, commandLabel: string): Partial<HookResult> {
  const out: Partial<HookResult> = {};

  // ─── Continue / stop the loop ─────────────────────────────────────
  if (json.continue === false) {
    out.preventContinuation = true;
    if (json.stopReason) out.stopReason = json.stopReason;
  }

  // ─── Top-level decision ──────────────────────────────────────────
  if (json.decision === "approve") {
    out.permissionBehavior = "allow";
  } else if (json.decision === "block") {
    out.permissionBehavior = "deny";
    out.blockingError = json.reason || `Blocked by ${hookEvent} hook (${commandLabel})`;
  }

  if (json.systemMessage) out.systemMessage = json.systemMessage;

  // ─── hookSpecificOutput overrides (most specific, runs last) ─────
  const spec = json.hookSpecificOutput;
  if (spec) {
    if (spec.hookEventName && spec.hookEventName !== hookEvent) {
      // Keep processing the response to preserve its decision fields.
    }

    if (hookEvent === "PreToolUse" && spec.permissionDecision) {
      switch (spec.permissionDecision) {
        case "allow":
          out.permissionBehavior = "allow";
          break;
        case "ask":
          out.permissionBehavior = "ask";
          break;
        case "deny":
          out.permissionBehavior = "deny";
          out.blockingError =
            spec.permissionDecisionReason || json.reason || `Blocked by PreToolUse hook (${commandLabel})`;
          break;
      }
      if (spec.permissionDecisionReason) {
        out.permissionDecisionReason = spec.permissionDecisionReason;
      }
    }

    if (spec.additionalContext && typeof spec.additionalContext === "string") {
      out.additionalContext = spec.additionalContext;
    }
  }

  if (out.permissionBehavior !== undefined && out.permissionDecisionReason === undefined && json.reason) {
    out.permissionDecisionReason = json.reason;
  }

  return out;
}

// ─── Public entry point ───────────────────────────────────────────────

/**
 * Run one hook end-to-end and return a fully decoded HookResult.
 * Never throws — every failure path is captured into the returned
 * `outcome` + `stderr` fields so the caller can render them.
 */
export async function executeHookCommand(params: {
  hook: HookCommand;
  hookEvent: HookEvent;
  hookName: string;
  hookInput: HookInput;
  cwd: string;
  signal?: AbortSignal;
}): Promise<HookResult> {
  const { hook, hookEvent, hookName, hookInput, cwd, signal } = params;
  const jsonInput = JSON.stringify(hookInput);
  const commandLabel = hook.command;

  const run = await runShellCommand(hook, jsonInput, signal, cwd);

  // ─── Aborted by signal (parent loop interrupted) ─────────────────
  if (run.aborted) {
    return {
      hookName,
      command: commandLabel,
      durationMs: run.durationMs,
      outcome: "cancelled",
      stdout: run.stdout,
      stderr: run.stderr || "Hook cancelled before completion",
      exitCode: run.exitCode,
    };
  }

  // ─── Timeout (synthesize a non-blocking error) ───────────────────
  if (run.timedOut) {
    return {
      hookName,
      command: commandLabel,
      durationMs: run.durationMs,
      outcome: "non_blocking_error",
      stdout: run.stdout,
      stderr: run.stderr || `Hook timed out after ${hook.timeout ?? DEFAULT_TIMEOUT_SEC}s`,
      exitCode: run.exitCode,
    };
  }

  if (run.outputTruncated) {
    const detail = `Hook output exceeded ${MAX_HOOK_OUTPUT_BYTES} bytes per stream; output was truncated.`;
    const blocking = run.exitCode === 2 || hookEvent === "PreToolUse";
    return {
      hookName,
      command: commandLabel,
      durationMs: run.durationMs,
      outcome: blocking ? "blocking" : "non_blocking_error",
      stdout: run.stdout,
      stderr: [run.stderr, detail].filter(Boolean).join("\n"),
      exitCode: run.exitCode,
      ...(blocking ? { permissionBehavior: "deny" as const, blockingError: detail } : {}),
    };
  }

  // ─── JSON output path (richer control) ───────────────────────────
  const json = tryParseJsonOutput(run.stdout);
  if (json) {
    const decoded = decodeJsonOutput(json, hookEvent, commandLabel);
    // Exit code 2 takes precedence over a JSON approval.
    if (run.exitCode === 2 && !decoded.blockingError) {
      decoded.blockingError = run.stderr.trim() || `Hook returned exit code 2 (${commandLabel})`;
      decoded.permissionBehavior ??= "deny";
    }
    const outcome: HookResult["outcome"] = decoded.blockingError
      ? "blocking"
      : run.exitCode === 0
        ? "success"
        : "non_blocking_error";
    return {
      hookName,
      command: commandLabel,
      durationMs: run.durationMs,
      outcome,
      stdout: run.stdout,
      stderr: run.stderr,
      exitCode: run.exitCode,
      ...decoded,
    };
  }

  // ─── Plain-text path (no JSON) ───────────────────────────────────
  if (run.exitCode === 0) {
    // Successful plain text from these events becomes model context.
    const stdoutTrimmed = run.stdout.trim();
    const additionalContext =
      stdoutTrimmed && (hookEvent === "UserPromptSubmit" || hookEvent === "SessionStart" || hookEvent === "PostToolUse")
        ? stdoutTrimmed
        : undefined;
    return {
      hookName,
      command: commandLabel,
      durationMs: run.durationMs,
      outcome: "success",
      stdout: run.stdout,
      stderr: run.stderr,
      exitCode: run.exitCode,
      ...(additionalContext ? { additionalContext } : {}),
    };
  }

  if (run.exitCode === 2) {
    // Exit code 2 blocks the action.
    return {
      hookName,
      command: commandLabel,
      durationMs: run.durationMs,
      outcome: "blocking",
      stdout: run.stdout,
      stderr: run.stderr,
      exitCode: run.exitCode,
      permissionBehavior: "deny",
      blockingError: run.stderr.trim() || `Hook returned exit code 2 (${commandLabel})`,
    };
  }

  // Any other non-zero — surface as a warning, but don't block.
  return {
    hookName,
    command: commandLabel,
    durationMs: run.durationMs,
    outcome: "non_blocking_error",
    stdout: run.stdout,
    stderr: run.stderr || `Hook exited with code ${run.exitCode}`,
    exitCode: run.exitCode,
  };
}

/**
 * Generate a fresh tool-use-id-like correlator. Used as the hook
 * payload's `tool_use_id` field when the caller doesn't already have
 * one (UserPromptSubmit / SessionStart / Stop).
 */
export function newHookCorrelationId(): string {
  return randomUUID();
}
