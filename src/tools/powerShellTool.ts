import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { readMergedEnv } from "../utils/settings.js";
import { decideSandboxExecution, loadSandboxSettings } from "../sandbox/index.js";
import { formatCapturedOutput, runControlledProcess } from "../utils/controlledProcess.js";

/**
 * PowerShell registers only on Windows. Windows process isolation is not yet
 * available through Easy Agent, so an enabled fail-closed sandbox policy
 * blocks execution instead of claiming that the command is protected.
 */
interface PowerShellInput {
  command: string;
  timeout?: number;
  idleTimeout?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 30_000;

function resolveExecutable(): string {
  // pwsh (PowerShell 7+) if explicitly requested; default to Windows PowerShell.
  return process.env.EASY_AGENT_POWERSHELL || "powershell.exe";
}

export const powerShellTool: Tool = {
  name: "PowerShell",
  searchHint: "execute Windows PowerShell commands",
  description:
    "Execute a PowerShell command on Windows and return stdout/stderr. Use this instead of Bash on Windows.",
  inputSchema: {
    type: "object" as const,
    properties: {
      command: { type: "string", description: "PowerShell command to execute" },
      timeout: { type: "number", description: "Timeout in milliseconds (default 120000)" },
      idleTimeout: { type: "number", description: "Stop after this many milliseconds without output (default: command timeout)" },
    },
    required: ["command"],
  },
  async call(rawInput: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const input = rawInput as unknown as PowerShellInput;
    if (!input.command) {
      return { content: "Error: command is required", isError: true };
    }
    const timeoutMs = typeof input.timeout === "number" ? input.timeout : DEFAULT_TIMEOUT_MS;
    const idleTimeoutMs = typeof input.idleTimeout === "number" ? input.idleTimeout : timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0) {
      return { content: "Error: timeout and idleTimeout must be positive integer milliseconds", isError: true };
    }

    let sandboxLabel = "disabled";
    try {
      const sandboxSettings = await loadSandboxSettings(context.cwd);
      const sandboxDecision = decideSandboxExecution({ command: input.command }, sandboxSettings);
      if (sandboxDecision.mode === "blocked") {
        return {
          content:
            `Sandbox is required but unavailable: ${sandboxDecision.reason}\n` +
            "PowerShell was not executed. Set sandbox.failClosed to false explicitly to use normal permission checks on Windows.",
          isError: true,
        };
      }
      if (sandboxDecision.mode === "fallback") {
        sandboxLabel = `unavailable (${sandboxDecision.reason})`;
      }
    } catch (error) {
      return {
        content:
          `Sandbox configuration error: ${error instanceof Error ? error.message : String(error)}\n` +
          "PowerShell was not executed.",
        isError: true,
      };
    }

    let settingsEnv: Record<string, string> = {};
    try {
      settingsEnv = await readMergedEnv(context.cwd);
    } catch {
      settingsEnv = {};
    }

    const exe = resolveExecutable();
    try {
      const run = await runControlledProcess({
        executable: exe,
        args: ["-NoProfile", "-NonInteractive", "-Command", input.command],
        cwd: context.cwd,
        env: { ...process.env, ...settingsEnv },
        signal: context.abortSignal,
        timeoutMs,
        idleTimeoutMs,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      });
      if (run.reason === "aborted") return { content: "Command aborted", isError: true };
      if (run.reason === "timeout") return { content: `Command timed out after ${timeoutMs}ms`, isError: true };
      if (run.reason === "idle_timeout") return { content: `Command idle for ${idleTimeoutMs}ms`, isError: true };
      if (run.spawnError) return { content: `Failed to start PowerShell: ${run.spawnError.message}`, isError: true };
      const output = [
        `Command: ${input.command}`,
        `Sandbox: ${sandboxLabel}`,
        `Exit code: ${run.exitCode ?? -1}`,
        run.signal ? `Signal: ${run.signal}` : "",
        run.stdout ? `\nSTDOUT:\n${formatCapturedOutput(run.stdout, run.stdoutOmittedBytes)}` : "",
        run.stderr ? `\nSTDERR:\n${formatCapturedOutput(run.stderr, run.stderrOmittedBytes)}` : "",
      ].filter(Boolean).join("\n");
      return { content: output, isError: (run.exitCode ?? 1) !== 0 };
    } catch (error) {
      return { content: `Failed to run PowerShell: ${error instanceof Error ? error.message : String(error)}`, isError: true };
    }
  },
  isReadOnly(): boolean {
    return false;
  },
  isEnabled(): boolean {
    return process.platform === "win32";
  },
};
