#!/usr/bin/env tsx
/**
 * Stage 18 verification script — exercise the sandbox subsystem WITHOUT
 * touching the LLM or actually running sandbox-exec. Each section
 * isolates a unit (split, settings merge, profile build, sbpl compile,
 * shouldUseSandbox decision, violation tag handling, auto-allow flow)
 * so a failure points directly at the offending piece.
 *
 * Usage:
 *   cd easy-agent
 *   npm run test:sandbox
 *
 * Exits non-zero if any assertion fails.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  annotateStderrWithSandboxFailures,
  buildSandboxProfile,
  compileMacosProfile,
  containsExcludedCommand,
  hasSandboxViolationTag,
  matchesExcludedPattern,
  removeSandboxViolationTags,
  resolveSandboxSettings,
  shouldUseSandbox,
  splitCommand,
  wrapWithSandbox,
  _resetAvailabilityCache,
  isPlatformSupported,
  isSandboxRuntimeReady,
  DEFAULT_RESOLVED_SANDBOX_SETTINGS,
  type ResolvedSandboxSettings,
} from "../sandbox/index.js";

const failures: string[] = [];
function assert(condition: unknown, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`);
    failures.push(label);
  }
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
    failures.push(label);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

function makeSettings(overrides: Partial<ResolvedSandboxSettings> = {}): ResolvedSandboxSettings {
  return {
    ...DEFAULT_RESOLVED_SANDBOX_SETTINGS,
    enabled: true,
    ...overrides,
  };
}

async function main(): Promise<void> {
  section("[1] splitCommand — compound bash splitter");
  assertEqual(splitCommand("ls"), ["ls"], "single command");
  assertEqual(splitCommand("echo a && rm -rf /"), ["echo a", "rm -rf /"], "&& splits");
  assertEqual(splitCommand("a || b"), ["a", "b"], "|| splits");
  assertEqual(splitCommand("a; b; c"), ["a", "b", "c"], "; splits");
  assertEqual(splitCommand("ls | grep foo"), ["ls", "grep foo"], "pipe splits");
  assertEqual(splitCommand("sleep 5 & echo done"), ["sleep 5", "echo done"], "background & splits");
  assertEqual(
    splitCommand('echo "a && b" && echo c'),
    ['echo "a && b"', "echo c"],
    "respects double-quoted operators",
  );
  assertEqual(
    splitCommand("echo 'a && b' && echo c"),
    ["echo 'a && b'", "echo c"],
    "respects single-quoted operators",
  );

  section("[2] resolveSandboxSettings — user/project merge");
  const merged = resolveSandboxSettings(
    {
      enabled: true,
      autoAllowBashIfSandboxed: false,
      excludedCommands: ["docker:*"],
      filesystem: { allowWrite: ["/user/path"] },
    },
    {
      enabled: undefined,
      excludedCommands: ["make:*"],
      filesystem: { allowWrite: ["/project/path"] },
    },
  );
  assertEqual(merged.enabled, true, "user enabled wins when project unset");
  assertEqual(merged.autoAllowBashIfSandboxed, false, "user override survives merge");
  assertEqual(
    merged.excludedCommands,
    ["docker:*", "make:*"],
    "excludedCommands concatenate (user first, then project)",
  );
  assertEqual(
    merged.filesystem.allowWrite.sort(),
    ["/project/path", "/user/path"].sort(),
    "filesystem.allowWrite concatenates",
  );

  const projectOverrides = resolveSandboxSettings(
    { enabled: true },
    { enabled: false },
  );
  assertEqual(projectOverrides.enabled, false, "project enabled overrides user enabled");

  section("[3] excludedCommands matcher");
  assert(matchesExcludedPattern("docker ps", "docker:*"), "docker:* matches `docker ps`");
  assert(matchesExcludedPattern("docker", "docker:*"), "docker:* matches bare `docker`");
  assert(!matchesExcludedPattern("dockerfile", "docker:*"), "docker:* does NOT match `dockerfile`");
  assert(matchesExcludedPattern("npm install", "npm install"), "exact pattern matches");
  assert(matchesExcludedPattern("npm install foo", "npm install"), "exact pattern matches with trailing args");
  assert(!matchesExcludedPattern("foo bar", "docker:*"), "non-matching command rejects");

  assert(
    containsExcludedCommand("docker ps && echo done", ["docker:*"]),
    "compound: any subcommand match excludes",
  );
  assert(
    !containsExcludedCommand("ls && cat foo", ["docker:*"]),
    "compound: no subcommand match → not excluded",
  );

  section("[4] shouldUseSandbox decision tree");
  if (!isPlatformSupported()) {
    console.log("    [skip] non-macOS host — shouldUseSandbox always returns false");
  } else {
    _resetAvailabilityCache();
    const ready = isSandboxRuntimeReady();
    assert(ready, "macOS host has sandbox-exec available");

    assert(
      shouldUseSandbox({ command: "ls" }, makeSettings()),
      "enabled + macOS + simple command → sandbox",
    );
    assert(
      !shouldUseSandbox({ command: "ls" }, makeSettings({ enabled: false })),
      "disabled in settings → no sandbox",
    );
    assert(
      !shouldUseSandbox(
        { command: "ls", dangerouslyDisableSandbox: true },
        makeSettings({ allowUnsandboxedCommands: true }),
      ),
      "model escape + policy allows → no sandbox",
    );
    assert(
      shouldUseSandbox(
        { command: "ls", dangerouslyDisableSandbox: true },
        makeSettings({ allowUnsandboxedCommands: false }),
      ),
      "model escape but policy denies → sandbox anyway",
    );
    assert(
      !shouldUseSandbox(
        { command: "docker ps" },
        makeSettings({ excludedCommands: ["docker:*"] }),
      ),
      "excluded command → no sandbox",
    );
  }

  section("[5] buildSandboxProfile — unified abstraction");
  const cwd = process.cwd();
  const profile = buildSandboxProfile({
    cwd,
    settings: makeSettings({
      filesystem: {
        allowWrite: ["/explicit/allow"],
        denyWrite: ["/explicit/deny"],
        allowRead: [],
        denyRead: [],
      },
      network: { allowedDomains: ["explicit.example"], deniedDomains: [] },
    }),
    permissions: {
      allow: [
        "WebFetch(domain:github.com)",
        "Edit(/repo/src/**)",
      ],
      deny: ["WebFetch(domain:evil.com)", "Edit(/system/critical)"],
    },
  });

  assert(
    profile.network.allowedDomains.includes("github.com"),
    "WebFetch(domain:github.com) → allowedDomains contains github.com",
  );
  assert(
    profile.network.allowedDomains.includes("explicit.example"),
    "settings.network.allowedDomains preserved",
  );
  assert(
    profile.network.deniedDomains.includes("evil.com"),
    "WebFetch(domain:evil.com) deny → deniedDomains contains evil.com",
  );
  assert(
    profile.filesystem.allowWrite.some((p) => p === "/repo/src"),
    "Edit(/repo/src/**) → allowWrite contains /repo/src (glob suffix stripped)",
  );
  assert(
    profile.filesystem.allowWrite.includes("/explicit/allow"),
    "settings.filesystem.allowWrite preserved",
  );
  assert(
    profile.filesystem.denyWrite.includes("/system/critical"),
    "Edit(/system/critical) deny → denyWrite contains /system/critical",
  );
  // After canonicalization /etc may appear as /private/etc on macOS.
  assert(
    profile.filesystem.denyWrite.some((p) => p === "/etc" || p === "/private/etc"),
    "system path /etc always denied (canonicalized form ok)",
  );
  const canonicalCwd = (() => {
    try { return fs.realpathSync(path.resolve(cwd)); } catch { return path.resolve(cwd); }
  })();
  assert(
    profile.filesystem.allowWrite.includes(canonicalCwd),
    "cwd is always writable",
  );
  const canonicalTmp = (() => {
    try { return fs.realpathSync(os.tmpdir()); } catch { return os.tmpdir(); }
  })();
  assert(
    profile.filesystem.allowWrite.includes(canonicalTmp),
    "tmpdir is always writable (canonicalized)",
  );
  assert(
    profile.filesystem.denyWrite.some((p) => p.endsWith(`.easy-agent/skills`)) ||
      profile.filesystem.denyWrite.some((p) => p.endsWith("skills")),
    "critical path .easy-agent/skills always denied",
  );

  section("[6] compileMacosProfile — sbpl emission");
  const sbpl = compileMacosProfile(profile);
  assert(sbpl.includes("(version 1)"), "starts with (version 1)");
  assert(sbpl.includes("(deny default)"), "default-deny stance");
  assert(sbpl.includes("(allow process*)"), "process spawn allowed");
  assert(sbpl.includes("(allow file-read*)"), "reads allowed (tutorial-grade)");
  assert(
    sbpl.includes("(allow file-write*"),
    "file-write allow rule emitted",
  );
  assert(
    sbpl.includes("(deny file-write*"),
    "file-write deny rule emitted",
  );
  assert(
    sbpl.includes(escapeForCheck("/etc")) || sbpl.includes(escapeForCheck("/private/etc")),
    "deny includes /etc (canonicalized form ok)",
  );
  assert(sbpl.includes(escapeForCheck(canonicalCwd)), "allow includes cwd");
  assert(
    !sbpl.includes('"\\') ||
      sbpl.indexOf('\\"') === sbpl.indexOf('"\\'),
    "string escapes look sane (no double-escape bugs)",
  );

  section("[7] wrapWithSandbox — final command shape");
  const wrap = wrapWithSandbox("echo hello", profile);
  assert(
    wrap.wrappedCommand.startsWith("/usr/bin/sandbox-exec -p '"),
    "starts with sandbox-exec -p '...'",
  );
  assert(
    wrap.wrappedCommand.includes("/bin/bash -lc '"),
    "ends with /bin/bash -lc '<cmd>'",
  );
  assert(
    wrap.wrappedCommand.includes("'echo hello'"),
    "preserves the original command verbatim",
  );

  // Single-quote escape: the user command contains a single quote.
  const tricky = wrapWithSandbox("echo 'hi'", profile);
  assert(
    tricky.wrappedCommand.includes("'echo '\\''hi'\\'''"),
    "POSIX-escapes single quotes in user command",
  );

  section("[8] sandbox-violation tag handling");
  const cleanStderr = "rm: foo: no such file or directory";
  assertEqual(
    annotateStderrWithSandboxFailures(cleanStderr, 1),
    cleanStderr,
    "regular errors are NOT tagged",
  );

  const violationStderr = "Operation not permitted";
  const tagged = annotateStderrWithSandboxFailures(violationStderr, 1);
  assert(
    tagged.includes("<sandbox_violations>") && tagged.includes("</sandbox_violations>"),
    "sandbox-style errors get tagged",
  );
  assert(hasSandboxViolationTag(tagged), "hasSandboxViolationTag detects tag");
  assert(!hasSandboxViolationTag(cleanStderr), "hasSandboxViolationTag rejects clean stderr");

  const stripped = removeSandboxViolationTags(tagged);
  assert(
    !stripped.includes("<sandbox_violations>") && stripped.includes("Operation not permitted"),
    "removeSandboxViolationTags strips tag, keeps original stderr",
  );

  assertEqual(
    annotateStderrWithSandboxFailures("Operation not permitted", 0),
    "Operation not permitted",
    "exit code 0 → no tag (success)",
  );
  assertEqual(
    annotateStderrWithSandboxFailures("Operation not permitted", null),
    "Operation not permitted",
    "null exit code → no tag",
  );

  section("[9] result");
  if (failures.length === 0) {
    console.log(`\n  All checks passed.\n`);
    process.exit(0);
  } else {
    console.log(`\n  ${failures.length} failure(s):`);
    for (const f of failures) console.log(`    - ${f}`);
    process.exit(1);
  }
}

function escapeForCheck(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
