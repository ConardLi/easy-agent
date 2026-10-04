/**
 * RPC protocol tests.
 *
 * Starts `eagent --rpc` from source as a child process against a scripted
 * Anthropic fixture and talks to it over stdio, like an editor or desktop
 * app would. Every line the server writes is validated against the published
 * JSON Schema, and every result against the method's result schema.
 *
 * Covers the protocol layer (initialize and version negotiation, JSON-RPC
 * errors), conversations (text, permission round trips, interrupt, questions,
 * busy and queued sends, local commands), session management, resume, the
 * security boundaries under RPC, process lifecycle, and the example client.
 *
 * Run: node --import tsx src/scripts/test-rpc.ts
 */

import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { Ajv2020 } from "ajv/dist/2020.js";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "easy-agent-rpc-")));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
await Promise.all([
  mkdir(path.join(home, ".easy-agent"), { recursive: true }),
  mkdir(path.join(cwd, ".easy-agent"), { recursive: true }),
]);
// A user-level deny rule RPC clients must not be able to override.
await writeFile(path.join(home, ".easy-agent", "settings.json"), JSON.stringify({ deny: ["WebFetch"] }));
// Project config that only applies once the workspace is trusted.
await writeFile(path.join(cwd, ".easy-agent", "settings.json"), JSON.stringify({ allow: ["Edit"] }));

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const CLI_PATH = path.join(PROJECT_ROOT, "src", "entrypoint", "cli.ts");
const TSX_IMPORT = import.meta.resolve("tsx");

const { createAnthropicFixture, FIXTURE_MODEL } = await import("./fixtures/anthropicFixture.js");
const fixture = createAnthropicFixture();
await fixture.start();

const protocol = await import("../rpc/protocol.js");
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(JSON.parse(await readFile(path.join(PROJECT_ROOT, "docs", "rpc-protocol.schema.json"), "utf8")), "rpc");
const validateServerMessage = ajv.getSchema("rpc#/properties/ServerMessage")!;
const validateClientMessage = ajv.getSchema("rpc#/properties/ClientMessage")!;

const childEnv = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  ANTHROPIC_MODEL: FIXTURE_MODEL,
  EASY_AGENT_DISABLE_HOOKS: "1",
  EASY_AGENT_ENABLE_TOOL_SEARCH: "false",
  NO_COLOR: "1",
};

type Json = Record<string, unknown>;
interface RpcEvent extends Json {
  type: string;
  sessionId: string;
  seq: number;
}
class RpcFailure extends Error {
  constructor(readonly error: { code: number; message: string; data?: Json }) {
    super(`${error.message} (${error.code})`);
  }
}

