/** Resolve whether a shell command is sandboxed, explicitly bypassed, or blocked. */

import { getSandboxCapability } from "./availability.js";
import type { ResolvedSandboxSettings } from "./settings.js";
import type { SandboxCapability } from "./types.js";
import { splitCommand } from "./splitCommand.js";

export interface ShouldUseSandboxInput {
  command: string;
  dangerouslyDisableSandbox?: boolean;
}

export interface SandboxExecutionDecision {
  mode: "disabled" | "sandbox" | "bypass" | "blocked" | "fallback";
  reason?: string;
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
  // Exclusions may bypass an OS boundary, so only a single command is
  // eligible. Compound syntax and substitutions remain sandboxed even when
  // each visible command prefix appears in the exclusion list.
  if (splitCommand(command).length !== 1 || /[`\n\r<>]|\$\(|\(|\)/.test(command)) {
    return false;
  }
  return excluded.some((pattern) => matchesExcludedPattern(command.trim(), pattern));
}

export function shouldUseSandbox(
  input: ShouldUseSandboxInput,
  settings: ResolvedSandboxSettings,
): boolean {
  return decideSandboxExecution(input, settings).mode === "sandbox";
}

export function decideSandboxExecution(
  input: ShouldUseSandboxInput,
  settings: ResolvedSandboxSettings,
  capability: SandboxCapability = getSandboxCapability(),
): SandboxExecutionDecision {
  if (!settings.enabled || !input.command) return { mode: "disabled" };
  if (
    input.dangerouslyDisableSandbox === true &&
    settings.allowUnsandboxedCommands
  ) {
    return { mode: "bypass", reason: "explicit per-command bypass" };
  }
  if (containsExcludedCommand(input.command, settings.excludedCommands)) {
    return { mode: "bypass", reason: "command is excluded by user policy" };
  }
  if (!capability.available) {
    const reason = capability.errors.join("; ") || `sandbox unavailable on ${capability.platform}`;
    return { mode: settings.failClosed ? "blocked" : "fallback", reason };
  }
  return { mode: "sandbox" };
}
