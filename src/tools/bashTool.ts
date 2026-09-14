import { spawn } from "node:child_process";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import {
  annotateSandboxFailure,
  buildSandboxProfile,
  cleanupSandboxCommand,
  decideSandboxExecution,
  loadSandboxSettings,
  wrapWithSandbox,
  type ResolvedSandboxSettings,
  type SandboxedCommand,
} from "../sandbox/index.js";
import {
  appendBashProgress,
  completeBashProgress,
  startBashProgress,
} from "../state/bashProgressStore.js";
import { readMergedEnv } from "../utils/settings.js";
import {
  analyzeBashCommand,
} from "./bashReadOnlyAnalysis.js";

export {
  analyzeBashCommand,
  isReadOnlyCommand,
  type BashReadOnlyAnalysis,
  type BashReadOnlyAnalysisOptions,
  type BashReadOnlyReason,
  type ParsedBashCommand,
} from "./bashReadOnlyAnalysis.js";

interface BashInput {
  command: string;
  timeout?: number;
  /**
   * Per-call escape: if true AND the user's policy allows model escapes
   * (`sandbox.allowUnsandboxedCommands`), this command runs OUTSIDE the
   * sandbox even when sandboxing is enabled. The model is encouraged to
   * leave this off — see the description below.
   */
  dangerouslyDisableSandbox?: boolean;
}

/**
 * Build the SandboxProfile to feed to wrapWithSandbox(). We re-load
 * sandbox settings + permission rules on every call so that the user
 * approving a permission rule mid-session takes effect on the next
 * Bash command — no restart required.
 */
