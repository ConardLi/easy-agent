import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runControlledProcess } from "../utils/controlledProcess.js";

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "easy-agent-process-test-"));

function nodeCommand(source: string, extraArgs: string[] = []) {
  return { executable: process.execPath, args: ["-e", source, ...extraArgs], cwd: ROOT };
}

async function waitForFile(filePath: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { return await fs.readFile(filePath, "utf8"); } catch { /* Child has not written it yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function processAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await processAlive(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Descendant process ${pid} survived cancellation`);
}

try {
  const normal = await runControlledProcess({
    ...nodeCommand("process.stdin.on('data', d => process.stdout.write(d)); process.stdin.on('end', () => process.stderr.write('note'))"),
    stdin: "input", timeoutMs: 2_000,
  });
  assert.equal(normal.reason, "completed");
  assert.equal(normal.exitCode, 0);
  assert.equal(normal.stdout, "input");
  assert.equal(normal.stderr, "note");

  const nonzero = await runControlledProcess({
    ...nodeCommand("process.stderr.write('failure'); process.exit(7)"), timeoutMs: 2_000,
  });
  assert.equal(nonzero.reason, "completed");
  assert.equal(nonzero.exitCode, 7);
  assert.equal(nonzero.stderr, "failure");

  const missing = await runControlledProcess({
    executable: path.join(ROOT, "missing-executable"), args: [], cwd: ROOT, timeoutMs: 2_000,
  });
  assert.equal(missing.reason, "spawn_error");
  assert.ok(missing.spawnError);

  const outputLimit = 4_096;
  const flood = await runControlledProcess({
    ...nodeCommand("for (let i=0; i<1000; i++) { process.stdout.write('A'.repeat(10000)); process.stderr.write('B'.repeat(10000)); }"),
    timeoutMs: 10_000,
    maxOutputBytes: outputLimit,
  });
  assert.equal(flood.reason, "completed");
  assert.equal(flood.exitCode, 0);
  assert.equal(flood.stdoutBytes, 10_000_000);
  assert.equal(flood.stderrBytes, 10_000_000);
  assert.ok(Buffer.byteLength(flood.stdout) <= outputLimit);
  assert.ok(Buffer.byteLength(flood.stderr) <= outputLimit);
  assert.equal(flood.stdoutTruncated, true);
  assert.equal(flood.stderrTruncated, true);

  const idle = await runControlledProcess({
    ...nodeCommand("setInterval(() => {}, 1000)"), timeoutMs: 2_000, idleTimeoutMs: 100,
  });
  assert.equal(idle.reason, "idle_timeout");
  assert.ok(idle.durationMs < 2_000);

  const wall = await runControlledProcess({
    ...nodeCommand("setInterval(() => process.stdout.write('tick'), 10)"),
    timeoutMs: 180, idleTimeoutMs: 1_000,
  });
  assert.equal(wall.reason, "timeout");
  assert.ok(wall.stdoutBytes > 0);

  if (process.platform !== "win32") {
    const signalled = await runControlledProcess({
      ...nodeCommand("setTimeout(() => process.kill(process.pid, 'SIGTERM'), 10)"), timeoutMs: 2_000,
    });
    assert.equal(signalled.reason, "completed");
    assert.equal(signalled.signal, "SIGTERM");
  }

  for (const mode of ["abort", "timeout"] as const) {
    const marker = path.join(ROOT, `${mode}.pid`);
    const controller = new AbortController();
    const parentSource = [
      "const {spawn}=require('node:child_process');",
      "const fs=require('node:fs');",
      "const child=spawn(process.execPath,['-e',\"setInterval(() => {}, 1000)\"],{stdio:'inherit'});",
      "fs.writeFileSync(process.argv[1],String(child.pid));",
      "setInterval(() => {}, 1000);",
    ].join("");
    const running = runControlledProcess({
      ...nodeCommand(parentSource, [marker]),
      timeoutMs: mode === "timeout" ? 200 : 5_000,
      signal: controller.signal,
      terminationGraceMs: 100,
    });
    const grandchildPid = Number(await waitForFile(marker));
    assert.ok(Number.isSafeInteger(grandchildPid));
    if (mode === "abort") controller.abort();
    const stopped = await running;
    assert.equal(stopped.reason, mode === "abort" ? "aborted" : "timeout");
    await waitForProcessExit(grandchildPid);
  }

  if (process.platform !== "win32") {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    try {
      process.env.HOME = ROOT;
      process.env.USERPROFILE = ROOT;
      const { bashTool } = await import("../tools/bashTool.js");
      const { getBashProgress } = await import("../state/bashProgressStore.js");
      const toolUseId = "bounded-bash-test";
      const bash = await bashTool.call({
        command: `${process.execPath} -e "process.stdout.write('x'.repeat(2000000))"`,
        timeout: 5_000,
      }, { cwd: ROOT, toolUseId });
      assert.notEqual(bash.isError, true);
      assert.match(String(bash.content), /truncated/);
      assert.ok(String(bash.content).length < 40_000);
      assert.ok((getBashProgress(toolUseId)?.output.length ?? 0) <= 8_000);

      const { executeHookCommand } = await import("../hooks/executor.js");
      const hook = await executeHookCommand({
        hook: { type: "command", command: `${process.execPath} -e "process.stdout.write('x'.repeat(200000))"` },
        hookEvent: "UserPromptSubmit",
        hookName: "bounded-hook",
        hookInput: { hook_event_name: "UserPromptSubmit", session_id: "test", cwd: ROOT, prompt: "test" },
        cwd: ROOT,
      });
      assert.equal(hook.outcome, "non_blocking_error");
      assert.equal(hook.additionalContext, undefined);
      assert.match(hook.stderr, /output exceeded/);
      assert.ok(hook.stdout.length < 70_000);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  }

  console.log("Controlled process checks passed.");
} finally {
  await fs.rm(ROOT, { recursive: true, force: true });
}