/** One `eagent --rpc` process and the messages it sent. */
class RpcClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly events: RpcEvent[] = [];
  readonly logs: Json[] = [];
  readonly lines: Json[] = [];
  stderr = "";
  readonly exited: Promise<number | null>;
  #nextId = 1;
  readonly #pending = new Map<
    number | string,
    { method: string; resolve(v: unknown): void; reject(e: unknown): void }
  >();
  readonly #orphans: Json[] = [];

  constructor(extraArgs: string[] = []) {
    this.child = spawn(process.execPath, ["--import", TSX_IMPORT, CLI_PATH, "--rpc", ...extraArgs], {
      cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", (chunk: Buffer) => (this.stderr += chunk.toString("utf8")));
    this.exited = new Promise((resolve) => this.child.once("close", (code) => resolve(code)));
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => this.#onLine(line));
  }

  #onLine(line: string): void {
    const message = JSON.parse(line) as Json;
    this.lines.push(message);
    assert.ok(validateServerMessage(message), `schema: ${line}\n${JSON.stringify(validateServerMessage.errors)}`);
    if (message.method === "session/event") {
      this.events.push(message.params as RpcEvent);
      return;
    }
    if (message.method === "runtime/log") {
      this.logs.push(message.params as Json);
      return;
    }
    const pending = this.#pending.get(message.id as number);
    if (!pending) {
      this.#orphans.push(message);
      return;
    }
    this.#pending.delete(message.id as number);
    if (message.error) pending.reject(new RpcFailure(message.error as RpcFailure["error"]));
    else {
      const resultSchema = protocol.MethodResults[pending.method as keyof typeof protocol.MethodResults];
      const parsed = resultSchema?.safeParse(message.result);
      assert.ok(!parsed || parsed.success, `result of ${pending.method}: ${JSON.stringify(parsed?.error?.issues)}`);
      pending.resolve(message.result);
    }
  }

  /** Write a raw line and return the next response that has no matching request. */
  async raw(line: string): Promise<Json> {
    const before = this.#orphans.length;
    this.child.stdin.write(`${line}\n`);
    await until("raw response", () => this.#orphans.length > before);
    return this.#orphans[before]!;
  }

  /** Send a request; `valid: false` marks one the test sends malformed on purpose. */
  call<T = Json>(method: string, params: Json = {}, { valid = true } = {}): Promise<T> {
    const id = this.#nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    if (valid && method in protocol.MethodParams) assert.ok(validateClientMessage(message), `client schema: ${method}`);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    return new Promise((resolve, reject) => this.#pending.set(id, { method, resolve: resolve as never, reject }));
  }

  async initialize(params: Json = {}): Promise<Json> {
    return this.call("initialize", { protocolVersion: 1, clientInfo: { name: "test-rpc" }, ...params });
  }

  eventsOf(sessionId: string, ...types: string[]): RpcEvent[] {
    return this.events.filter(
      (event) => event.sessionId === sessionId && (types.length === 0 || types.includes(event.type)),
    );
  }

  async waitForEvent(label: string, predicate: (event: RpcEvent) => boolean): Promise<RpcEvent> {
    await until(label, () => this.events.some(predicate));
    return this.events.find(predicate)!;
  }

  async shutdown(): Promise<number | null> {
    await this.call("shutdown");
    return this.exited;
  }
}

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function until(label: string, predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function rejects(promise: Promise<unknown>, code: number, sdkCode?: string): Promise<RpcFailure> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof RpcFailure, String(error));
    assert.equal(error.error.code, code, error.message);
    if (sdkCode) assert.equal(error.error.data?.code, sdkCode);
    return error;
  }
  throw new Error(`expected an RPC error ${code}`);
}

const opened = (client: RpcClient, sessionId: string) =>
  client.eventsOf(sessionId, "request_opened").map((event) => event.request as Json);

const QUESTION = {
  questions: [{ question: "Which size?", header: "Size", options: [{ label: "S" }, { label: "L" }] }],
};

const clients: RpcClient[] = [];
function startClient(args: string[] = []): RpcClient {
  const client = new RpcClient(args);
  clients.push(client);
  return client;
}

