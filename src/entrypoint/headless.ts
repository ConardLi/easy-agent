/**
 * Headless (print / pipe) mode.
 *
 * The non-interactive entry point: read a prompt from argv and/or stdin, run a
 * single session turn to completion, render the outcome to stdout in the
 * requested format, and exit with a status code derived from how the loop
 * terminated.
 *
 * It is a thin frontend over the session SDK, like the interactive UI: the
 * session is opened without a transcript, without background wake-ups, and
 * without an interactive frontend, so every confirmation gets the safe
 * default unless `--dangerously-skip-permissions` supplies an answer.
 */

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import type {
  AgentRuntime,
  InteractionHandlers,
  LoopTerminationReason,
  PermissionMode,
  SessionEvent,
  Usage,
} from "../sdk/index.js";
import { installStreamJsonStdoutGuard } from "../utils/streamJsonStdoutGuard.js";

/** Version of the public JSON / NDJSON envelope. Additive fields keep this stable. */
export const HEADLESS_SCHEMA_VERSION = 1;

/** Output formats supported in headless mode. */
export type OutputFormat = "text" | "json" | "stream-json";

export interface RunHeadlessOptions {
  /** Bootstrapped workspace runtime. */
  runtime: AgentRuntime;
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
  total_cost_usd: number | null;
  usage: Usage;
}

const EMPTY_USAGE: Usage = { input_tokens: 0, output_tokens: 0 };

function withSchemaVersion<T extends object>(message: T): T & { schema_version: typeof HEADLESS_SCHEMA_VERSION } {
  return { ...message, schema_version: HEADLESS_SCHEMA_VERSION };
}

/** Write one NDJSON line to stdout. */
function writeJsonLine(obj: object): void {
  process.stdout.write(`${JSON.stringify(withSchemaVersion(obj))}\n`);
}

/**
 * Build the `system/init` message — the first line of a stream-json session,
 * carrying the metadata a remote consumer uses to render pickers / gate UI.
 */
function buildInitMessage(params: {
  cwd: string;
  sessionId: string;
  model: string;
  permissionMode: PermissionMode;
  tools: string[];
  runtime: AgentRuntime;
}): Record<string, unknown> {
  const capabilities = params.runtime.getCapabilities();
  return {
    type: "system",
    subtype: "init",
    cwd: params.cwd,
    session_id: params.sessionId,
    model: params.model,
    permissionMode: params.permissionMode,
    tools: params.tools,
    slash_commands: capabilities.builtinCommands,
    agents: capabilities.agents,
    output_style: capabilities.outputStyle,
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
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" && block !== null && (block as { type?: string }).type === "text",
    )
    .map((block) => block.text)
    .join("");
}

/** Map how the loop ended to a `result.subtype`. */
function subtypeForReason(reason: LoopTerminationReason | undefined): ResultMessage["subtype"] {
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
    process.stderr.write('Error: no input. Provide a prompt via `-p "..."` or pipe text on stdin.\n');
    process.exit(1);
  }

  const { runtime } = options;
  const cwd = runtime.cwd;

  // The loop only asks for the `ask` outcome: settings allow/deny rules, the
  // sandbox auto-allow gate, and the Auto Mode classifier have already
  // decided by then, so those boundaries hold whatever the answer. Without a
  // frontend every ask is denied (a residual ask in auto mode comes from a
  // degrade path and must not be auto-approved either); only the explicit
  // bypass flag approves it, once.
  const handlers: InteractionHandlers | undefined = options.bypassPermissions
    ? {
        permission: () => ({ decision: "allow_once" }),
        plan_approval: () => ({ decision: "approve" }),
      }
    : undefined;

  const session = await runtime.createSession({
    ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
    interactions: [],
    ...(handlers ? { handlers } : {}),
    autoWake: false,
    persist: false,
  });
  const initial = session.getState();
  const sessionId = session.id;

  const format = options.outputFormat ?? "text";
  const startedAt = Date.now();
  const streaming = format === "stream-json";

  // stream-json: install the stdout guard BEFORE emitting anything, so a stray
  // console.log from any code path can't corrupt the NDJSON stream. Then emit
  // the init line as message #1.
  if (streaming) {
    installStreamJsonStdoutGuard();
    writeJsonLine(
      buildInitMessage({
        cwd,
        sessionId,
        model: initial.model,
        permissionMode: initial.permissionMode,
        tools: session.getToolNames(),
        runtime,
      }),
    );
  }

  let finalText = "";
  let executionError = "";
  let reason: LoopTerminationReason | undefined;
  let numTurns = 0;
  let totalUsage: Usage = { ...EMPTY_USAGE };

  const onEvent = (event: SessionEvent): void => {
    switch (event.type) {
      case "assistant_message": {
        const text = extractAssistantText(event.message);
        if (text.trim()) finalText = text;
        if (streaming) writeJsonLine({ type: "assistant", session_id: sessionId, message: event.message });
        break;
      }
      case "tool_results":
        if (streaming) writeJsonLine({ type: "user", session_id: sessionId, message: event.message });
        break;
      case "turn_completed":
        if (event.toolTurns !== undefined) numTurns = event.toolTurns;
        break;
      case "usage_changed":
        totalUsage = event.usage.total;
        break;
      case "error":
        executionError = event.message;
        // Always to stderr so it never corrupts the stdout result payload.
        process.stderr.write(`Error: ${executionError}\n`);
        break;
      default:
        break;
    }
  };

  try {
    session.subscribe(onEvent);
    const result = await session.send(input);
    reason = result.reason;
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
        total_cost_usd: null,
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
      result: finalText || executionError,
      session_id: sessionId,
      num_turns: numTurns,
      duration_ms: Date.now() - startedAt,
      // Cost accounting is not available yet. `null` distinguishes unknown
      // from a measured zero while preserving the established field name.
      total_cost_usd: null,
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
