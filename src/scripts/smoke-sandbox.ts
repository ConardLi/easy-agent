#!/usr/bin/env tsx
/**
 * Stage 18 smoke test — actually invokes /usr/bin/sandbox-exec to
 * confirm the profile we generate works as intended on the host.
 * This complements test-sandbox.ts which is unit-level (string/regex
 * checks). Unlike unit tests, smoke tests need a real macOS host with
 * sandbox-exec available.
 *
 * Usage:
 *   cd easy-agent
 *   npm run smoke:sandbox
 *
 * Skips with exit 0 on non-macOS hosts.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildSandboxProfile,
  isPlatformSupported,
  isSandboxRuntimeReady,
  wrapWithSandbox,
  DEFAULT_RESOLVED_SANDBOX_SETTINGS,
} from "../sandbox/index.js";

if (!isPlatformSupported() || !isSandboxRuntimeReady()) {
  console.log("[skip] sandbox-exec not available — smoke test only runs on macOS with sandbox-exec.");
  process.exit(0);
}

const cwd = process.cwd();
const profile = buildSandboxProfile({
  cwd,
  settings: { ...DEFAULT_RESOLVED_SANDBOX_SETTINGS, enabled: true },
  permissions: { allow: [], deny: [] },
});

function runSandboxed(command: string): { code: number; stdout: string; stderr: string } {
  const wrap = wrapWithSandbox(command, profile);
  const r = spawnSync(process.env.SHELL || "/bin/bash", ["-lc", wrap.wrappedCommand], {
    cwd,
    encoding: "utf-8",
  });
  return { code: r.status ?? -1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function section(t: string): void {
  console.log(`\n${t}`);
}

const failures: string[] = [];
function expect(label: string, condition: unknown, evidence?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}${evidence ? `\n      ${evidence}` : ""}`);
    failures.push(label);
  }
}

// ─── Test 1: writes to cwd succeed ──────────────────────────────────
section("[1] writes inside cwd succeed");
const allowedFile = path.join(os.tmpdir(), `easy-agent-sb-${Date.now()}.txt`);
const r1 = runSandboxed(`echo allowed > '${allowedFile}'`);
expect("write to tmpdir succeeds (exit 0)", r1.code === 0, `exit=${r1.code} stderr=${r1.stderr}`);
expect("file actually exists", fs.existsSync(allowedFile));
fs.unlinkSync(allowedFile);

// ─── Test 2: writes to /etc are blocked ──────────────────────────────
section("[2] writes to /etc are blocked");
const r2 = runSandboxed("echo hijack > /etc/easy-agent-test 2>&1");
expect("write to /etc fails (non-zero exit)", r2.code !== 0, `exit=${r2.code}`);
const combined = (r2.stdout + r2.stderr).toLowerCase();
expect(
  "stderr mentions denial",
  combined.includes("operation not permitted") || combined.includes("permission denied") || combined.includes("read-only"),
  `combined=${combined.slice(0, 200)}`,
);
// And confirm we did NOT pollute /etc
expect("no rogue file landed in /etc", !fs.existsSync("/etc/easy-agent-test"));

// ─── Test 3: writes to ~/.easy-agent/skills are blocked ─────────────
section("[3] critical path .easy-agent/skills blocked");
const skillsDir = path.join(os.homedir(), ".easy-agent", "skills");
const skillsCanary = path.join(skillsDir, `canary-${Date.now()}.md`);
// Pre-condition: directory may or may not exist; we attempt write either way.
const r3 = runSandboxed(`mkdir -p '${skillsDir}' && echo evil > '${skillsCanary}' 2>&1`);
expect("write to .easy-agent/skills fails", r3.code !== 0, `exit=${r3.code}`);
expect("canary file does NOT exist", !fs.existsSync(skillsCanary));

// ─── Test 4: process forks/execs work (basic sanity) ────────────────
section("[4] basic execution sanity");
const r4 = runSandboxed("echo hello && date && uname");
expect("compound command runs", r4.code === 0, `exit=${r4.code} stderr=${r4.stderr}`);
expect("stdout contains hello", r4.stdout.includes("hello"));

// ─── Result ──────────────────────────────────────────────────────────
console.log("");
if (failures.length === 0) {
  console.log(`  All smoke checks passed.`);
  process.exit(0);
} else {
  console.log(`  ${failures.length} failure(s):`);
  for (const f of failures) console.log(`    - ${f}`);
  process.exit(1);
}
