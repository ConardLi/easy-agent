/**
 * Build the final command string that BashTool hands to spawn().
 *
 * Shape:
 *
 *   /usr/bin/sandbox-exec -p '<sbpl>' /bin/bash -lc '<original command>'
 *
 * The shell-quote step is deliberately strict: every single quote
 * inside the user command becomes `'\''` so the outer single-quoted
 * string remains intact. This is the canonical POSIX-shell escape.
 *
 * We do NOT pass the user command via /tmp file — it would leave a
 * residue if the process is killed mid-execution. Inline-quoted is
 * cheaper and self-cleaning.
 */

import { compileMacosProfile } from "./macosProfile.js";
import type { SandboxProfile } from "./types.js";

function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface WrapWithSandboxResult {
  /** The final command-line that should run via spawn(shell, ['-lc', ...]). */
  wrappedCommand: string;
  /** The compiled sbpl profile, kept around so callers can log it. */
  profile: string;
}

export function wrapWithSandbox(
  command: string,
  profile: SandboxProfile,
): WrapWithSandboxResult {
  const sbpl = compileMacosProfile(profile);
  const wrappedCommand = [
    "/usr/bin/sandbox-exec",
    "-p",
    shellQuoteSingle(sbpl),
    "/bin/bash",
    "-lc",
    shellQuoteSingle(command),
  ].join(" ");
  return { wrappedCommand, profile: sbpl };
}
