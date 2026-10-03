/**
 * Tool-turn limit: `--max-turns`, the `maxTurns` setting, and the per-entry
 * defaults (REPL 200, Headless 50).
 *
 * A local Anthropic fixture answers every request with one Glob tool call,
 * so the loop only stops at the configured limit.
 *
 * Run: node --import tsx src/scripts/test-max-turns.ts
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const root = await mkdtemp(path.join(os.tmpdir(), "easy-agent-max-turns-"));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
await Promise.all([mkdir(path.join(home, ".easy-agent"), { recursive: true }), mkdir(path.join(cwd, ".easy-agent"), { recursive: true })]);
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.EASY_AGENT_DISABLE_HOOKS = "1";
process.env.EASY_AGENT_ENABLE_TOOL_SEARCH = "false";
process.chdir(cwd);

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const CLI_PATH = path.join(PROJECT_ROOT, "src", "entrypoint", "cli.ts");
const TSX_IMPORT = import.meta.resolve("tsx");
const USER_SETTINGS = path.join(home, ".easy-agent", "settings.json");
const PROJECT_SETTINGS = path.join(cwd, ".easy-agent", "settings.json");

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ─── Fixture provider: always one more tool call ───────────────────────────

let loopRequests = 0;
let requestSeq = 0;
function sse(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}
const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { tools?: unknown[] };
    if (Array.isArray(body.tools) && body.tools.length > 0) loopRequests += 1;
    const id = `toolu_${++requestSeq}`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      sse("message_start", { type: "message_start", message: {
        id: `msg_${requestSeq}`, type: "message", role: "assistant", model: "fixture-model", content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 },
      } }),
      sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "Glob", input: {} } }),
      sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"pattern\":\"*.md\"}" } }),
      sse("content_block_stop", { type: "content_block_stop", index: 0 }),
      sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 4 } }),
      sse("message_stop", { type: "message_stop" }),
    ].join(""));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.ANTHROPIC_BASE_URL = baseURL;
process.env.ANTHROPIC_AUTH_TOKEN = "fixture-token";

const { loadMaxTurnsSetting } = await import("../config/features.js");
const { setFlagSettings } = await import("../config/sources.js");
const { QueryEngine } = await import("../core/queryEngine.js");
const { MAX_TOOL_TURNS, INTERACTIVE_MAX_TOOL_TURNS } = await import("../core/agenticLoop.js");

async function writeUserSettings(settings: Record<string, unknown> | null): Promise<void> {
  await writeFile(USER_SETTINGS, settings ? JSON.stringify(settings) : "{}");
}

async function runEngine(defaultMaxTurns?: number): Promise<{ reason: unknown; requests: number; endsWithToolResult: boolean }> {
  loopRequests = 0;
  const engine = new QueryEngine({
    model: "fixture-model",
    toolContext: { cwd, requestUserQuestion: async () => null },
    permissionMode: "default",
    onPermissionRequest: async () => "deny",
    ...(defaultMaxTurns !== undefined ? { defaultMaxTurns } : {}),
  });
  const run = engine.submitMessage("Find the Markdown files.");
  let step = await run.next();
  while (!step.done) step = await run.next();
  const last = engine.getState().messages.at(-1);
  const endsWithToolResult = last?.role === "user" && Array.isArray(last.content) &&
    last.content.some((block: unknown) => (block as { type?: string }).type === "tool_result");
  return { reason: step.value.reason, requests: loopRequests, endsWithToolResult };
}

try {
  console.log("\n[1] setting resolution");

  await check("unset → undefined, so each entry point keeps its own default", async () => {
    await writeUserSettings(null);
    assert.equal(await loadMaxTurnsSetting(cwd), undefined);
    assert.equal(MAX_TOOL_TURNS, 50);
    assert.equal(INTERACTIVE_MAX_TOOL_TURNS, 200);
  });

  // Runs before any valid value is loaded: a rejected live update otherwise
  // keeps the source's last valid snapshot (see docs/configuration.md).
  await check("values that are not positive integers are ignored", async () => {
    for (const value of [0, -1, 2.5, "9", null]) {
      await writeUserSettings({ maxTurns: value });
      assert.equal(await loadMaxTurnsSetting(cwd), undefined, `maxTurns=${JSON.stringify(value)}`);
    }
  });

  await check("user setting applies and the --max-turns flag layer overrides it", async () => {
    await writeUserSettings({ maxTurns: 7 });
    assert.equal(await loadMaxTurnsSetting(cwd), 7);
    setFlagSettings({ maxTurns: 3 });
    try {
      assert.equal(await loadMaxTurnsSetting(cwd), 3);
    } finally {
      setFlagSettings({});
    }
  });

  await check("an untrusted project cannot set the limit", async () => {
    await writeUserSettings(null);
    await writeFile(PROJECT_SETTINGS, JSON.stringify({ maxTurns: 1 }));
    try {
      assert.equal(await loadMaxTurnsSetting(cwd), undefined);
    } finally {
      await rm(PROJECT_SETTINGS, { force: true });
    }
  });

  console.log("\n[2] QueryEngine");

  await check("the engine default applies when nothing is configured", async () => {
    await writeUserSettings(null);
    const result = await runEngine(4);
    assert.equal(result.reason, "max_turns");
    assert.equal(result.requests, 4);
    assert.ok(result.endsWithToolResult, "history is kept and ends with the last tool result");
  });

  await check("the maxTurns setting overrides the engine default", async () => {
    await writeUserSettings({ maxTurns: 2 });
    const result = await runEngine(INTERACTIVE_MAX_TOOL_TURNS);
    assert.equal(result.reason, "max_turns");
    assert.equal(result.requests, 2);
  });

  await check("without an engine default the loop keeps the 50-turn limit", async () => {
    await writeUserSettings(null);
    const result = await runEngine();
    assert.equal(result.reason, "max_turns");
    assert.equal(result.requests, MAX_TOOL_TURNS);
  });

  console.log("\n[3] CLI");

  async function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", TSX_IMPORT, CLI_PATH, ...args], {
        cwd,
        env: { ...process.env, ANTHROPIC_MODEL: "fixture-model", NO_COLOR: "1", FORCE_COLOR: "0" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("close", (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
      child.stdin.end("");
    });
  }

  function resultLine(stdout: string): Record<string, unknown> {
    return JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!) as Record<string, unknown>;
  }

  await check("Headless without --max-turns still stops at 50 with error_max_turns", async () => {
    await writeUserSettings(null);
    loopRequests = 0;
    const result = await runCli(["-p", "Find the Markdown files.", "--output-format", "json"]);
    assert.equal(result.code, 1, result.stderr);
    const line = resultLine(result.stdout);
    assert.equal(line.subtype, "error_max_turns");
    assert.equal(line.num_turns, MAX_TOOL_TURNS);
    assert.equal(loopRequests, MAX_TOOL_TURNS);
  });

  await check("Headless --max-turns sets the limit", async () => {
    loopRequests = 0;
    const result = await runCli(["-p", "Find the Markdown files.", "--output-format", "json", "--max-turns", "3"]);
    assert.equal(result.code, 1, result.stderr);
    const line = resultLine(result.stdout);
    assert.equal(line.subtype, "error_max_turns");
    assert.equal(line.num_turns, 3);
    assert.equal(loopRequests, 3);
  });

  await check("--max-turns rejects values that are not positive integers", async () => {
    for (const value of ["0", "-2", "1.5", "many"]) {
      const result = await runCli(["-p", "hi", "--max-turns", value]);
      assert.equal(result.code, 1, `--max-turns ${value}`);
      assert.match(result.stderr, /--max-turns requires a positive integer/);
    }
    const missing = await runCli(["-p", "hi", "--max-turns"]);
    assert.equal(missing.code, 1);
  });

  await check("--help documents the flag and the setting", async () => {
    const result = await runCli(["--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /--max-turns <n>/);
    assert.match(result.stdout, /maxTurns: 200/);
  });
} finally {
  server.close();
  await rm(root, { recursive: true, force: true });
}

console.log(`\nMax turns: ${passed} passed, 0 failed.`);
