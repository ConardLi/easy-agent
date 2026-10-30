/**
 * The harness the running agent uses.
 *
 * A runtime resolves its Agent when it starts and installs the snapshot here,
 * together with a way to resolve the same Agent again. Code that needs an
 * Agent setting reads it through `harnessSetting` rather than reading
 * settings files or environment variables. One runtime is active per
 * process, so the installed harness is process-wide.
 *
 * Environment variables and flags are taken when the runtime starts. Settings
 * files can change while it runs: the runtime calls `refreshHarness` before
 * each model request and when it picks a session's model, so an edited
 * settings file applies from the next request. Every read within one request
 * sees the same snapshot.
 *
 * Without a runtime (one-off scripts, tests that drive the engine directly),
 * values come from the built-in default over the process environment and
 * flags, as of each read.
 */

import { type ResolvedHarness, resolveProcessHarness } from "./resolve.js";

let installed: ResolvedHarness | null = null;
let reresolve: (() => Promise<ResolvedHarness>) | null = null;
/** Changes on every install and uninstall, so a refresh that started before one cannot overwrite it. */
let installation = 0;
/** Refreshes started and the newest one applied; an older refresh that finishes late is dropped. */
let refreshesStarted = 0;
let refreshApplied = 0;

/**
 * Install the runtime's harness and how to resolve it again. `resolved` may
 * be null when the first resolution failed; reads then use the process
 * default until a refresh succeeds.
 */
export function installHarness(resolved: ResolvedHarness | null, resolveAgain?: () => Promise<ResolvedHarness>): void {
  installed = resolved;
  reresolve = resolveAgain ?? null;
  installation += 1;
}

/** Remove the runtime's harness when the runtime is disposed or fails to start. */
export function uninstallHarness(): void {
  installHarness(null);
}

/** The installed harness, or the process default when no runtime installed one. */
export function activeHarness(): ResolvedHarness {
  return installed ?? resolveProcessHarness();
}

/**
 * Resolve the installed Agent again from the current settings files and
 * install the result. Keeps the current snapshot when resolution fails, and
 * returns the active harness either way.
 */
export async function refreshHarness(): Promise<ResolvedHarness> {
  const resolveAgain = reresolve;
  if (!resolveAgain) return activeHarness();
  const startedAt = installation;
  const ticket = ++refreshesStarted;
  try {
    const next = await resolveAgain();
    if (installation === startedAt && ticket > refreshApplied) {
      installed = next;
      refreshApplied = ticket;
    }
  } catch {
    // The previous snapshot stays in place; the next refresh tries again.
  }
  return activeHarness();
}

/** The value of one Harness key in the active harness. Throws on an unknown key. */
export function harnessSetting<T>(keyPath: string): T {
  const entry = activeHarness().values[keyPath];
  if (!entry) throw new Error(`unknown harness key ${keyPath}`);
  return entry.value as T;
}
