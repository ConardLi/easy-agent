import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsCache } from "../config/sources.js";
import { executeHookCommand } from "../hooks/executor.js";
import { runUserPromptSubmitHooks, _resetHooksSettingsCache } from "../hooks/runHooks.js";
import { getUserSettingsPath } from "../utils/paths.js";

const windows = process.platform === "win32";

async function main(): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hooks-home-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hooks-cwd-"));
  const oldHome = process.env.HOME;
  const oldProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  resetSettingsCache();
  _resetHooksSettingsCache();

  try {
    const settingsPath = getUserSettingsPath();
    assert.equal(path.dirname(settingsPath), path.join(home, ".easy-agent"));
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });

    const writeHooks = async (command: string) => {
      await fs.writeFile(settingsPath, JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command }] }] },
      }));
      resetSettingsCache();
    };
    const outputCommand = (value: string) => windows
      ? `Write-Output '${value}'`
      : `printf '${value}'`;
    const run = () => runUserPromptSubmitHooks({ prompt: "hello", cwd });

    await writeHooks(outputCommand("first"));
    assert.equal((await run()).additionalContext, "first");
    await writeHooks(outputCommand("second"));
    assert.equal((await run()).additionalContext, "second", "edited settings take effect without restart");

    await fs.writeFile(settingsPath, "{ invalid json");
    resetSettingsCache();
    assert.equal((await run()).additionalContext, "second", "invalid JSON retains last valid hooks");

    await fs.writeFile(settingsPath, JSON.stringify({ hooks: [] }));
    resetSettingsCache();
    assert.equal((await run()).additionalContext, "second", "invalid hooks block retains last valid hooks");
    await fs.writeFile(settingsPath, JSON.stringify({ hooks: { UserPromptSubmit: "invalid" } }));
    resetSettingsCache();
    assert.equal((await run()).additionalContext, "second", "invalid event configuration retains last valid hooks");
    await fs.writeFile(settingsPath, JSON.stringify({
      hooks: { UserPromptSubmit: [{ matcher: "(", hooks: [{ command: outputCommand("invalid") }] }] },
    }));
    resetSettingsCache();
    assert.equal((await run()).additionalContext, "second", "invalid matcher retains last valid hooks");

    await fs.writeFile(settingsPath, JSON.stringify({ hooks: {} }));
    resetSettingsCache();
    assert.equal((await run()).results.length, 0, "valid empty hooks block removes hooks");

    await fs.writeFile(settingsPath, JSON.stringify({
      disableAllHooks: true,
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: outputCommand("disabled") }] }] },
    }));
    resetSettingsCache();
    assert.equal((await run()).results.length, 0, "disableAllHooks update takes effect");
    await fs.writeFile(settingsPath, "{ invalid json");
    resetSettingsCache();
    assert.equal((await run()).results.length, 0, "invalid update retains disableAllHooks");
    await writeHooks(outputCommand("enabled"));
    assert.equal((await run()).additionalContext, "enabled", "clearing disableAllHooks takes effect");

    const scriptPath = path.join(cwd, "hook-child.cjs");
    await fs.writeFile(scriptPath, `
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => input += chunk);
      process.stdin.on('end', () => {
        if (process.argv[2] === 'input') process.stdout.write(input);
        if (process.argv[2] === 'large') process.stdout.write('x'.repeat(100000));
        if (process.argv[2] === 'exit') { process.stderr.write('failed'); process.exitCode = 3; }
        if (process.argv[2] === 'sleep') setTimeout(() => {}, 10000);
      });
    `);
    const command = (mode: string) => `${windows ? "& " : ""}"${process.execPath}" "${scriptPath}" ${mode}`;
    const hookInput = { hook_event_name: "UserPromptSubmit" as const, session_id: "", cwd, prompt: "hello" };
    const execute = (mode: string, signal?: AbortSignal, timeout = 5) => executeHookCommand({
      hook: { type: "command", command: command(mode), timeout },
      hookEvent: "UserPromptSubmit",
      hookName: "UserPromptSubmit",
      hookInput,
      cwd,
      signal,
    });
    const input = await execute("input");
    assert.equal(input.outcome, "success");
    assert.deepEqual(JSON.parse(input.stdout), hookInput, "JSON input reaches child process");
    const nonzero = await execute("exit");
    assert.equal(nonzero.outcome, "non_blocking_error");
    assert.match(nonzero.stderr, /failed/);
    const large = await execute("large");
    assert.equal(large.outcome, "non_blocking_error");
    assert.match(large.stderr, /truncated/);
    const timeout = await execute("sleep", undefined, 0.5);
    assert.equal(timeout.outcome, "non_blocking_error");
    assert.match(timeout.stderr, /timed out/);
    const controller = new AbortController();
    const cancelledPromise = execute("sleep", controller.signal);
    setTimeout(() => controller.abort(), 100);
    assert.equal((await cancelledPromise).outcome, "cancelled");

    if (windows) {
      const explicitPowerShell = await executeHookCommand({
        hook: { type: "command", command: "Write-Output 'powershell-ready'", shell: "powershell" },
        hookEvent: "UserPromptSubmit", hookName: "UserPromptSubmit", hookInput, cwd,
      });
      assert.equal(explicitPowerShell.stdout.trim(), "powershell-ready");
    }
    console.log("Hooks hardening tests passed");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldProfile;
    resetSettingsCache();
    _resetHooksSettingsCache();
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
