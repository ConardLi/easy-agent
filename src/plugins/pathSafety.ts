/**
 * Component-path containment checks.
 *
 * A plugin manifest can declare component paths (skills/agents/commands/...)
 * and a Git-sourced plugin is untrusted code on disk. Before the loader reads
 * any of those paths we must prove they still resolve INSIDE the plugin root —
 * a `..`, an absolute path, or a symlink that escapes the root would otherwise
 * let a hostile plugin read arbitrary files (or trick the loader into loading
 * an agent/hook from outside its sandbox).
 *
 * Two layers:
 *   1. Lexical — `resolve()` the candidate against the root and confirm the
 *      result is still prefixed by the root. Catches `..` and absolute paths.
 *   2. Realpath — resolve symlinks on BOTH the root and the candidate and
 *      re-check containment. Catches a symlink inside the plugin that points
 *      outside it.
 *
 * The Zod schema already rejects literal `..` / absolute paths in the manifest
 * string; this module is the defense-in-depth that also survives symlinks and
 * is reused for auto-discovered default directories.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** True when `child` is `parent` itself or nested underneath it. */
function isContained(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Realpath the deepest EXISTING ancestor of `target` and re-attach the missing
 * tail segments. This lets a containment check compare a not-yet-existing path
 * against a realpath-resolved root without tripping over a symlinked ancestor
 * (e.g. macOS `/var/folders/...` → `/private/var/folders/...`).
 */
async function realpathWithMissingTail(target: string): Promise<string> {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return path.join(real, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return target;
      const parent = path.dirname(current);
      if (parent === current) return target; // reached the filesystem root
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export interface PathCheckResult {
  ok: boolean;
  /** The realpath-resolved absolute path when ok; the offending path otherwise. */
  resolved: string;
  reason?: string;
}

/**
 * Resolve `relOrAbs` against `pluginRoot` and verify it stays inside the root
 * both lexically and after symlink resolution. Missing paths are allowed
 * (returns ok with the lexically-resolved path) so an optional component dir
 * that simply doesn't exist isn't treated as an attack — the loader will just
 * find nothing there.
 */
export async function resolveInsidePlugin(
  pluginRoot: string,
  relOrAbs: string,
): Promise<PathCheckResult> {
  const lexical = path.resolve(pluginRoot, relOrAbs);
  if (!isContained(pluginRoot, lexical)) {
    return { ok: false, resolved: lexical, reason: "path escapes the plugin root" };
  }

  // Resolve symlinks on the root once; a plugin root that is itself a symlink
  // is fine as long as the candidate stays under its canonical location.
  let realRoot: string;
  try {
    realRoot = await fs.realpath(pluginRoot);
  } catch {
    realRoot = lexical === pluginRoot ? lexical : path.resolve(pluginRoot);
  }

  let realCandidate: string;
  try {
    realCandidate = await fs.realpath(lexical);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    // Non-existent path: allow (nothing to load), but still confirm the
    // lexical form is inside the *real* root so a dangling symlink dir above
    // it can't be exploited later.
    if (err?.code === "ENOENT") {
      // Compare like with like: resolve symlinks on the existing part of the
      // candidate before checking it against the realpath-resolved root.
      const probe = await realpathWithMissingTail(lexical);
      return isContained(realRoot, probe)
        ? { ok: true, resolved: lexical }
        : { ok: false, resolved: lexical, reason: "path escapes the plugin root" };
    }
    return { ok: false, resolved: lexical, reason: (error as Error).message };
  }

  if (!isContained(realRoot, realCandidate)) {
    return {
      ok: false,
      resolved: realCandidate,
      reason: "symlink resolves outside the plugin root",
    };
  }
  return { ok: true, resolved: realCandidate };
}
