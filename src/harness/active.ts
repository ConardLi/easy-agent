/**
 * The harness the running agent uses.
 *
 * A runtime resolves its Agent when it starts and installs the snapshot here.
 * Code that needs an Agent setting reads it through `harnessSetting` rather
 * than reading settings files or environment variables, so every value has
 * one source and one point in time: the runtime's start. One runtime is
 * active per process, so the installed harness is process-wide.
 *
 * Without a runtime (one-off scripts, tests that drive the engine directly),
 * values come from the built-in default over the process environment and
 * flags, as of each read.
 */

import { type ResolvedHarness, resolveProcessHarness } from "./resolve.js";

let installed: ResolvedHarness | null = null;

/** Install the runtime's harness, or remove it with `null` when the runtime is disposed. */
export function installHarness(resolved: ResolvedHarness | null): void {
  installed = resolved;
}

/** The installed harness, or the process default when no runtime installed one. */
export function activeHarness(): ResolvedHarness {
  return installed ?? resolveProcessHarness();
}

/** The value of one Harness key in the active harness. Throws on an unknown key. */
export function harnessSetting<T>(keyPath: string): T {
  const entry = activeHarness().values[keyPath];
  if (!entry) throw new Error(`unknown harness key ${keyPath}`);
  return entry.value as T;
}
