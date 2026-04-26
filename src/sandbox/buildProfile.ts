/**
 * Compose a SandboxProfile from three input sources:
 *
 *   1. Resolved sandbox settings  (sandbox.filesystem.*, sandbox.network.*)
 *   2. Permission rules           (Edit(/path), WebFetch(domain:host), ...)
 *   3. Hardcoded defaults         (cwd + tmpdir writable; system + .easy-agent
 *                                  internals denied)
 *
 * Why mixing (1) and (2) matters — this is the "unified abstraction"
 * design point from source code:
 *
 *   When the user writes `WebFetch(domain:github.com)` in their
 *   permissions.allow list, we want both effects in one place:
 *     - WebFetch tool gets github.com as a permitted host
 *     - The sandbox network whitelist also gets github.com, so a
 *       sandboxed `curl github.com` works
 *   No double-config. The same goes for `Edit(/path)` rules adding
 *   to the writable filesystem allowlist.
 *
 * Reference: `claude-code-source-code/src/utils/sandbox/sandbox-adapter.ts`
 *   in `convertToSandboxRuntimeConfig()`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getEasyAgentPath,
  getProjectEasyAgentDir,
  getProjectSettingsPath,
  getUserSettingsPath,
} from "../utils/paths.js";
import type { ResolvedSandboxSettings } from "./settings.js";
import type { SandboxProfile } from "./types.js";

/**
 * macOS sandbox-exec evaluates rules using CANONICAL paths (after
 * symlink resolution). E.g. `/var/folders/.../T` is actually
 * `/private/var/folders/.../T`, and the subpath rule must use the
 * `/private/...` form for the match to succeed.
 *
 * We canonicalize every path that ends up in the profile. If the
 * path doesn't exist yet (e.g. user added `/foo/bar` to allowWrite
 * proactively), we fall back to the original — the sandbox will
 * accept it as-is for paths that don't exist.
 */
function canonicalize(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

export interface PermissionRules {
  allow: string[];
  deny: string[];
}

const PERMISSION_RULE_RE = /^([A-Za-z]+)\(([^)]*)\)$/;

interface ParsedRule {
  toolName: string;
  ruleContent: string;
}

function parseRule(rule: string): ParsedRule | null {
  const m = rule.match(PERMISSION_RULE_RE);
  if (!m) return null;
  const toolName = m[1]!.trim();
  const ruleContent = m[2]!.trim();
  if (!toolName || !ruleContent) return null;
  return { toolName, ruleContent };
}

/** Strip a trailing glob suffix so sandbox-exec gets a path prefix. */
function stripGlobSuffix(p: string): string {
  return p.replace(/\/?\*+$/g, "").replace(/\/$/, "") || p;
}

function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(p === "~" ? 1 : 2));
  }
  return p;
}

function resolveRulePath(value: string, cwd: string): string {
  const expanded = expandHome(value);
  if (path.isAbsolute(expanded)) return path.resolve(expanded);
  return path.resolve(cwd, expanded);
}

/**
 * Hard-coded paths that ALWAYS deny-write, regardless of user settings.
 * These are the "self-modification" attack surfaces — if a sandboxed
 * command can rewrite settings.json or the skill files, the model can
 * exfiltrate by editing its own runtime config and waiting for the
 * next session.
 *
 * Mirrors source code's settingsPaths + .claude/skills/.claude/commands
 * forced-deny block in `convertToSandboxRuntimeConfig` (lines 230–256).
 */
function getCriticalDenyPaths(cwd: string): string[] {
  const denies = [
    getUserSettingsPath(),
    getProjectSettingsPath(cwd),
    path.join(getProjectEasyAgentDir(cwd), "skills"),
    getEasyAgentPath("skills"),
    path.join(cwd, "AGENT.md"),
    getEasyAgentPath("AGENT.md"),
  ];
  return Array.from(new Set(denies));
}