try {
  console.log("\n[1] protocol");
  const rpc = startClient();

  await check("requests before initialize are rejected", async () => {
    await rejects(rpc.call("session/list"), protocol.RpcErrorCode.NotInitialized);
  });

  await check("malformed lines get JSON-RPC errors and the server keeps going", async () => {
    const parse = await rpc.raw("{not json");
    assert.deepEqual(parse.id, null);
    assert.equal((parse.error as Json).code, protocol.RpcErrorCode.ParseError);
    const invalid = await rpc.raw(JSON.stringify({ id: 7, method: "initialize" }));
    assert.equal(invalid.id, 7);
    assert.equal((invalid.error as Json).code, protocol.RpcErrorCode.InvalidRequest);
    const batch = await rpc.raw(JSON.stringify([{ jsonrpc: "2.0", id: 8, method: "shutdown" }]));
    assert.equal((batch.error as Json).code, protocol.RpcErrorCode.InvalidRequest);
    await rejects(rpc.call("session/teleport"), protocol.RpcErrorCode.MethodNotFound);
  });

  await check("an unsupported protocol version is rejected with the supported list", async () => {
    const failure = await rejects(
      rpc.initialize({ protocolVersion: 99 }),
      protocol.RpcErrorCode.UnsupportedProtocolVersion,
    );
    assert.deepEqual(failure.error.data?.supported, [1]);
  });

  let init: Json;
  await check("initialize bootstraps the workspace and reports it", async () => {
    init = await rpc.initialize();
    assert.equal(init.protocolVersion, 1);
    assert.equal(init.sessionProtocolVersion, 1);
    const workspace = init.workspace as Json;
    assert.equal(workspace.cwd, cwd);
    assert.equal(workspace.projectTrusted, false);
    assert.ok(((init.capabilities as Json).builtinCommands as string[]).includes("help"));
    await rejects(rpc.initialize(), protocol.RpcErrorCode.AlreadyInitialized);
  });

  await check("invalid params and unknown sessions are reported precisely", async () => {
    const failure = await rejects(
      rpc.call("session/send", { sessionId: "x" }, { valid: false }),
      protocol.RpcErrorCode.InvalidParams,
    );
    assert.ok(Array.isArray(failure.error.data?.issues));
    const missing = await rejects(
      rpc.call("session/send", { sessionId: "nope", input: "hi" }),
      protocol.RpcErrorCode.SessionNotFound,
    );
    assert.equal(missing.error.data?.sessionId, "nope");
  });

  console.log("\n[2] conversations");

  let sessionId = "";
  await check("session/create returns the state after a state_snapshot event", async () => {
    const created = await rpc.call<{ sessionId: string; state: Json }>("session/create", { model: FIXTURE_MODEL });
    sessionId = created.sessionId;
    assert.equal(created.state.busy, false);
    const [first] = rpc.eventsOf(sessionId);
    assert.equal(first?.type, "state_snapshot");
  });

  await check("a text turn streams events and resolves with the turn result", async () => {
    fixture.script([{ kind: "text", text: "Hello over RPC." }]);
    const result = await rpc.call("session/send", { sessionId, input: "Say hello." });
    assert.equal(result.reason, "completed");
    assert.equal(result.handled, true);
    const types = rpc.eventsOf(sessionId, "turn_started", "text_delta", "turn_completed").map((event) => event.type);
    assert.deepEqual(types, ["turn_started", "text_delta", "turn_completed"]);
    const seqs = rpc.eventsOf(sessionId).map((event) => event.seq);
    assert.deepEqual(
      seqs.slice(1),
      seqs.slice(1).map((_, i) => seqs[1]! + i),
      "sequence numbers are consecutive",
    );
  });

  await check("images sent with a turn reach the model; a bad image is invalid", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    fixture.script([{ kind: "text", text: "A pixel." }]);
    await rpc.call("session/send", {
      sessionId,
      input: "What is this?",
      images: [{ data: png, mimeType: "image/png" }],
    });
    assert.match(JSON.stringify((fixture.requests.at(-1)!.messages as unknown[]).at(-1)), /"type":"image"/);
    await rejects(
      rpc.call("session/send", { sessionId, input: "And this?", images: [{ data: png, mimeType: "image/tiff" }] }),
      protocol.RpcErrorCode.AgentError,
      "invalid_argument",
    );
  });

  await check("a permission request round-trips and names its tool call", async () => {
    fixture.script([
      { kind: "tool", name: "Write", input: { file_path: "rpc-allowed.txt", content: "ok\n" } },
      { kind: "text", text: "Done." },
    ]);
    const done = rpc.call("session/send", { sessionId, input: "Write a file." });
    await until("permission request", () => opened(rpc, sessionId).length === 1);
    const request = opened(rpc, sessionId)[0]!;
    assert.equal(request.kind, "permission");
    const started = rpc.eventsOf(sessionId, "tool_started").at(-1)!;
    assert.equal(request.toolUseId, started.toolUseId);
    const state = await rpc.call<Json>("session/state", { sessionId });
    assert.deepEqual(
      (state.pendingRequests as Json[]).map((pending) => pending.id),
      [request.id],
    );
    assert.deepEqual(
      await rpc.call("session/respond", { sessionId, requestId: request.id, response: { decision: "allow_once" } }),
      { outcome: "resolved" },
    );
    assert.deepEqual(
      await rpc.call("session/respond", { sessionId, requestId: request.id, response: { decision: "allow_once" } }),
      { outcome: "stale" },
    );
    assert.equal((await done).reason, "completed");
    assert.equal(await readFile(path.join(cwd, "rpc-allowed.txt"), "utf8"), "ok\n");
  });

  await check("a response of the wrong kind is invalid params", async () => {
    fixture.script([
      { kind: "tool", name: "Write", input: { file_path: "rpc-wrong.txt", content: "x" } },
      { kind: "text", text: "Denied." },
    ]);
    const before = opened(rpc, sessionId).length;
    const done = rpc.call("session/send", { sessionId, input: "Write it." });
    await until("permission request", () => opened(rpc, sessionId).length === before + 1);
    const request = opened(rpc, sessionId).at(-1)!;
    await rejects(
      rpc.call("session/respond", { sessionId, requestId: request.id, response: { answers: {} } }, { valid: false }),
      protocol.RpcErrorCode.InvalidParams,
    );
    await rpc.call("session/respond", { sessionId, requestId: request.id, response: { decision: "deny" } });
    await done;
    await assert.rejects(readFile(path.join(cwd, "rpc-wrong.txt")));
  });

  await check("interrupt during a permission request denies it and ends the turn", async () => {
    fixture.script([{ kind: "tool", name: "Write", input: { file_path: "rpc-interrupted.txt", content: "x" } }]);
    const before = opened(rpc, sessionId).length;
    const done = rpc.call("session/send", { sessionId, input: "Write it." });
    await until("permission request", () => opened(rpc, sessionId).length === before + 1);
    assert.deepEqual(await rpc.call("session/interrupt", { sessionId }), { outcome: "permission_denied" });
    assert.equal((await done).reason, "aborted");
    assert.equal(fixture.remaining(), 0);
    assert.deepEqual(await rpc.call("session/interrupt", { sessionId }), { outcome: "idle" });
  });

  await check("a question is answered over RPC", async () => {
    fixture.script([
      { kind: "tool", name: "AskUserQuestion", input: QUESTION },
      { kind: "text", text: "Large it is." },
    ]);
    const before = opened(rpc, sessionId).length;
    const done = rpc.call("session/send", { sessionId, input: "Ask me." });
    await until("question", () => opened(rpc, sessionId).length === before + 1);
    const request = opened(rpc, sessionId).at(-1)!;
    assert.equal(request.kind, "question");
    await rpc.call("session/respond", {
      sessionId,
      requestId: request.id,
      response: { answers: { "Which size?": "L" } },
    });
    assert.equal((await done).reason, "completed");
    const toolResult = rpc.eventsOf(sessionId, "tool_completed").at(-1)!;
    assert.match(JSON.stringify(toolResult.result), /User has answered your questions: .*Which size\?.*L/);
  });

  await check("a second send while busy fails with busy; queue waits its turn", async () => {
    fixture.script([
      { kind: "tool", name: "Write", input: { file_path: "rpc-busy.txt", content: "x" } },
      { kind: "text", text: "First." },
      { kind: "text", text: "Second." },
    ]);
    const before = opened(rpc, sessionId).length;
    const first = rpc.call("session/send", { sessionId, input: "First." });
    await until("permission request", () => opened(rpc, sessionId).length === before + 1);
    await rejects(rpc.call("session/send", { sessionId, input: "Second." }), protocol.RpcErrorCode.AgentError, "busy");
    const queued = rpc.call("session/send", { sessionId, input: "Second.", queue: true });
    const request = opened(rpc, sessionId).at(-1)!;
    await rpc.call("session/respond", { sessionId, requestId: request.id, response: { decision: "deny" } });
    await first;
    assert.equal((await queued).reason, "completed");
  });

  await check("local commands and shell commands run without the model", async () => {
    const before = fixture.requests.length;
    await rpc.call("session/command", { sessionId, name: "mode", args: ["plan"] });
    assert.equal(rpc.eventsOf(sessionId, "mode_changed").at(-1)?.mode, "plan");
    assert.equal((await rpc.call<Json>("session/state", { sessionId })).permissionMode as string, "plan");
    await rpc.call("session/command", { sessionId, name: "mode", args: ["default"] });
    const shell = await rpc.call<{ output: string; isError: boolean }>("session/shell", {
      sessionId,
      command: "echo rpc-shell",
    });
    assert.match(shell.output, /rpc-shell/);
    assert.equal(fixture.requests.length, before);
  });

  console.log("\n[3] saved sessions");

  await check("list, rename, read, fork, and delete saved sessions", async () => {
    await rpc.call("session/close", { sessionId });
    await rejects(rpc.call("session/state", { sessionId }), protocol.RpcErrorCode.SessionNotFound);

    const renamed = await rpc.call<{ session: Json }>("session/rename", { sessionId, title: "RPC demo" });
    assert.equal(renamed.session.title, "RPC demo");
    const { sessions } = await rpc.call<{ sessions: Json[] }>("session/list");
    const listed = sessions.find((session) => session.sessionId === sessionId)!;
    assert.equal(listed.title, "RPC demo");
    assert.equal(listed.firstPrompt, "Say hello.");

    const read = await rpc.call<{ messages: unknown[] }>("session/read", { sessionId });
    const fork = await rpc.call<{ session: Json }>("session/fork", { sessionId, title: "RPC demo (fork)" });
    const forkId = fork.session.sessionId as string;
    assert.notEqual(forkId, sessionId);
    assert.equal(fork.session.title, "RPC demo (fork)");
    const forkRead = await rpc.call<{ messages: unknown[] }>("session/read", { sessionId: forkId });
    assert.deepEqual(forkRead.messages, read.messages);

    await rpc.call("session/delete", { sessionId: forkId });
    await rejects(rpc.call("session/read", { sessionId: forkId }), protocol.RpcErrorCode.AgentError, "not_found");
    await rejects(
      rpc.call("session/read", { sessionId: "../escape" }),
      protocol.RpcErrorCode.AgentError,
      "invalid_argument",
    );
  });

  console.log("\n[4] resume");

  await check("a saved session resumes with its messages; /resume inside a session replaces its id", async () => {
    const resumed = await rpc.call<{ sessionId: string; state: Json }>("session/resume", { sessionId });
    assert.equal(resumed.sessionId, sessionId);
    const restoredCount = (resumed.state.messages as unknown[]).length;
    assert.ok(restoredCount >= 2);
    await rejects(rpc.call("session/delete", { sessionId }), protocol.RpcErrorCode.AgentError, "already_open");
    await rpc.call("session/close", { sessionId });

    const fresh = await rpc.call<{ sessionId: string }>("session/create", { model: FIXTURE_MODEL });
    await rpc.call("session/send", { sessionId: fresh.sessionId, input: `/resume ${sessionId}` });
    const replaced = await rpc.waitForEvent("session_replaced", (event) => event.type === "session_replaced");
    assert.equal(replaced.sessionId, sessionId);
    const failure = await rejects(
      rpc.call("session/state", { sessionId: fresh.sessionId }),
      protocol.RpcErrorCode.AgentError,
      "replaced",
    );
    assert.equal(failure.error.data?.replacedBy, sessionId);
    const state = await rpc.call<Json>("session/state", { sessionId });
    assert.equal((state.messages as unknown[]).length, restoredCount);
    await rpc.call("session/close", { sessionId });
  });

  console.log("\n[5] security boundaries");

  await check("deny rules hold and the workspace stays untrusted unless the client asks", async () => {
    const created = await rpc.call<{ sessionId: string }>("session/create", { model: FIXTURE_MODEL });
    const id = created.sessionId;
    fixture.script([
      { kind: "tool", name: "WebFetch", input: { url: "https://example.com", prompt: "summarize" } },
      { kind: "tool", name: "Edit", input: { file_path: "rpc-allowed.txt", old_string: "ok", new_string: "edited" } },
      { kind: "text", text: "Done." },
    ]);
    const done = rpc.call("session/send", { sessionId: id, input: "Fetch, then edit." });
    // WebFetch is denied without a request; Edit is asked because the project allow rule is ignored.
    await until("edit permission", () => opened(rpc, id).length === 1);
    const request = opened(rpc, id)[0]!;
    assert.equal(request.toolName, "Edit");
    await rpc.call("session/respond", { sessionId: id, requestId: request.id, response: { decision: "deny" } });
    await done;
    const fetch = rpc.eventsOf(id, "tool_completed").find((event) => event.name === "WebFetch")!;
    assert.equal((fetch.result as Json).isError, true);
    assert.equal(await readFile(path.join(cwd, "rpc-allowed.txt"), "utf8"), "ok\n");
  });

  await check("lifecycle: shutdown answers, closes sessions, and exits 0", async () => {
    assert.equal(await rpc.shutdown(), 0);
    assert.equal(rpc.lines.at(-1)?.result !== undefined, true, "the shutdown response is the last message");
  });

  await check('trust: "session" applies project config for that process only', async () => {
    const trusted = startClient();
    const init = await trusted.initialize({ trust: "session", services: "wait" });
    assert.equal((init.workspace as Json).projectTrusted, true);
    const { sessionId: id } = await trusted.call<{ sessionId: string }>("session/create", { model: FIXTURE_MODEL });
    fixture.script([
      { kind: "tool", name: "Edit", input: { file_path: "rpc-allowed.txt", old_string: "ok", new_string: "edited" } },
      { kind: "text", text: "Edited." },
    ]);
    await trusted.call("session/send", { sessionId: id, input: "Edit it." });
    assert.equal(opened(trusted, id).length, 0, "the project allow rule applies");
    assert.equal(await readFile(path.join(cwd, "rpc-allowed.txt"), "utf8"), "edited\n");
    assert.equal(await trusted.shutdown(), 0);

    const again = startClient();
    const reinit = await again.initialize();
    assert.equal((reinit.workspace as Json).projectTrusted, false, "trust was not persisted");
    again.child.stdin.end();
    assert.equal(await again.exited, 0, "closing stdin exits cleanly");
  });

  await check("requests pipelined behind initialize wait for it, and closing stdin still answers them", async () => {
    const piped = startClient();
    const init = piped.call("initialize", { protocolVersion: 1 });
    const list = piped.call<{ sessions: unknown[] }>("session/list");
    piped.child.stdin.end();
    await init;
    assert.ok(Array.isArray((await list).sessions));
    assert.equal(await piped.exited, 0);
  });

  await check("the --rpc flag cannot be combined with --print", async () => {
    const bad = startClient(["--print", "hi"]);
    assert.equal(await bad.exited, 1);
    assert.match(bad.stderr, /cannot be combined/);
  });

  console.log("\n[6] example client");

  await check("examples/rpc-client.mjs runs a turn and approves with --yes", async () => {
    fixture.script([
      { kind: "tool", name: "Write", input: { file_path: "rpc-example.txt", content: "from example\n" } },
      { kind: "text", text: "Example done." },
    ]);
    const example = spawn(
      process.execPath,
      [path.join(PROJECT_ROOT, "examples", "rpc-client.mjs"), "--yes", "Write a file."],
      {
        cwd,
        env: { ...childEnv, EAGENT_COMMAND: `${process.execPath} --import ${TSX_IMPORT} ${CLI_PATH}` },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    example.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    example.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const code = await new Promise<number | null>((resolve) => example.once("close", resolve));
    assert.equal(code, 0, stderr);
    assert.match(stdout, /Example done\./);
    assert.match(stdout, /\[stopped: completed\]/);
    assert.equal(await readFile(path.join(cwd, "rpc-example.txt"), "utf8"), "from example\n");
  });

  await check("the published schema is generated from the protocol definitions", async () => {
    const published = JSON.parse(await readFile(path.join(PROJECT_ROOT, "docs", "rpc-protocol.schema.json"), "utf8"));
    assert.deepEqual(published, JSON.parse(JSON.stringify(protocol.buildRpcJsonSchema())));
  });
} finally {
  for (const client of clients) if (client.child.exitCode === null) client.child.kill();
  await fixture.close();
  await rm(root, { recursive: true, force: true });
}

console.log(`\nRPC: ${passed} passed, 0 failed.`);
process.exit(0);
