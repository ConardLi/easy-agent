import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const CLI_PATH = path.join(PROJECT_ROOT, "src", "entrypoint", "cli.ts");
const TSX_IMPORT = import.meta.resolve("tsx");

interface CapturedRequest {
  headers: IncomingHttpHeaders;
  url: string;
}

interface TestServer {
  baseURL: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

function event(type: string, value: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
}

function responseStream(): string {
  return [
    event("message_start", {
      type: "message_start",
      message: {
        id: "msg_config_trust",
        type: "message",
        role: "assistant",
        model: "fixture-model",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "ok" },
    }),
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    event("message_stop", { type: "message_stop" }),
  ].join("");
}

async function startServer(): Promise<TestServer> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests.push({ headers: request.headers, url: request.url ?? "" });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(responseStream());
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function runCli(
  cwd: string,
  home: string,
  baseURL: string,
  extraArgs: string[] = [],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        TSX_IMPORT,
        CLI_PATH,
        "--print",
        "reply",
        "--model",
        "fixture-model",
        ...extraArgs,
      ],
      {
        cwd,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          ANTHROPIC_AUTH_TOKEN: "parent-token",
          ANTHROPIC_BASE_URL: baseURL,
          ANTHROPIC_MODEL: "fixture-model",
          EASY_AGENT_DISABLE_HOOKS: "1",
          EASY_AGENT_ENABLE_STREAM_DEBUG: "0",
          EASY_AGENT_ENABLE_TOOL_SEARCH: "false",
          NO_COLOR: "1",
          FORCE_COLOR: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
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

const root = await fs.mkdtemp(path.join(os.tmpdir(), "easy-agent-config-trust-cli-"));
const project = path.join(root, "project");
const home = path.join(root, "home");
const safe = await startServer();
const projectEndpoint = await startServer();

try {
  await Promise.all([fs.mkdir(project, { recursive: true }), fs.mkdir(home, { recursive: true })]);
  await fs.writeFile(
    path.join(project, ".env"),
    `ANTHROPIC_BASE_URL=${projectEndpoint.baseURL}\nANTHROPIC_AUTH_TOKEN=project-token\n`,
    "utf8",
  );

  const untrusted = await runCli(project, home, safe.baseURL);
  assert.equal(untrusted.code, 0, untrusted.stderr);
  assert.equal(untrusted.stdout, "ok\n");
  assert.equal(safe.requests.length, 1);
  assert.equal(projectEndpoint.requests.length, 0);
  assert.match(untrusted.stderr, /Project configuration ignored/);
  assert.ok(!untrusted.stderr.includes(projectEndpoint.baseURL));
  assert.ok(!untrusted.stderr.includes("project-token"));

  const explicitlyTrusted = await runCli(project, home, safe.baseURL, [
    "--trust-project-config",
  ]);
  assert.equal(explicitlyTrusted.code, 0, explicitlyTrusted.stderr);
  assert.equal(explicitlyTrusted.stdout, "ok\n");
  assert.equal(safe.requests.length, 1);
  assert.equal(projectEndpoint.requests.length, 1);
  assert.equal(projectEndpoint.requests[0]?.headers["x-api-key"], "parent-token");
  assert.ok(!explicitlyTrusted.stderr.includes("project-token"));
  await assert.rejects(fs.access(path.join(home, ".easy-agent", "state.json")));

  process.stdout.write("Headless configuration trust boundary passed.\n");
} finally {
  await Promise.all([safe.close(), projectEndpoint.close()]);
  await fs.rm(root, { recursive: true, force: true });
}
