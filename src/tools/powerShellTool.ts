import { spawn } from "node:child_process";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { readMergedEnv } from "../utils/settings.js";
import { decideSandboxExecution, loadSandboxSettings } from "../sandbox/index.js";

/**
 * PowerShell registers only on Windows. Windows process isolation is not yet
 * available through Easy Agent, so an enabled fail-closed sandbox policy
 * blocks execution instead of claiming that the command is protected.
 */
interface PowerShellInput {
  command: string;
  timeout?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 30_000;

function truncateOutput(value: string): string {
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated ${value.length - MAX_OUTPUT_CHARS} chars]`;
}

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
    },
    required: ["command"],
  },
  async call(rawInput: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const input = rawInput as unknown as PowerShellInput;
    if (!input.command) {
      return { content: "Error: command is required", isError: true };
    }
    const timeoutMs = typeof input.timeout === "number" ? input.timeout : DEFAULT_TIMEOUT_MS;

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
    return await new Promise<ToolResult>((resolve) => {
      const child = spawn(
        exe,
        ["-NoProfile", "-NonInteractive", "-Command", input.command],
        { cwd: context.cwd, env: { ...process.env, ...settingsEnv } },
      );

      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: ToolResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const timeoutId = setTimeout(() => {
        child.kill();
        finish({ content: `Command timed out after ${timeoutMs}ms`, isError: true });
      }, timeoutMs);

      const onAbort = () => {
        child.kill();
        clearTimeout(timeoutId);
        finish({ content: "Command aborted", isError: true });
      };
      context.abortSignal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (c: Buffer | string) => {
        stdout += c.toString();
      });
      child.stderr.on("data", (c: Buffer | string) => {
        stderr += c.toString();
      });
      child.on("error", (error) => {
        clearTimeout(timeoutId);
        finish({ content: `Failed to start PowerShell: ${error.message}`, isError: true });
      });
      child.on("close", (code) => {
        clearTimeout(timeoutId);
        context.abortSignal?.removeEventListener("abort", onAbort);
        const output = [
          `Command: ${input.command}`,
          `Sandbox: ${sandboxLabel}`,
          `Exit code: ${code ?? -1}`,
          stdout ? `\nSTDOUT:\n${truncateOutput(stdout)}` : "",
          stderr ? `\nSTDERR:\n${truncateOutput(stderr)}` : "",
        ].filter(Boolean).join("\n");
        finish({ content: output, isError: (code ?? 1) !== 0 });
      });
    });
  },
  isReadOnly(): boolean {
    return false;
  },
  isEnabled(): boolean {
    return process.platform === "win32";
  },
};
