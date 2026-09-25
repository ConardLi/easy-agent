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
import { formatCapturedOutput, runControlledProcess } from "../utils/controlledProcess.js";

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
  idleTimeout?: number;
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
const MAX_OUTPUT_BYTES = 30_000;

export const bashTool: Tool = {
  name: "Bash",
  searchHint: "execute shell commands",
  description: "Execute a shell command in the current working directory and return stdout/stderr.",
  inputSchema: {
    type: "object" as const,
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeout: { type: "number", description: "Timeout in milliseconds (default 120000)" },
      idleTimeout: { type: "number", description: "Stop after this many milliseconds without output (default: command timeout)" },
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
    const idleTimeoutMs = typeof input.idleTimeout === "number" ? input.idleTimeout : timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0) {
      return { content: "Error: timeout and idleTimeout must be positive integer milliseconds", isError: true };
    }

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

    try {
      const run = await runControlledProcess({
        executable, args, cwd: context.cwd, env: spawnEnv,
        signal: context.abortSignal, timeoutMs, idleTimeoutMs,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        onStdout: progressId ? (chunk) => appendBashProgress(progressId, chunk) : undefined,
        onStderr: progressId ? (chunk) => appendBashProgress(progressId, chunk) : undefined,
      });
      if (run.reason === "aborted") return { content: "Command aborted", isError: true };
      if (run.reason === "timeout") return { content: `Command timed out after ${timeoutMs}ms`, isError: true };
      if (run.reason === "idle_timeout") return { content: `Command idle for ${idleTimeoutMs}ms`, isError: true };
      if (run.spawnError) return { content: `Failed to start command: ${run.spawnError.message}`, isError: true };

      // Tag sandbox denials for the model while retaining bounded stderr.
      const annotatedStderr = sandboxCommand
        ? annotateSandboxFailure(sandboxCommand.commandId, run.stderr, run.exitCode)
        : run.stderr;
      const output = [
        `Command: ${input.command}`,
        `Read-only: ${readOnlyAnalysis.isReadOnly}`,
        `Sandbox: ${sandboxLabel}`,
        `Exit code: ${run.exitCode ?? -1}`,
        run.signal ? `Signal: ${run.signal}` : "",
        run.stdout ? `\nSTDOUT:\n${formatCapturedOutput(run.stdout, run.stdoutOmittedBytes)}` : "",
        annotatedStderr ? `\nSTDERR:\n${formatCapturedOutput(annotatedStderr, run.stderrOmittedBytes)}` : "",
      ].filter(Boolean).join("\n");
      return { content: output, isError: (run.exitCode ?? 1) !== 0 };
    } catch (error) {
      return { content: `Failed to run command: ${error instanceof Error ? error.message : String(error)}`, isError: true };
    } finally {
      if (progressId) completeBashProgress(progressId);
      if (sandboxCommand) cleanupSandboxCommand(sandboxCommand);
    }
  },
  isReadOnly(): boolean {
    return false;
  },
  isEnabled(): boolean {
    return true;
  },
};
