/**
 * Headless (`-p`) session behavior that the output golden does not cover:
 *   - a headless run keeps nothing on disk for the session: no transcript, no
 *     `latest` pointer, no file-history backups;
 *   - MCP servers configured in settings are connected before the request,
 *     so their tools are offered and callable.
 *
 * Runs the CLI from source against a scripted Anthropic fixture.
 *
 * Run: node --import tsx src/scripts/test-headless-session.ts
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "easy-agent-headless-")));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
await Promise.all([mkdir(path.join(home, ".easy-agent"), { recursive: true }), mkdir(cwd, { recursive: true })]);

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const CLI_PATH = path.join(PROJECT_ROOT, "src", "entrypoint", "cli.ts");
const TSX_IMPORT = import.meta.resolve("tsx");

const { createAnthropicFixture, FIXTURE_MODEL } = await import("./fixtures/anthropicFixture.js");
const fixture = createAnthropicFixture();
await fixture.start();

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", TSX_IMPORT, CLI_PATH, ...args], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ANTHROPIC_MODEL: FIXTURE_MODEL,
        EASY_AGENT_DISABLE_HOOKS: "1",
        EASY_AGENT_ENABLE_TOOL_SEARCH: "false",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

const lines = (stdout: string) =>
  stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

async function listTree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true }).catch(() => [] as string[]);
  return entries.map((entry) => entry.split(path.sep).join("/")).sort();
}

/** A stdio MCP server with one `echo` tool, written next to the test data. */
async function writeEchoServer(): Promise<string> {
  const serverPath = path.join(root, "echo-server.mjs");
  const serverModule = (specifier: string) => import.meta.resolve(`@modelcontextprotocol/sdk/${specifier}`);
  await writeFile(
    serverPath,
    `
import { Server } from ${JSON.stringify(serverModule("server/index.js"))};
import { StdioServerTransport } from ${JSON.stringify(serverModule("server/stdio.js"))};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(serverModule("types.js"))};

const server = new Server({ name: "echo", version: "0.0.1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "echo",
    description: "Echo back the message argument.",
    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    annotations: { readOnlyHint: true },
  }],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: "text", text: "echo:" + String(request.params.arguments?.message ?? "") }],
}));
await server.connect(new StdioServerTransport());
`,
  );
  return serverPath;
}

try {
  console.log("\n[1] nothing on disk");

  await check("a headless run writes no transcript, no latest pointer, and no backups", async () => {
    fixture.script([
      { kind: "tool", name: "Write", input: { file_path: "written.txt", content: "hello\n" } },
      { kind: "text", text: "Wrote it." },
    ]);
    const result = await runCli(["-p", "Write a file.", "--dangerously-skip-permissions"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "Wrote it.\n");
    assert.equal(await readFile(path.join(cwd, "written.txt"), "utf8"), "hello\n");
    const easyAgentHome = path.join(home, ".easy-agent");
    const tree = await listTree(easyAgentHome);
    assert.deepEqual(
      tree.filter((entry) => /\.jsonl$|(?:^|\/)latest$|^file-history\//.test(entry)),
      [],
      `unexpected session files: ${tree.join(", ")}`,
    );
  });

  console.log("\n[2] MCP servers");

  await check("settings MCP servers are connected before the request", async () => {
    const serverPath = await writeEchoServer();
    await writeFile(
      path.join(home, ".easy-agent", "settings.json"),
      JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [serverPath] } } }),
    );
    fixture.script([
      { kind: "tool", name: "mcp__echo__echo", input: { message: "pong" } },
      { kind: "text", text: "Echoed." },
    ]);
    const result = await runCli(["-p", "Use the echo tool.", "--output-format", "stream-json"]);
    assert.equal(result.code, 0, result.stderr);
    const messages = lines(result.stdout);
    const init = messages[0] as { type?: string; tools?: string[] };
    assert.equal(init.type, "system");
    assert.ok(init.tools?.includes("mcp__echo__echo"), `tools: ${init.tools?.join(", ")}`);
    const toolResult = messages.find((message) => message.type === "user");
    assert.match(JSON.stringify(toolResult), /echo:pong/);
    assert.equal(messages.at(-1)?.subtype, "success");
  });
} finally {
  await fixture.close();
  await rm(root, { recursive: true, force: true });
}

console.log(`\nHeadless session: ${passed} passed, 0 failed.`);
process.exit(0);
