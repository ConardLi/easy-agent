import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Ajv } from "ajv";

const validateOutput = new Ajv({ strictRequired: false, allowUnionTypes: true }).compile(JSON.parse(
  await readFile(new URL("../../docs/headless-output.schema.json", import.meta.url), "utf8"),
));

function assertOutput(payload: Record<string, unknown>): void {
  assert.ok(validateOutput(payload), JSON.stringify(validateOutput.errors));
  assert.equal(validateOutput({ ...payload, schema_version: 99 }), false, "unsupported schema rejected");
  if (payload.type === "result") {
    assert.equal(validateOutput({ ...payload, total_cost_usd: "unknown" }), false, "invalid cost rejected");
  }
}

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const CLI_PATH = path.join(PROJECT_ROOT, "src", "entrypoint", "cli.ts");
const GOLDEN_PATH = path.join(
  import.meta.dirname,
  "__golden__",
  "cli-headless-characterization.golden.txt",
);
const TSX_IMPORT = import.meta.resolve("tsx");
const FIXTURE_MODEL = "fixture-model";
const FIXTURE_REPLY = "fixture reply";

interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

function event(type: string, value: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
}

function anthropicStream(): string {
  return [
    event("message_start", {
      type: "message_start",
      message: {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        model: FIXTURE_MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 0 },
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
      delta: { type: "text_delta", text: FIXTURE_REPLY },
    }),
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 3 },
    }),
    event("message_stop", { type: "message_stop" }),
  ].join("");
}

async function runCli(
  cwd: string,
  home: string,
  baseURL: string,
  args: string[],
  stdin = "",
): Promise<CliResult> {
  return new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", TSX_IMPORT, CLI_PATH, ...args], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ANTHROPIC_AUTH_TOKEN: "fixture-token",
        ANTHROPIC_BASE_URL: baseURL,
        ANTHROPIC_MODEL: FIXTURE_MODEL,
        EASY_AGENT_DISABLE_HOOKS: "1",
        EASY_AGENT_ENABLE_STREAM_DEBUG: "0",
        EASY_AGENT_ENABLE_TOOL_SEARCH: "false",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

function normalizedStructuredLines(stdout: string): string {
  return stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if ("session_id" in parsed) parsed.session_id = "<SESSION>";
      if ("duration_ms" in parsed) parsed.duration_ms = "<DURATION>";
      if ("cwd" in parsed) parsed.cwd = "<CWD>";
      if (parsed.type === "system" && parsed.subtype === "init" && Array.isArray(parsed.tools)) {
        parsed.tools = parsed.tools.filter((tool) => tool !== "PowerShell");
      }
      return JSON.stringify(parsed);
    })
    .join("\n");
}

function selectedHelpLines(stdout: string): string {
  const prefixes = [
    "Easy Agent v",
    "Usage:",
    "  eagent [options]",
    "  -p, --print",
    "  --output-format",
    "  --settings",
    "  --dangerously-skip-permissions",
  ];
  return stdout
    .split(/\r?\n/)
    .filter((line) => prefixes.some((prefix) => line.startsWith(prefix)))
    .map((line) => line.replace(/Easy Agent v\S+/, "Easy Agent v<VERSION>"))
    .join("\n");
}

function requestSummary(request: CapturedRequest): string {
  const messages = Array.isArray(request.body.messages) ? request.body.messages : [];
  return JSON.stringify({
    method: request.method,
    path: request.url,
    model: request.body.model,
    stream: request.body.stream,
    messages,
    hasApiKey: typeof request.headers["x-api-key"] === "string",
  });
}

