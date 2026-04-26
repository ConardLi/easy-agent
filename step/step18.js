/**
 * Step 18 - Bash sandbox
 *
 * Goal:
 * - load sandbox settings from user / project settings.json
 * - decide whether a Bash command should run inside the sandbox
 * - derive a runtime profile from sandbox settings + permission rules
 * - compile the profile into macOS sandbox-exec SBPL
 * - wrap Bash commands with sandbox-exec
 * - annotate sandbox-style failures so the model can recover
 *
 * This file is a teaching version that condenses the core mechanics.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// -----------------------------------------------------------------------------
// 1. Settings paths and JSON loader
// -----------------------------------------------------------------------------

export function getEasyAgentDir() {
  return path.join(os.homedir(), ".easy-agent");
}

export function getUserSettingsPath() {
  return path.join(getEasyAgentDir(), "settings.json");
}

export function getProjectSettingsPath(cwd) {
  return path.join(cwd, ".easy-agent", "settings.json");
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueMerge(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const item of list || []) {
      if (!seen.has(item)) {
        seen.add(item);
        out.push(item);
      }
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// 2. Sandbox settings
// -----------------------------------------------------------------------------

export const DEFAULT_SANDBOX_SETTINGS = {
  enabled: false,
  autoAllowBashIfSandboxed: true,
  allowUnsandboxedCommands: true,
  excludedCommands: [],
  filesystem: {
    allowWrite: [],
    denyWrite: [],
    allowRead: [],
    denyRead: [],
  },
  network: {
    allowedDomains: [],
    deniedDomains: [],
  },
};

function pickFilesystem(value) {
  if (!value || typeof value !== "object") return {};
  return {
    allowWrite: asStringArray(value.allowWrite),
    denyWrite: asStringArray(value.denyWrite),
    allowRead: asStringArray(value.allowRead),
    denyRead: asStringArray(value.denyRead),
  };
}

function pickNetwork(value) {
  if (!value || typeof value !== "object") return {};
  return {
    allowedDomains: asStringArray(value.allowedDomains),
    deniedDomains: asStringArray(value.deniedDomains),
  };
}

function pickSandbox(value) {
  if (!value || typeof value !== "object") return {};
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
    autoAllowBashIfSandboxed:
      typeof value.autoAllowBashIfSandboxed === "boolean"
        ? value.autoAllowBashIfSandboxed
        : undefined,
    allowUnsandboxedCommands:
      typeof value.allowUnsandboxedCommands === "boolean"
        ? value.allowUnsandboxedCommands
        : undefined,
    excludedCommands: asStringArray(value.excludedCommands),
    filesystem: pickFilesystem(value.filesystem),
    network: pickNetwork(value.network),
  };
}

export function resolveSandboxSettings(user, project) {
  return {
    enabled: project.enabled ?? user.enabled ?? DEFAULT_SANDBOX_SETTINGS.enabled,
    autoAllowBashIfSandboxed:
      project.autoAllowBashIfSandboxed ??
      user.autoAllowBashIfSandboxed ??
      DEFAULT_SANDBOX_SETTINGS.autoAllowBashIfSandboxed,
    allowUnsandboxedCommands:
      project.allowUnsandboxedCommands ??
      user.allowUnsandboxedCommands ??
      DEFAULT_SANDBOX_SETTINGS.allowUnsandboxedCommands,
    excludedCommands: uniqueMerge(user.excludedCommands, project.excludedCommands),
    filesystem: {
      allowWrite: uniqueMerge(user.filesystem?.allowWrite, project.filesystem?.allowWrite),
      denyWrite: uniqueMerge(user.filesystem?.denyWrite, project.filesystem?.denyWrite),
      allowRead: uniqueMerge(user.filesystem?.allowRead, project.filesystem?.allowRead),
      denyRead: uniqueMerge(user.filesystem?.denyRead, project.filesystem?.denyRead),
    },
    network: {
      allowedDomains: uniqueMerge(user.network?.allowedDomains, project.network?.allowedDomains),
      deniedDomains: uniqueMerge(user.network?.deniedDomains, project.network?.deniedDomains),
    },
  };
}

export async function loadSandboxSettings(cwd) {
  const [userRoot, projectRoot] = await Promise.all([
    readJsonFile(getUserSettingsPath()),
    readJsonFile(getProjectSettingsPath(cwd)),
  ]);

  return resolveSandboxSettings(
    pickSandbox(userRoot.sandbox),
    pickSandbox(projectRoot.sandbox),
  );
}

// -----------------------------------------------------------------------------
// 3. Runtime availability
// -----------------------------------------------------------------------------

let cachedRuntimeReady;
let cachedUnavailableReason;

export function isPlatformSupported() {
  return process.platform === "darwin";
}

function isSandboxExecAvailable() {
  try {
    execFileSync("/usr/bin/which", ["sandbox-exec"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export function isSandboxRuntimeReady() {
  if (cachedRuntimeReady !== undefined) return cachedRuntimeReady;
  cachedRuntimeReady = isPlatformSupported() && isSandboxExecAvailable();
  return cachedRuntimeReady;
}

export function getSandboxUnavailableReason(enabledInSettings) {
  if (!enabledInSettings) return undefined;
  if (cachedUnavailableReason !== undefined) return cachedUnavailableReason || undefined;
  if (isSandboxRuntimeReady()) {
    cachedUnavailableReason = "";
    return undefined;
  }
  cachedUnavailableReason = !isPlatformSupported()
    ? "sandbox.enabled is true but this platform is not supported. This tutorial uses macOS sandbox-exec."
    : "sandbox.enabled is true but /usr/bin/sandbox-exec is not available.";
  return cachedUnavailableReason;
}

// -----------------------------------------------------------------------------
// 4. Compound command splitting and sandbox decision
// -----------------------------------------------------------------------------

const COMMAND_OPERATORS = new Set(["&&", "||", ";", "|", "&"]);

export function splitCommand(command) {
  const segments = [];
  let buffer = "";
  let quote = null;
  let i = 0;

  const flush = () => {
    const trimmed = buffer.trim();
    if (trimmed) segments.push(trimmed);
    buffer = "";
  };

  while (i < command.length) {
    const ch = command[i];

    if (quote) {
      buffer += ch;
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      buffer += ch;
      i += 1;
      continue;
    }

    const two = command.slice(i, i + 2);
    if (COMMAND_OPERATORS.has(two)) {
      flush();
      i += 2;
      continue;
    }

    if (COMMAND_OPERATORS.has(ch)) {
      flush();
      i += 1;
      continue;
    }

    buffer += ch;
    i += 1;
  }

  flush();
  return segments;
}

function wildcardToRegExp(pattern) {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp("^" + escaped + "$");
}

export function matchesExcludedPattern(command, pattern) {
  const trimmed = pattern.trim();
  if (!trimmed) return false;

  if (trimmed.endsWith(":*")) {
    const prefix = trimmed.slice(0, -2);
    return command === prefix || command.startsWith(prefix + " ");
  }
  if (trimmed.includes("*")) {
    return wildcardToRegExp(trimmed).test(command);
  }
  return command === trimmed || command.startsWith(trimmed + " ");
}

export function containsExcludedCommand(command, excludedCommands) {
  const subcommands = splitCommand(command);
  return subcommands.some((subcommand) => {
    return excludedCommands.some((pattern) => matchesExcludedPattern(subcommand, pattern));
  });
}

export function shouldUseSandbox(input, settings) {
  if (!settings.enabled) return false;
  if (!isSandboxRuntimeReady()) return false;
  if (!input.command) return false;
  if (input.dangerouslyDisableSandbox && settings.allowUnsandboxedCommands) {
    return false;
  }
  if (containsExcludedCommand(input.command, settings.excludedCommands)) {
    return false;
  }
  return true;
}

// -----------------------------------------------------------------------------
// 5. Build sandbox profile
// -----------------------------------------------------------------------------

function canonicalize(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return filePath;
  }
}

function expandHome(filePath) {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function resolveRulePath(value, cwd) {
  const expanded = expandHome(value);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
}

function stripGlobSuffix(filePath) {
  return filePath.replace(/\/?\*+$/g, "").replace(/\/$/, "") || filePath;
}

function parsePermissionRule(rule) {
  const match = String(rule).match(/^([A-Za-z]+)\(([^)]*)\)$/);
  if (!match) return null;
  return { toolName: match[1].trim(), ruleContent: match[2].trim() };
}

function getCriticalDenyPaths(cwd) {
  return [
    getUserSettingsPath(),
    getProjectSettingsPath(cwd),
    path.join(getEasyAgentDir(), "skills"),
    path.join(cwd, ".easy-agent", "skills"),
    path.join(getEasyAgentDir(), "AGENT.md"),
    path.join(cwd, "AGENT.md"),
  ];
}

const SYSTEM_DENY_WRITE_PATHS = ["/etc", "/usr", "/private/etc"];

export function buildSandboxProfile({ cwd, settings, permissions }) {
  const allowWrite = new Set([
    canonicalize(path.resolve(cwd)),
    canonicalize(os.tmpdir()),
    canonicalize(path.join(os.tmpdir(), "easy-agent")),
  ]);
  const denyWrite = new Set(SYSTEM_DENY_WRITE_PATHS.map(canonicalize));
  const allowRead = new Set();
  const denyRead = new Set();
  const allowedDomains = new Set(settings.network.allowedDomains);
  const deniedDomains = new Set(settings.network.deniedDomains);

  for (const filePath of getCriticalDenyPaths(cwd)) {
    denyWrite.add(canonicalize(filePath));
  }

  for (const filePath of settings.filesystem.allowWrite) {
    allowWrite.add(canonicalize(resolveRulePath(filePath, cwd)));
  }
  for (const filePath of settings.filesystem.denyWrite) {
    denyWrite.add(canonicalize(resolveRulePath(filePath, cwd)));
  }
  for (const filePath of settings.filesystem.allowRead) {
    allowRead.add(canonicalize(resolveRulePath(filePath, cwd)));
  }
  for (const filePath of settings.filesystem.denyRead) {
    denyRead.add(canonicalize(resolveRulePath(filePath, cwd)));
  }

  for (const rule of permissions.allow || []) {
    const parsed = parsePermissionRule(rule);
    if (!parsed) continue;

    if (parsed.toolName === "WebFetch" && parsed.ruleContent.startsWith("domain:")) {
      allowedDomains.add(parsed.ruleContent.slice("domain:".length));
    } else if (parsed.toolName === "Edit" || parsed.toolName === "Write") {
      const p = stripGlobSuffix(resolveRulePath(parsed.ruleContent, cwd));
      allowWrite.add(canonicalize(p));
    } else if (parsed.toolName === "Read") {
      const p = stripGlobSuffix(resolveRulePath(parsed.ruleContent, cwd));
      allowRead.add(canonicalize(p));
    }
  }

  for (const rule of permissions.deny || []) {
    const parsed = parsePermissionRule(rule);
    if (!parsed) continue;

    if (parsed.toolName === "WebFetch" && parsed.ruleContent.startsWith("domain:")) {
      deniedDomains.add(parsed.ruleContent.slice("domain:".length));
    } else if (parsed.toolName === "Edit" || parsed.toolName === "Write") {
      const p = stripGlobSuffix(resolveRulePath(parsed.ruleContent, cwd));
      denyWrite.add(canonicalize(p));
    } else if (parsed.toolName === "Read") {
      const p = stripGlobSuffix(resolveRulePath(parsed.ruleContent, cwd));
      denyRead.add(canonicalize(p));
    }
  }

  return {
    filesystem: {
      allowWrite: [...allowWrite],
      denyWrite: [...denyWrite],
      allowRead: [...allowRead],
      denyRead: [...denyRead],
    },
    network: {
      allowedDomains: [...allowedDomains],
      deniedDomains: [...deniedDomains],
    },
  };
}

// -----------------------------------------------------------------------------
// 6. Compile macOS sandbox-exec profile
// -----------------------------------------------------------------------------

function escapeSbplString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function subpath(filePath) {
  return '(subpath "' + escapeSbplString(filePath) + '")';
}

export function compileMacosProfile(profile) {
  const writableSubpaths = profile.filesystem.allowWrite.map(subpath).join(" ");
  const denyWriteSubpaths = profile.filesystem.denyWrite.map(subpath).join(" ");

  // Teaching limitation: if any allowed domain exists, allow outbound
  // networking. Production should enforce domains through a proxy.
  const networkAllowAll = profile.network.allowedDomains.length > 0;

  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow signal)",
    "(allow mach-lookup)",
    "(allow ipc-posix-shm)",
    "(allow sysctl-read)",
    "(allow file-read*)",
    writableSubpaths ? "(allow file-write* " + writableSubpaths + ")" : "",
    denyWriteSubpaths ? "(deny file-write* " + denyWriteSubpaths + ")" : "",
    networkAllowAll
      ? "(allow network*)"
      : "(deny network-outbound) (allow network-bind (local ip)) (allow network* (local ip))",
  ].filter(Boolean).join("\n");
}

function shellQuoteSingle(value) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function wrapWithSandbox(command, profile) {
  const sbpl = compileMacosProfile(profile);
  return {
    profile: sbpl,
    wrappedCommand: [
      "/usr/bin/sandbox-exec",
      "-p",
      shellQuoteSingle(sbpl),
      "/bin/bash",
      "-lc",
      shellQuoteSingle(command),
    ].join(" "),
  };
}

// -----------------------------------------------------------------------------
// 7. Permission auto-allow when sandboxed
// -----------------------------------------------------------------------------

function ruleMatchesBash(rule, command) {
  const parsed = parsePermissionRule(rule);
  if (!parsed || parsed.toolName !== "Bash") return false;
  return wildcardToRegExp(parsed.ruleContent).test(command);
}

export function checkSandboxAutoAllow(command, rules, sessionRules = { allow: [], deny: [] }) {
  const subcommands = splitCommand(command);
  const denyRules = [...(sessionRules.deny || []), ...(rules.deny || [])];
  const allowRules = [...(sessionRules.allow || []), ...(rules.allow || [])];

  for (const subcommand of subcommands) {
    const denyRule = denyRules.find((rule) => ruleMatchesBash(rule, subcommand));
    if (denyRule) {
      return {
        behavior: "deny",
        reason: 'subcommand "' + subcommand + '" matched deny rule "' + denyRule + '"',
      };
    }
  }

  for (const subcommand of subcommands) {
    const allowRule = allowRules.find((rule) => ruleMatchesBash(rule, subcommand));
    if (allowRule) {
      return {
        behavior: "allow",
        reason: 'subcommand "' + subcommand + '" matched allow rule "' + allowRule + '"',
      };
    }
  }

  return {
    behavior: "allow",
    reason: "auto-allowed inside sandbox",
  };
}

// -----------------------------------------------------------------------------
// 8. Violation annotations
// -----------------------------------------------------------------------------

const SANDBOX_VIOLATION_INDICATORS = [
  "Operation not permitted",
  "operation not permitted",
  "sandbox-exec:",
  "deny file-write",
  "deny network-outbound",
  "EPERM",
  "EACCES",
];

const VIOLATION_TAG_RE = /<sandbox_violations>[\s\S]*?<\/sandbox_violations>/g;

export function looksLikeSandboxViolation(stderr) {
  if (!stderr) return false;
  return SANDBOX_VIOLATION_INDICATORS.some((indicator) => stderr.includes(indicator));
}

export function annotateStderrWithSandboxFailures(stderr, exitCode) {
  if (!stderr) return stderr;
  if (exitCode === 0 || exitCode === null) return stderr;
  if (!looksLikeSandboxViolation(stderr)) return stderr;
  if (VIOLATION_TAG_RE.test(stderr)) {
    VIOLATION_TAG_RE.lastIndex = 0;
    return stderr;
  }

  return (
    stderr +
    "\n<sandbox_violations>\n" +
    "The command appears to have been blocked by the sandbox. " +
    "The error indicators above are typical of file-write or network policy violations.\n" +
    "</sandbox_violations>"
  );
}

export function removeSandboxViolationTags(text) {
  return String(text).replace(VIOLATION_TAG_RE, "").trim();
}

// -----------------------------------------------------------------------------
// 9. End-to-end Bash preparation
// -----------------------------------------------------------------------------

export async function prepareBashCommand({
  command,
  cwd,
  permissions = { allow: [], deny: [] },
  dangerouslyDisableSandbox = false,
}) {
  const settings = await loadSandboxSettings(cwd);
  const willSandbox = shouldUseSandbox(
    { command, dangerouslyDisableSandbox },
    settings,
  );

  if (!willSandbox) {
    return {
      command,
      sandboxed: false,
      profile: null,
    };
  }

  const profile = buildSandboxProfile({ cwd, settings, permissions });
  const wrapped = wrapWithSandbox(command, profile);

  return {
    command: wrapped.wrappedCommand,
    sandboxed: true,
    profile: wrapped.profile,
  };
}
