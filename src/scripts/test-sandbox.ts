#!/usr/bin/env tsx

import * as fs from "node:fs";
import * as path from "node:path";
import {
  annotateStderrWithSandboxFailures,
  buildSandboxProfile,
  containsExcludedCommand,
  decideSandboxExecution,
  DEFAULT_RESOLVED_SANDBOX_SETTINGS,
  hasSandboxViolationTag,
  matchesExcludedPattern,
  parseSandboxSettings,
  removeSandboxViolationTags,
  resolveSandboxCapability,
  resolveSandboxSettings,
  SandboxConfigurationError,
  splitCommand,
  toSandboxRuntimeConfig,
  type ResolvedSandboxSettings,
} from "../sandbox/index.js";

const failures: string[] = [];

function assert(condition: unknown, label: string): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.log(`  ✗ ${label}`);
    failures.push(label);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) console.log(`  ✓ ${label}`);
  else {
    console.log(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
    failures.push(label);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

function makeSettings(overrides: Partial<ResolvedSandboxSettings> = {}): ResolvedSandboxSettings {
  return { ...DEFAULT_RESOLVED_SANDBOX_SETTINGS, enabled: true, ...overrides };
}

function expectConfigurationError(value: unknown, label: string): void {
  try {
    parseSandboxSettings(value);
    assert(false, label);
  } catch (error) {
    assert(error instanceof SandboxConfigurationError, label);
  }
}

async function main(): Promise<void> {
  section("[1] command parsing and exclusions");
  assertEqual(splitCommand("echo a && rm -rf /"), ["echo a", "rm -rf /"], "compound command splits");
  assertEqual(splitCommand('echo "a && b" && echo c'), ['echo "a && b"', "echo c"], "quoted operator is preserved");
  assert(matchesExcludedPattern("docker ps", "docker:*"), "prefix exclusion matches");
  assert(containsExcludedCommand("docker ps", ["docker:*"]), "simple excluded command may bypass");
  assert(
    !containsExcludedCommand("docker ps && curl https://evil.example", ["docker:*"]),
    "mixed compound command cannot bypass",
  );
  assert(
    !containsExcludedCommand("docker ps && docker images", ["docker:*"]),
    "compound commands never bypass",
  );
  assert(!containsExcludedCommand("docker $(curl evil.example)", ["docker:*"]), "command substitution never bypasses");

  section("[2] settings merge and validation");
  const merged = resolveSandboxSettings(
    {
      enabled: true,
      failClosed: false,
      filesystem: { allowWrite: ["/user/path"] },
      network: { allowedDomains: ["user.example"] },
    },
    {
      failClosed: true,
      filesystem: { allowWrite: ["/project/path"] },
      network: { allowLocalBinding: true },
    },
  );
  assertEqual(merged.enabled, true, "enabled inherits from the user source");
  assertEqual(merged.failClosed, true, "later failClosed value wins");
  assertEqual(merged.filesystem.allowWrite, ["/user/path", "/project/path"], "write paths merge");
  assertEqual(merged.network.allowedDomains, ["user.example"], "domain allowlist merges");
  assertEqual(merged.network.allowLocalBinding, true, "network scalar merges");
  assertEqual(DEFAULT_RESOLVED_SANDBOX_SETTINGS.failClosed, true, "failClosed defaults to true");
  expectConfigurationError({ enabled: "yes" }, "non-boolean enabled is rejected");
  expectConfigurationError({ network: { allowedDomains: "*" } }, "non-array domains are rejected");
  expectConfigurationError({ network: { unknownRule: true } }, "unsupported network setting is rejected");
  expectConfigurationError({ unknownRule: true }, "unsupported sandbox setting is rejected");

  section("[3] platform capabilities");
  const mac = resolveSandboxCapability("darwin", true, { errors: [], warnings: [] });
  assert(mac.available && mac.backend === "seatbelt", "macOS reports the Seatbelt backend");
  const linux = resolveSandboxCapability("linux", true, { errors: [], warnings: [] });
  assert(linux.available && linux.backend === "bubblewrap", "Linux reports the bubblewrap backend");
  const missingLinux = resolveSandboxCapability("linux", true, {
    errors: ["bubblewrap is missing"],
    warnings: [],
  });
  assert(!missingLinux.available && missingLinux.errors.length === 1, "missing Linux dependency is unavailable");
  const windows = resolveSandboxCapability("win32", true, { errors: [], warnings: [] });
  assert(!windows.supported && !windows.available, "Windows support scope is reported accurately");
  assertEqual(
    decideSandboxExecution({ command: "echo test" }, makeSettings(), missingLinux).mode,
    "blocked",
    "unavailable runtime blocks by default",
  );
  assertEqual(
    decideSandboxExecution({ command: "echo test" }, makeSettings({ failClosed: false }), missingLinux).mode,
    "fallback",
    "explicit failClosed=false permits normal permission fallback",
  );

  section("[4] profile and runtime conversion");
  const cwd = fs.realpathSync(process.cwd());
  const profile = buildSandboxProfile({
    cwd,
    settings: makeSettings({
      filesystem: {
        allowWrite: ["/explicit/allow"],
        denyWrite: ["/explicit/deny"],
        allowRead: ["/explicit/read"],
        denyRead: ["/explicit/secret"],
      },
      network: {
        allowedDomains: ["api.example.com"],
        deniedDomains: ["evil.example.com"],
        allowUnixSockets: ["/var/run/docker.sock"],
        allowAllUnixSockets: false,
        allowLocalBinding: true,
      },
    }),
    permissions: {
      allow: ["WebFetch(domain:github.com)", "Edit(/repo/src/**)"],
      deny: ["WebFetch(domain:blocked.example)", "Read(/secrets/**)"],
    },
  });
  assert(profile.network.allowedDomains.includes("github.com"), "WebFetch allow contributes a domain");
  assert(profile.network.deniedDomains.includes("blocked.example"), "WebFetch deny contributes a domain");
  assert(profile.filesystem.denyRead.includes(path.resolve("/secrets")), "Read deny contributes a path");
  assert(profile.filesystem.denyWrite.includes(path.join(cwd, ".env")), ".env cannot be rewritten");
  assert(profile.filesystem.denyWrite.includes(path.join(cwd, ".mcp.json")), ".mcp.json cannot be rewritten");

  const runtime = toSandboxRuntimeConfig(profile);
  assertEqual(runtime.network.allowedDomains, profile.network.allowedDomains, "runtime receives exact domain allowlist");
  assertEqual(runtime.network.deniedDomains, profile.network.deniedDomains, "runtime receives exact domain denylist");
  assertEqual(runtime.filesystem.denyRead, profile.filesystem.denyRead, "runtime receives denyRead");
  assertEqual(runtime.network.strictAllowlist, true, "unmatched network destinations are denied");

  section("[5] violation annotation");
  const annotated = annotateStderrWithSandboxFailures("Operation not permitted", 1);
  assert(hasSandboxViolationTag(annotated), "sandbox denial gets a machine-readable tag");
  assert(!hasSandboxViolationTag(removeSandboxViolationTags(annotated)), "UI removal strips the tag");

  console.log("");
  if (failures.length > 0) {
    console.error(`${failures.length} sandbox test(s) failed.`);
    process.exit(1);
  }
  console.log("All sandbox tests passed.");
}

void main();