async function buildProfileForCwd(
  cwd: string,
  settings: ResolvedSandboxSettings,
) {
  // Load permission settings only when a sandbox profile is required.
  const { loadPermissionSettings } = await import("../permissions/permissions.js");
  const permissionSettings = await loadPermissionSettings(cwd);
  return buildSandboxProfile({
    cwd,
    settings,
    permissions: { allow: permissionSettings.allow, deny: permissionSettings.deny },
  });
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 30_000;

function truncateOutput(value: string): string {
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated ${value.length - MAX_OUTPUT_CHARS} chars]`;
}

export const bashTool: Tool = {
  name: "Bash",
  searchHint: "execute shell commands",
  description: "Execute a shell command in the current working directory and return stdout/stderr.",
  inputSchema: {
    type: "object" as const,
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeout: { type: "number", description: "Timeout in milliseconds (default 120000)" },
      dangerouslyDisableSandbox: {
        type: "boolean",
        description:
          "If true, run this command OUTSIDE the sandbox even when sandboxing is enabled. Only use this when the command genuinely needs unrestricted access (e.g. installing system packages, running docker, accessing devices). Most commands should run inside the sandbox.",
      },
    },
    required: ["command"],
  },
  async call(rawInput: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const input = rawInput as unknown as BashInput;
    if (!input.command) {
      return { content: "Error: command is required", isError: true };
    }
    const readOnlyAnalysis = analyzeBashCommand(input.command);

    const timeoutMs = typeof input.timeout === "number" ? input.timeout : DEFAULT_TIMEOUT_MS;

    let sandboxSettings: ResolvedSandboxSettings;
    try {
      sandboxSettings = await loadSandboxSettings(context.cwd);
    } catch (error) {
      return {
        content:
          `Sandbox configuration error: ${error instanceof Error ? error.message : String(error)}\n` +
          "Command was not executed.",
        isError: true,
      };
    }

    const sandboxDecision = decideSandboxExecution(
      {
        command: input.command,
        dangerouslyDisableSandbox: input.dangerouslyDisableSandbox,
      },
      sandboxSettings,
    );

    if (sandboxDecision.mode === "blocked") {
      return {
        content:
          `Sandbox is required but unavailable: ${sandboxDecision.reason}\n` +
          "Command was not executed. Install the required sandbox dependencies or set sandbox.failClosed to false explicitly.",
        isError: true,
      };
    }

    // Inject the merged `env` setting (trusted sources only) on top of the
    // process environment. Lets users/projects export vars (PATH additions,
    // tokens, etc.) into every command without a wrapper script. Untrusted
    // project/local env is dropped by readMergedEnv's trust gate. A bad read
    // must not block execution, so we degrade to the bare process env.
    let settingsEnv: Record<string, string> = {};
    try {
      settingsEnv = await readMergedEnv(context.cwd);
    } catch {
      settingsEnv = {};
    }

    const shell = process.env.SHELL || "bash";
    let executable = shell;
    let args = ["-lc", input.command];
    let spawnEnv: NodeJS.ProcessEnv = { ...process.env, ...settingsEnv };
    let sandboxCommand: SandboxedCommand | undefined;
    let sandboxLabel = "disabled";

    if (sandboxDecision.mode === "sandbox") {
      try {
        const profile = await buildProfileForCwd(context.cwd, sandboxSettings);
        const wrapped = await wrapWithSandbox({
          command: input.command,
          cwd: context.cwd,
          profile,
          shell,
          abortSignal: context.abortSignal,
          commandId: context.toolUseId,
        });
        const [wrappedExecutable, ...wrappedArgs] = wrapped.argv;
        if (!wrappedExecutable) throw new Error("sandbox runtime returned an empty command");
        executable = wrappedExecutable;
        args = wrappedArgs;
        spawnEnv = { ...wrapped.env, ...settingsEnv };
        sandboxCommand = wrapped;
        sandboxLabel = `enabled (${wrapped.backend})`;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (sandboxSettings.failClosed) {
          return {
            content: `Sandbox preparation failed: ${reason}\nCommand was not executed.`,
            isError: true,
          };
        }
        sandboxLabel = `unavailable (${reason})`;
      }
    } else if (sandboxDecision.mode === "fallback") {
      sandboxLabel = `unavailable (${sandboxDecision.reason})`;
    } else if (sandboxDecision.mode === "bypass") {
      sandboxLabel = `disabled (${sandboxDecision.reason})`;
    }

    if (context.abortSignal?.aborted) {
      if (sandboxCommand) cleanupSandboxCommand(sandboxCommand);
      return { content: "Command aborted", isError: true };
    }

    // Publish output only after command preparation succeeds. This prevents a
    // failed fail-closed setup from leaving a stale running indicator.
    const progressId = context.toolUseId;
    if (progressId) startBashProgress(progressId, timeoutMs);

    return await new Promise<ToolResult>((resolve) => {
      const child = spawn(executable, args, {
        cwd: context.cwd,
        env: spawnEnv,
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let sandboxCleaned = false;
      const cleanupSandbox = () => {
        if (!sandboxCommand || sandboxCleaned) return;
        sandboxCleaned = true;
        cleanupSandboxCommand(sandboxCommand);
      };

      const finish = (result: ToolResult) => {
        if (settled) return;
        settled = true;
        if (progressId) completeBashProgress(progressId);
        resolve(result);
      };

      const timeoutId = setTimeout(() => {
        child.kill("SIGTERM");
        finish({ content: `Command timed out after ${timeoutMs}ms`, isError: true });
      }, timeoutMs);

      const onAbort = () => {
        child.kill("SIGTERM");
        clearTimeout(timeoutId);
        finish({ content: "Command aborted", isError: true });
      };

      context.abortSignal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk: Buffer | string) => {
        const text = chunk.toString();
        stdout += text;
        if (progressId) appendBashProgress(progressId, text);
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        const text = chunk.toString();
        stderr += text;
        if (progressId) appendBashProgress(progressId, text);
      });
      child.on("error", (error) => {
        clearTimeout(timeoutId);
        cleanupSandbox();
        finish({ content: `Failed to start command: ${error.message}`, isError: true });
      });
      child.on("close", (code) => {
        clearTimeout(timeoutId);
        context.abortSignal?.removeEventListener("abort", onAbort);

        // Tag stderr with <sandbox_violations>...</sandbox_violations>
        // when the failure smells like a sandbox denial. The model uses
        // this signal to decide whether to retry, ask for permission,
        // or back off. The UI strips the tag before rendering.
        let annotatedStderr = stderr;
        try {
          if (sandboxCommand) {
            annotatedStderr = annotateSandboxFailure(sandboxCommand.commandId, stderr, code);
          }
        } finally {
          cleanupSandbox();
        }

        const output = [
          `Command: ${input.command}`,
          `Read-only: ${readOnlyAnalysis.isReadOnly}`,
          `Sandbox: ${sandboxLabel}`,
          `Exit code: ${code ?? -1}`,
          stdout ? `\nSTDOUT:\n${truncateOutput(stdout)}` : "",
          annotatedStderr ? `\nSTDERR:\n${truncateOutput(annotatedStderr)}` : "",
        ].filter(Boolean).join("\n");

        finish({ content: output, isError: (code ?? 1) !== 0 });
      });
    });
  },
  isReadOnly(): boolean {
    return false;
  },
  isEnabled(): boolean {
    return true;
  },
};
