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
 * `harnessSetting` reads the built-in default over the process environment
 * and flags, as of each read.
 *
 * Code that has a workspace directory and reads a key settings files can set
 * uses `harnessFor(cwd)` instead: it returns the runtime's snapshot when the
 * runtime works in that directory, and otherwise resolves that directory's
 * settings files, so no caller ends up with a harness that leaves them out.
 */

import * as path from "node:path";
import { harnessValue, type ResolvedHarness, resolveHarness, resolveProcessHarness } from "./resolve.js";

/** How a runtime resolves its Agent, for its own workspace or another directory. */
export interface HarnessResolver {
  /** The runtime's workspace. */
  cwd: string;
  /** Resolve the runtime's Agent for `cwd` from current settings files and the runtime's environment snapshot. */
  resolve: (cwd: string) => Promise<ResolvedHarness>;
}

let installed: ResolvedHarness | null = null;
let resolver: HarnessResolver | null = null;
/** Changes on every install and uninstall, so a refresh that started before one cannot overwrite it. */
let installation = 0;
/** Refreshes started and the newest one applied; an older refresh that finishes late is dropped. */
let refreshesStarted = 0;
let refreshApplied = 0;

/**
 * Install the runtime's harness and how to resolve its Agent. `resolved` may
 * be null when the first resolution failed; reads then use the process
 * default until a refresh succeeds.
 */
export function installHarness(resolved: ResolvedHarness | null, how?: HarnessResolver): void {
  installed = resolved;
  resolver = how ? { cwd: path.resolve(how.cwd), resolve: how.resolve } : null;
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
  const how = resolver;
  if (!how) return activeHarness();
  const startedAt = installation;
  const ticket = ++refreshesStarted;
  try {
    const next = await how.resolve(how.cwd);
    if (installation === startedAt && ticket > refreshApplied) {
      installed = next;
      refreshApplied = ticket;
    }
  } catch {
    // The previous snapshot stays in place; the next refresh tries again.
  }
  return activeHarness();
}

export interface HarnessForOptions {
  /**
   * Read the settings files as they are now, without installing the result.
   * For reads outside a model request (opening a session, starting a turn,
   * showing configuration); the installed snapshot only changes between
   * requests.
   */
  current?: boolean;
}

/**
 * The harness for code working in `cwd`.
 *
 * When the runtime works in `cwd`, this is its installed snapshot (or, with
 * `current`, the same Agent resolved from the settings files as they are
 * now). For another directory, such as a sub-agent's worktree, the runtime's
 * Agent is resolved for that directory. Without a runtime, the `default`
 * Agent is resolved from that directory's settings files and the process
 * environment. Throws when the settings cannot be resolved.
 */
export async function harnessFor(cwd: string, options: HarnessForOptions = {}): Promise<ResolvedHarness> {
  const how = resolver;
  const dir = path.resolve(cwd);
  if (!how) return resolveHarness({ cwd: dir });
  if (dir !== how.cwd) return how.resolve(dir);
  if (installed && !options.current) return installed;
  return how.resolve(dir);
}

/** The value of one Harness key in `harnessFor(cwd, options)`. */
export async function harnessSettingFor<T>(cwd: string, keyPath: string, options?: HarnessForOptions): Promise<T> {
  return harnessValue<T>(await harnessFor(cwd, options), keyPath);
}

/** The value of one Harness key in the active harness. Throws on an unknown key. */
export function harnessSetting<T>(keyPath: string): T {
  const entry = activeHarness().values[keyPath];
  if (!entry) throw new Error(`unknown harness key ${keyPath}`);
  return entry.value as T;
}