async function buildRecording(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "easy-agent-cli-headless-"));
  const cwd = path.join(root, "project");
  const home = path.join(root, "home");
  const requests: CapturedRequest[] = [];
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(home, { recursive: true })]);

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      });
      if (requests.at(-1)?.body.model === "fixture-failure") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "fixture authentication failure" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(anthropicStream());
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const baseURL = `http://127.0.0.1:${address.port}`;
  const sections: string[] = [];

  try {
    const version = await runCli(cwd, home, baseURL, ["--version"]);
    assert.equal(version.code, 0);
    sections.push(`### version\n${version.stdout.trim().replace(/eagent \S+/, "eagent <VERSION>")}`);

    const help = await runCli(cwd, home, baseURL, ["--help"]);
    assert.equal(help.code, 0);
    sections.push(`### help\n${selectedHelpLines(help.stdout)}`);

    const invalidFormat = await runCli(cwd, home, baseURL, [
      "--print",
      "hello",
      "--output-format",
      "xml",
    ]);
    assert.equal(invalidFormat.code, 1);
    sections.push(`### invalid-format\nstderr: ${invalidFormat.stderr.trim()}`);

    const missingInput = await runCli(cwd, home, baseURL, ["--print", "--output-format", "json"]);
    assert.equal(missingInput.code, 1);
    sections.push(`### missing-input\nstderr: ${missingInput.stderr.trim()}`);

    const beforeText = requests.length;
    const textResult = await runCli(
      cwd,
      home,
      baseURL,
      ["--print", "Summarize the context.", "--model", FIXTURE_MODEL],
      "alpha\nbeta\n",
    );
    assert.equal(textResult.code, 0, textResult.stderr);
    assert.equal(textResult.stdout, `${FIXTURE_REPLY}\n`);
    assert.equal(requests.length, beforeText + 1);
    sections.push(
      `### text\nstdout: ${JSON.stringify(textResult.stdout)}\nrequest: ${requestSummary(requests.at(-1)!)}`,
    );

    const beforeJson = requests.length;
    const jsonResult = await runCli(cwd, home, baseURL, [
      "--print",
      "Return JSON.",
      "--output-format",
      "json",
      "--model",
      FIXTURE_MODEL,
    ]);
    assert.equal(jsonResult.code, 0, jsonResult.stderr);
    assert.equal(requests.length, beforeJson + 1);
    const jsonPayload = JSON.parse(jsonResult.stdout) as Record<string, unknown>;
    assertOutput(jsonPayload);
    assert.equal(jsonPayload.schema_version, 1, "JSON result declares headless schema v1");
    assert.equal(jsonPayload.total_cost_usd, null, "unknown cost is null, never a fabricated zero");
    for (const field of ["type", "subtype", "is_error", "result", "session_id", "num_turns", "duration_ms", "usage"]) {
      assert.ok(field in jsonPayload, `JSON result preserves compatibility field ${field}`);
    }
    sections.push(
      `### json\n${normalizedStructuredLines(jsonResult.stdout)}\nrequest: ${requestSummary(requests.at(-1)!)}`,
    );

    const beforeStream = requests.length;
    const streamResult = await runCli(cwd, home, baseURL, [
      "--print",
      "Return a stream.",
      "--output-format",
      "stream-json",
      "--model",
      FIXTURE_MODEL,
    ]);
    assert.equal(streamResult.code, 0, streamResult.stderr);
    assert.equal(requests.length, beforeStream + 1);
    const streamPayloads = streamResult.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);
    streamPayloads.forEach(assertOutput);
    assert.ok(streamPayloads.length >= 3, "stream-json emits init, events, and result");
    assert.ok(streamPayloads.every((payload) => payload.schema_version === 1), "every stream-json message declares schema v1");
    assert.equal(streamPayloads.at(-1)?.total_cost_usd, null, "stream result reports unknown cost as null");
    sections.push(
      `### stream-json\n${normalizedStructuredLines(streamResult.stdout)}\nrequest: ${requestSummary(requests.at(-1)!)}`,
    );
    for (const format of ["json", "stream-json"]) {
      const failed = await runCli(cwd, home, baseURL, ["--print", "Fail deterministically", "--model", "fixture-failure", "--output-format", format]);
      assert.equal(failed.code, 1, failed.stderr);
      const payloads = failed.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);
      payloads.forEach(assertOutput);
      const result = payloads.at(-1)!;
      assert.equal(result.type, "result");
      assert.equal(result.subtype, "error_during_execution");
      assert.equal(result.is_error, true);
      assert.equal(result.total_cost_usd, null);
      assert.ok(typeof result.result === "string" && result.result.length > 0, "failure carries actionable text");
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(root, { recursive: true, force: true });
  }

  return sections.join("\n\n");
}

async function main(): Promise<void> {
  const recording = await buildRecording();
  const update = process.argv.includes("--update");
  await mkdir(path.dirname(GOLDEN_PATH), { recursive: true });

  if (update) {
    await writeFile(GOLDEN_PATH, recording, "utf8");
    process.stdout.write(`[updated] golden written to ${GOLDEN_PATH}\n`);
    return;
  }

  const golden = (await readFile(GOLDEN_PATH, "utf8")).replace(/\r\n?/g, "\n");
  assert.equal(recording, golden, "CLI/headless characterization mismatch; use --update only for intentional changes");
  process.stdout.write(`[pass] CLI/headless characterization matches golden (${recording.split("\n").length} lines).\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
