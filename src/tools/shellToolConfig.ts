/** Limits of the shell tools (Bash, PowerShell): built-in values, or the Agent's `tools.config.<name>`. */

import { activeHarness } from "../harness/active.js";
import { toolConfigOf } from "../harness/selection.js";

export const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
export const DEFAULT_SHELL_MAX_OUTPUT_BYTES = 30_000;

export interface ShellToolLimits {
  /** Timeout of a command whose call sets none. */
  timeoutMs: number;
  /** Command output kept for the model. */
  maxOutputBytes: number;
}

export function shellToolLimits(name: "Bash" | "PowerShell"): ShellToolLimits {
  const config = toolConfigOf(activeHarness(), name);
  return {
    timeoutMs: config.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS,
    maxOutputBytes: config.maxOutputBytes ?? DEFAULT_SHELL_MAX_OUTPUT_BYTES,
  };
}

/** The `timeout` and `idleTimeout` input properties, stating the default the model gets. */
export function shellTimeoutProperties(name: "Bash" | "PowerShell") {
  return {
    timeout: {
      type: "number",
      description: `Timeout in milliseconds (default ${shellToolLimits(name).timeoutMs})`,
    },
    idleTimeout: {
      type: "number",
      description: "Stop after this many milliseconds without output (default: command timeout)",
    },
  } as const;
}
