/**
 * Headless (print / pipe) mode — Stage 28a–28c.
 *
 * The non-interactive entry point: read a prompt from argv and/or stdin, run a
 * single QueryEngine turn to completion, render the outcome to stdout in the
 * requested format, and exit with a status code derived from how the loop
 * terminated.
 *
 * This is the SDK-style entry: the whole Agentic Loop wrapped as a
 * stdin→stdout function for CI/CD, git hooks, and other-program integration.
 * It is a *second consumer* of the same QueryEngine event stream the REPL
 * (useAgentSession) consumes — no core-layer changes required.
 *
 * Reference: claude-code-source-code/src/cli/print.ts (runHeadless).
 */

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { QueryEngine } from "../core/queryEngine.js";
import type { LoopTerminationReason } from "../core/agenticLoop.js";
import {
  loadPermissionSettings,
  type PermissionDecision,
  type PermissionMode,
} from "../permissions/permissions.js";
import type { ToolContext } from "../tools/Tool.js";
import type { Usage } from "../types/message.js";
import { createSessionId } from "../session/storage.js";
import { DEFAULT_MODEL } from "../services/api/client.js";
import { readMergedStringSetting } from "../utils/settings.js";
import { getToolsApiParams } from "../tools/index.js";
import { BUILTIN_COMMAND_NAMES } from "../commands/builtinCommandNames.js";
import { getAllAgents } from "../agents/registry.js";
import { getActiveOutputStyleName } from "../styles/registry.js";
import { installStreamJsonStdoutGuard } from "../utils/streamJsonStdoutGuard.js";

/** Output formats supported in headless mode. */
export type OutputFormat = "text" | "json" | "stream-json";

export interface RunHeadlessOptions {
  /** The prompt given as a positional/`-p` argument (may be empty). */
  promptArg?: string;
  /** Permission mode parsed from argv (`--auto` / `--plan` / `--permission-mode`). */
  permissionMode?: PermissionMode;
  /**
   * `--dangerously-skip-permissions` (bypass). When true, any tool call that
   * would otherwise prompt for confirmation (`ask`) is auto-approved. Unlike
   * `--auto`, the permission mode stays `default`, so explicit `deny` rules in
   * settings.json are still enforced — bypass only collapses the interactive
   * `ask` step, not the security boundary.
   */
  bypassPermissions?: boolean;
  /** `--output-format` (defaults to `text`). */
  outputFormat?: OutputFormat;
}

/** The `result` SDK message — the single object emitted by `--output-format json`. */
interface ResultMessage {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_during_execution";
  is_error: boolean;
  result: string;
  session_id: string;
  num_turns: number;
  duration_ms: number;
  total_cost_usd: number;
  usage: Usage;
}

const EMPTY_USAGE: Usage = { input_tokens: 0, output_tokens: 0 };

/** Write one NDJSON line to stdout. */
function writeJsonLine(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

/**
 * Build the `system/init` message — the first line of a stream-json session,
 * carrying the metadata a remote consumer uses to render pickers / gate UI.
 * Mirrors source's `buildSystemInitMessage` (trimmed to fields Easy Agent has).
 */
function buildInitMessage(params: {
  cwd: string;
  sessionId: string;
  model: string;
  permissionMode: PermissionMode;
}): Record<string, unknown> {
  return {
    type: "system",
    subtype: "init",
    cwd: params.cwd,
    session_id: params.sessionId,
    model: params.model,
    permissionMode: params.permissionMode,
    tools: getToolsApiParams(params.permissionMode).map((t) => t.name),
    slash_commands: [...BUILTIN_COMMAND_NAMES].sort(),
    agents: getAllAgents().map((a) => a.agentType),
    output_style: getActiveOutputStyleName(),
  };
}

/**
 * Read all of stdin as a UTF-8 string. Returns "" immediately when stdin is a
 * TTY (interactive terminal, no piped data) so `-p "prompt"` without a pipe
 * doesn't hang waiting for EOF.
 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  return new Promise<string>((resolve, reject) => {
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);
  });
}

/**
 * Merge the piped stdin and the prompt argument into a single input. When both
 * are present the stdin content is treated as context and placed before the
 * instruction, mirroring `cat file.ts | agent -p "explain this code"`.
 */
function mergeInput(stdin: string, promptArg: string): string {
  const s = stdin.trim();
  const p = promptArg.trim();
  if (s && p) return `${s}\n\n${p}`;
  return s || p;
}

/** Extract the concatenated text from an assistant message's content. */
function extractAssistantText(message: MessageParam): string {
  const { content } = message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null && (block as { type?: string }).type === "text",
    )
    .map((block) => block.text)
    .join("");
}

/** Map how the loop ended to a `result.subtype`. */
function subtypeForReason(
  reason: LoopTerminationReason | undefined,
): ResultMessage["subtype"] {
  if (reason === "completed") return "success";
  if (reason === "max_turns") return "error_max_turns";
  // aborted / model_error / blocking_limit / undefined → generic execution error
  return "error_during_execution";
}

/** Map how the loop ended to a process exit code (0 = clean success). */
function exitCodeForReason(reason: LoopTerminationReason | undefined): number {
  return reason === "completed" ? 0 : 1;
}

/**
 * Run one headless turn and exit the process. Never returns normally — always
 * calls `process.exit` with the resolved status code.
 */