// System paths we always deny writes to. We deliberately do NOT
// include `/var` or `/private/var` here even though they're "system":
// macOS's tmpdir lives inside /private/var/folders/.../T, and a broad
// `/private/var` deny rule would override our tmpdir allow (SBPL is
// last-match-wins). The remaining paths (`/etc`, `/usr`, plus their
// `/private/...` realpath siblings) are SIP-protected anyway, so the
// explicit deny here is mostly defense-in-depth + documentation.
const SYSTEM_DENY_PATHS_RAW = ["/etc", "/usr", "/private/etc"];

export function buildSandboxProfile(params: {
  cwd: string;
  settings: ResolvedSandboxSettings;
  permissions: PermissionRules;
}): SandboxProfile {
  const { cwd, settings, permissions } = params;

  // 1. Filesystem writable seed: always cwd + tmpdir.
  const allowWrite = new Set<string>([
    canonicalize(path.resolve(cwd)),
    canonicalize(os.tmpdir()),
    canonicalize(path.join(os.tmpdir(), "easy-agent")),
  ]);

  const denyWrite = new Set<string>(SYSTEM_DENY_PATHS_RAW.map(canonicalize));
  for (const p of getCriticalDenyPaths(cwd)) denyWrite.add(canonicalize(p));

  const allowRead = new Set<string>();
  const denyRead = new Set<string>();

  // 2. Filesystem from sandbox.filesystem.* settings (verbatim).
  for (const p of settings.filesystem.allowWrite) {
    allowWrite.add(canonicalize(resolveRulePath(p, cwd)));
  }
  for (const p of settings.filesystem.denyWrite) {
    denyWrite.add(canonicalize(resolveRulePath(p, cwd)));
  }
  for (const p of settings.filesystem.allowRead) {
    allowRead.add(canonicalize(resolveRulePath(p, cwd)));
  }
  for (const p of settings.filesystem.denyRead) {
    denyRead.add(canonicalize(resolveRulePath(p, cwd)));
  }

  // 3. Network from sandbox.network.*
  const allowedDomains = new Set<string>(settings.network.allowedDomains);
  const deniedDomains = new Set<string>(settings.network.deniedDomains);

  // 4. The unified abstraction: derive sandbox config from permission
  //    rules. Each rule contributes to BOTH the permission system
  //    (already loaded elsewhere) AND the sandbox profile (here).
  for (const rule of permissions.allow) {
    const parsed = parseRule(rule);
    if (!parsed) continue;
    if (parsed.toolName === "WebFetch" && parsed.ruleContent.startsWith("domain:")) {
      allowedDomains.add(parsed.ruleContent.slice("domain:".length));
    } else if (parsed.toolName === "Edit" || parsed.toolName === "Write") {
      const p = canonicalize(stripGlobSuffix(resolveRulePath(parsed.ruleContent, cwd)));
      allowWrite.add(p);
    } else if (parsed.toolName === "Read") {
      const p = canonicalize(stripGlobSuffix(resolveRulePath(parsed.ruleContent, cwd)));
      allowRead.add(p);
    }
  }

  for (const rule of permissions.deny) {
    const parsed = parseRule(rule);
    if (!parsed) continue;
    if (parsed.toolName === "WebFetch" && parsed.ruleContent.startsWith("domain:")) {
      deniedDomains.add(parsed.ruleContent.slice("domain:".length));
    } else if (parsed.toolName === "Edit" || parsed.toolName === "Write") {
      const p = canonicalize(stripGlobSuffix(resolveRulePath(parsed.ruleContent, cwd)));
      denyWrite.add(p);
    } else if (parsed.toolName === "Read") {
      const p = canonicalize(stripGlobSuffix(resolveRulePath(parsed.ruleContent, cwd)));
      denyRead.add(p);
    }
  }

  return {
    filesystem: {
      allowWrite: Array.from(allowWrite),
      denyWrite: Array.from(denyWrite),
      allowRead: Array.from(allowRead),
      denyRead: Array.from(denyRead),
    },
    network: {
      allowedDomains: Array.from(allowedDomains),
      deniedDomains: Array.from(deniedDomains),
    },
  };
}
