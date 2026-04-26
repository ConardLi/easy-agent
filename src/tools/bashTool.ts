import { spawn } from "node:child_process";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import {
  annotateStderrWithSandboxFailures,
  buildSandboxProfile,
  loadSandboxSettings,
  shouldUseSandbox,
  wrapWithSandbox,
  type ResolvedSandboxSettings,
} from "../sandbox/index.js";

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
 * Bash command — no restart required (matches source code's
 * settingsChangeDetector + refreshConfig pattern).
 */
async function buildProfileForCwd(
  cwd: string,
  settings: ResolvedSandboxSettings,
) {
  // Dynamic import: bashTool ⇄ permissions form a static-import cycle
  // (permissions wants `isReadOnlyCommand` from us). We break it here
  // — this path only runs when sandboxing is on, so the extra import
  // cost is negligible.
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
const READ_ONLY_COMMANDS = new Set([
  "ls",
  "cat",
  "grep",
  "rg",
  "find",
  "fd",
  "pwd",
  "which",
  "git status",
  "git log",
  "git diff",
  "git show",
  "head",
  "tail",
  "wc",
  "sed",
]);

function truncateOutput(value: string): string {
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated ${value.length - MAX_OUTPUT_CHARS} chars]`;
}

function splitCommandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||\|/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function isReadOnlyCommand(command: string): boolean {
  const segments = splitCommandSegments(command);
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    const normalized = segment.replace(/\s+/g, " ").trim();
    if (READ_ONLY_COMMANDS.has(normalized)) return true;
    const firstTwo = normalized.split(" ").slice(0, 2).join(" ");
    if (READ_ONLY_COMMANDS.has(firstTwo)) return true;
    const first = normalized.split(" ")[0];
    return READ_ONLY_COMMANDS.has(first);
  });
}

export const bashTool: Tool = {
  name: "Bash",
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

    const timeoutMs = typeof input.timeout === "number" ? input.timeout : DEFAULT_TIMEOUT_MS;

    // Decide sandbox wrapping. We swallow load errors and proceed with
    // sandboxing OFF — settings.json being unparseable shouldn't block
    // command execution; the permission system already surfaces those
    // errors loudly elsewhere.
    let sandboxSettings: ResolvedSandboxSettings | null = null;
    try {
      sandboxSettings = await loadSandboxSettings(context.cwd);
    } catch {
      sandboxSettings = null;
    }

    const willSandbox = sandboxSettings
      ? shouldUseSandbox(
          {
            command: input.command,
            dangerouslyDisableSandbox: input.dangerouslyDisableSandbox,
          },
          sandboxSettings,
        )
      : false;

    let executedCommand = input.command;
    if (willSandbox && sandboxSettings) {
      const profile = await buildProfileForCwd(context.cwd, sandboxSettings);
      const wrap = wrapWithSandbox(input.command, profile);
      executedCommand = wrap.wrappedCommand;
    }

    return await new Promise<ToolResult>((resolve) => {
      const child = spawn(process.env.SHELL || "bash", ["-lc", executedCommand], {
        cwd: context.cwd,
        env: process.env,
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (result: ToolResult) => {
        if (settled) return;
        settled = true;
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
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        clearTimeout(timeoutId);
        finish({ content: `Failed to start command: ${error.message}`, isError: true });
      });
      child.on("close", (code) => {
        clearTimeout(timeoutId);
        context.abortSignal?.removeEventListener("abort", onAbort);

        // Tag stderr with <sandbox_violations>...</sandbox_violations>
        // when the failure smells like a sandbox denial. The model uses
        // this signal to decide whether to retry, ask for permission,
        // or back off. The UI strips the tag before rendering.
        const annotatedStderr = willSandbox
          ? annotateStderrWithSandboxFailures(stderr, code)
          : stderr;

        const output = [
          `Command: ${input.command}`,
          `Read-only: ${isReadOnlyCommand(input.command)}`,
          `Sandbox: ${willSandbox ? "enabled" : "disabled"}`,
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