export async function runHeadless(options: RunHeadlessOptions): Promise<void> {
  const stdin = await readStdin();
  const input = mergeInput(stdin, options.promptArg ?? "");

  if (!input) {
    process.stderr.write(
      "Error: no input. Provide a prompt via `-p \"...\"` or pipe text on stdin.\n",
    );
    process.exit(1);
  }

  const cwd = process.cwd();
  const sessionId = createSessionId();

  const permissionSettings = await loadPermissionSettings(cwd);
  const resolvedModel =
    (await readMergedStringSetting(cwd, "model").catch(() => undefined)) ??
    (await readMergedStringSetting(cwd, "defaultModel").catch(() => undefined)) ??
    DEFAULT_MODEL;
  const effectiveMode = options.permissionMode ?? permissionSettings.mode;

  const toolContext: ToolContext = {
    cwd,
    sessionId,
    // No interactive frontend in headless mode: AskUserQuestion resolves null
    // so the awaiting tool call unblocks instead of hanging.
    requestUserQuestion: async () => null,
  };

  // Mode-aware non-interactive permission policy. The loop only invokes this
  // callback for the `ask` outcome — settings `allow`/`deny` rules, the sandbox
  // auto-allow gate, AND the auto-mode AI classifier are resolved earlier by
  // `checkPermission`, so those security boundaries always hold regardless of
  // what we return here.
  //
  //   - default / plan                   → `deny` (never block waiting for a TTY)
  //   - auto                             → `deny` (Stage 29 alignment: in auto
  //       mode the classifier already returns allow/deny directly; a residual
  //       `ask` only comes from a degrade path — classifier blocked-too-often /
  //       unavailable / EnterPlanMode — which must NOT be auto-approved here)
  //   - --dangerously-skip-permissions   → `allow_once` (explicit bypass only)
  //
  // i.e. only the explicit bypass flag auto-approves; `--auto` no longer means
  // "allow everything" (it means "let the classifier decide").
  const autoApprove = options.bypassPermissions === true;
  const onPermissionRequest = async (): Promise<PermissionDecision> =>
    autoApprove ? "allow_once" : "deny";

  const engine = new QueryEngine({
    model: resolvedModel,
    toolContext,
    permissionMode: effectiveMode,
    permissionSettings,
    onPermissionRequest,
  });

  const format = options.outputFormat ?? "text";
  const startedAt = Date.now();
  const streaming = format === "stream-json";

  // stream-json: install the stdout guard BEFORE emitting anything, so a stray
  // console.log from any code path can't corrupt the NDJSON stream. Then emit
  // the init line as message #1.
  if (streaming) {
    installStreamJsonStdoutGuard();
    writeJsonLine(buildInitMessage({ cwd, sessionId, model: resolvedModel, permissionMode: effectiveMode }));
  }

  let finalText = "";
  let reason: LoopTerminationReason | undefined;
  let numTurns = 0;
  let totalUsage: Usage = { ...EMPTY_USAGE };

  try {
    const run = engine.submitMessage(input);
    while (true) {
      const { value, done } = await run.next();
      if (done) {
        reason = value.reason;
        break;
      }
      switch (value.type) {
        case "assistant_message": {
          const text = extractAssistantText(value.message);
          if (text.trim()) finalText = text;
          if (streaming) writeJsonLine({ type: "assistant", session_id: sessionId, message: value.message });
          break;
        }
        case "tool_result_message":
          if (streaming) writeJsonLine({ type: "user", session_id: sessionId, message: value.message });
          break;
        case "turn_complete":
          numTurns = value.turnCount;
          break;
        case "usage_updated":
          totalUsage = value.totalUsage;
          break;
        case "error":
          // Always to stderr so it never corrupts the stdout result payload.
          process.stderr.write(`Error: ${value.error.message}\n`);
          break;
        default:
          break;
      }
    }
  } catch (error) {
    // A thrown error never produced a clean result. The structured formats
    // (json / stream-json) still emit a valid `result` line so programmatic
    // consumers get something parseable; text mode falls back to stderr.
    const message = error instanceof Error ? error.message : String(error);
    if (format !== "text") {
      const errResult: ResultMessage = {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: message,
        session_id: sessionId,
        num_turns: numTurns,
        duration_ms: Date.now() - startedAt,
        total_cost_usd: 0,
        usage: totalUsage,
      };
      writeJsonLine(errResult);
    } else {
      process.stderr.write(`Fatal: ${message}\n`);
    }
    process.exit(1);
  }

  // Structured formats: emit the final `result` as the last message. For
  // stream-json it terminates the NDJSON stream; for json it's the sole output.
  if (format !== "text") {
    const result: ResultMessage = {
      type: "result",
      subtype: subtypeForReason(reason),
      is_error: reason !== "completed",
      result: finalText,
      session_id: sessionId,
      num_turns: numTurns,
      duration_ms: Date.now() - startedAt,
      // We don't price tokens yet; surface 0 to keep the field stable for
      // consumers (a later stage can wire real cost accounting).
      total_cost_usd: 0,
      usage: totalUsage,
    };
    writeJsonLine(result);
    process.exit(exitCodeForReason(reason));
  }

  // text (default): only the final assistant text, with a trailing newline.
  const out = finalText.endsWith("\n") ? finalText : `${finalText}\n`;
  process.stdout.write(out);
  process.exit(exitCodeForReason(reason));
}
