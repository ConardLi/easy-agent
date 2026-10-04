/**
 * Agent Client Protocol tests.
 *
 * Starts `eagent --acp` from source against a scripted Anthropic fixture and
 * drives it with the official ACP TypeScript client (`@agentclientprotocol/sdk`),
 * the way an editor would. Every message the agent writes is also validated
 * against the protocol's published JSON Schema.
 *
 * Covers initialization and authentication, session setup (new, load with
 * replay, resume, list, close, delete), prompt turns with streamed text, tool
 * calls and permission requests, cancellation, plan approval, questions as
 * form elicitations, modes, slash commands, images and embedded context,
 * MCP servers supplied by the editor, and the permission rules and workspace
 * trust under ACP.
 *
 * Run: node --import tsx src/scripts/test-acp.ts
 */

import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { PassThrough, Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { Ajv2020 } from "ajv/dist/2020.js";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "easy-agent-acp-")));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
await Promise.all([
  mkdir(path.join(home, ".easy-agent"), { recursive: true }),
  mkdir(path.join(cwd, ".easy-agent"), { recursive: true }),
]);
await writeFile(path.join(home, ".easy-agent", "settings.json"), JSON.stringify({ deny: ["WebFetch"] }));
await writeFile(path.join(cwd, ".easy-agent", "settings.json"), JSON.stringify({ allow: ["Edit"] }));
await writeFile(path.join(cwd, "notes.txt"), "draft\n");

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const CLI_PATH = path.join(PROJECT_ROOT, "src", "entrypoint", "cli.ts");
const TSX_IMPORT = import.meta.resolve("tsx");
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const { createAnthropicFixture, FIXTURE_MODEL } = await import("./fixtures/anthropicFixture.js");
const fixture = createAnthropicFixture();
await fixture.start();

const acpSchema = createRequire(import.meta.url)("@agentclientprotocol/sdk/schema/schema.json") as object;
// The schema uses integer formats such as uint64 that Ajv does not define; the integer type is still checked.
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(acpSchema, "acp");
const validator = (name: string) => {
  const validate = ajv.getSchema(`acp#/$defs/${name}`);
  assert.ok(validate, `schema definition ${name}`);
  return validate;
};
/** Schema of each agent→client message, by method. */
const OUTGOING = {
  "session/update": validator("SessionNotification"),
  "session/request_permission": validator("RequestPermissionRequest"),
  "elicitation/create": validator("CreateElicitationRequest"),
  "$/cancel_request": validator("CancelRequestNotification"),
};
/** Schema of each response, by the client method it answers. */
const RESULTS: Record<string, ReturnType<typeof validator>> = {
  initialize: validator("InitializeResponse"),
  authenticate: validator("AuthenticateResponse"),
  "session/new": validator("NewSessionResponse"),
  "session/load": validator("LoadSessionResponse"),
  "session/resume": validator("ResumeSessionResponse"),
  "session/list": validator("ListSessionsResponse"),
  "session/close": validator("CloseSessionResponse"),
  "session/delete": validator("DeleteSessionResponse"),
  "session/prompt": validator("PromptResponse"),
  "session/set_mode": validator("SetSessionModeResponse"),
};

const baseEnv = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  ANTHROPIC_MODEL: FIXTURE_MODEL,
  EASY_AGENT_DISABLE_HOOKS: "1",
  EASY_AGENT_ENABLE_TOOL_SEARCH: "false",
  NO_COLOR: "1",
};

type Json = Record<string, unknown>;
type Update = acp.SessionNotification["update"];
type PermissionHandler = (params: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>;
type ElicitationHandler = (params: acp.CreateElicitationRequest) => Promise<acp.CreateElicitationResponse>;

/** One `eagent --acp` process with an ACP client connected to it. */
class AcpProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly connection: acp.ClientSideConnection;
  readonly updates: acp.SessionNotification[] = [];
  readonly permissionRequests: acp.RequestPermissionRequest[] = [];
  readonly elicitations: acp.CreateElicitationRequest[] = [];
  readonly raw: Json[] = [];
  stderr = "";
  onPermission: PermissionHandler = async () => ({ outcome: { outcome: "selected", optionId: "allow-once" } });
  onElicitation: ElicitationHandler = async () => ({ action: "cancel" });
  readonly exited: Promise<number | null>;
  readonly #clientMethods = new Map<unknown, string>();

  constructor({ args = [], env = {}, spawnCwd = cwd }: { args?: string[]; env?: Json; spawnCwd?: string } = {}) {
    this.child = spawn(process.execPath, ["--import", TSX_IMPORT, CLI_PATH, "--acp", ...args], {
      cwd: spawnCwd,
      env: { ...baseEnv, ...env } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", (chunk: Buffer) => (this.stderr += chunk.toString("utf8")));
    this.exited = new Promise((resolve) => this.child.once("close", (code) => resolve(code)));

    const toAgent = new PassThrough();
    toAgent.pipe(this.child.stdin);
    readline.createInterface({ input: toAgent }).on("line", (line) => {
      const message = JSON.parse(line) as Json;
      if (typeof message.method === "string" && "id" in message) this.#clientMethods.set(message.id, message.method);
    });
    const fromAgent = new PassThrough();
    this.child.stdout.pipe(fromAgent);
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => this.#validate(line));

    const client: acp.Client = {
      requestPermission: (params) => {
        this.permissionRequests.push(params);
        return this.onPermission(params);
      },
      sessionUpdate: async (params) => {
        this.updates.push(params);
      },
      createElicitation: (params) => {
        this.elicitations.push(params);
        return this.onElicitation(params);
      },
    };
    this.connection = new acp.ClientSideConnection(
      () => client,
      acp.ndJsonStream(Writable.toWeb(toAgent), Readable.toWeb(fromAgent) as ReadableStream<Uint8Array>),
    );
  }

  /** Every line on stdout is a JSON-RPC message that matches the ACP schema. */
  #validate(line: string): void {
    let message: Json;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      throw new Error(`non-JSON line on stdout: ${line}`);
    }
    this.raw.push(message);
    assert.equal(message.jsonrpc, "2.0", line);
    if (typeof message.method === "string") {
      const validate = OUTGOING[message.method as keyof typeof OUTGOING];
      assert.ok(validate, `unexpected agent method ${message.method}`);
      assert.ok(validate(message.params), `${message.method}: ${JSON.stringify(validate.errors)}\n${line}`);
      return;
    }
    const method = this.#clientMethods.get(message.id);
    if (method && "result" in message) {
      const validate = RESULTS[method];
      assert.ok(validate, `no schema for the result of ${method}`);
      assert.ok(validate(message.result), `${method} result: ${JSON.stringify(validate.errors)}\n${line}`);
    }
  }

  initialize(clientCapabilities: acp.ClientCapabilities = { elicitation: { form: {} } }) {
    return this.connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities,
      clientInfo: { name: "test-acp", version: "1.0.0" },
    });
  }

  async newSession(mcpServers: acp.McpServer[] = []): Promise<string> {
    return (await this.connection.newSession({ cwd, mcpServers })).sessionId;
  }

  prompt(sessionId: string, prompt: acp.ContentBlock[] | string) {
    return this.connection.prompt({
      sessionId,
      prompt: typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt,
    });
  }

  updatesOf(sessionId: string, kind?: Update["sessionUpdate"]): Update[] {
    return this.updates
      .filter((update) => update.sessionId === sessionId)
      .map((update) => update.update)
      .filter((update) => !kind || update.sessionUpdate === kind);
  }

  text(sessionId: string): string {
    return this.updatesOf(sessionId, "agent_message_chunk")
      .map((update) =>
        update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? update.content.text : "",
      )
      .join("");
  }

  toolUpdates(sessionId: string, toolCallId: string): Update[] {
    return this.updatesOf(sessionId).filter(
      (update) =>
        (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
        update.toolCallId === toolCallId,
    );
  }

  async stop(): Promise<number | null> {
    this.child.stdin.end();
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

async function rejectsWith(promise: Promise<unknown>, code: number): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    assert.equal((error as { code?: number }).code, code, String((error as Error).message));
    return error as Error;
  }
  throw new Error(`expected error ${code}`);
}

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
  tools: [{ name: "echo", description: "Echo the message.", inputSchema: { type: "object", properties: { message: { type: "string" } } } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: "text", text: "echo:" + String(request.params.arguments?.message ?? "") }],
}));
await server.connect(new StdioServerTransport());
`,
  );
  return serverPath;
}

const processes: AcpProcess[] = [];
function start(options?: ConstructorParameters<typeof AcpProcess>[0]): AcpProcess {
  const agent = new AcpProcess(options);
  processes.push(agent);
  return agent;
}

try {
  console.log("\n[1] initialization");
  const agent = start();

  await check("initialize negotiates v1 and advertises the agent's capabilities", async () => {
    const init = await agent.initialize();
    assert.equal(init.protocolVersion, 1);
    assert.equal(init.agentCapabilities?.loadSession, true);
    assert.equal(init.agentCapabilities?.promptCapabilities?.image, true);
    assert.equal(init.agentCapabilities?.promptCapabilities?.embeddedContext, true);
    assert.ok(init.agentCapabilities?.sessionCapabilities?.list);
    assert.equal(init.agentInfo?.name, "eagent");
    assert.deepEqual(init.authMethods, [], "no terminal login without the client capability");
  });

  await check("unknown methods and bad params get JSON-RPC errors", async () => {
    await rejectsWith(agent.connection.extMethod("_easy/unknown", {}), -32601);
    await rejectsWith(agent.connection.newSession({ cwd: "relative/dir", mcpServers: [] }), -32602);
  });

  console.log("\n[2] prompt turns");

  let sessionId = "";
  await check("session/new returns modes and then advertises slash commands", async () => {
    const created = await agent.connection.newSession({ cwd, mcpServers: [] });
    sessionId = created.sessionId;
    assert.equal(created.modes?.currentModeId, "default");
    assert.deepEqual(
      created.modes?.availableModes.map((mode) => mode.id),
      ["default", "plan", "auto"],
    );
    await until("available commands", () => agent.updatesOf(sessionId, "available_commands_update").length === 1);
    const [update] = agent.updatesOf(sessionId, "available_commands_update");
    assert.ok(update?.sessionUpdate === "available_commands_update");
    const names = update.availableCommands.map((command) => command.name);
    assert.ok(names.includes("compact") && names.includes("init"));
    assert.ok(!names.includes("resume") && !names.includes("exit"), "terminal-only commands are left out");
  });

  await check("a text prompt streams agent message chunks and ends the turn", async () => {
    fixture.script([{ kind: "text", text: "Hello from Easy Agent." }]);
    const response = await agent.prompt(sessionId, "Say hello.");
    assert.equal(response.stopReason, "end_turn");
    assert.equal(agent.text(sessionId), "Hello from Easy Agent.");
  });

  await check("a tool call is reported, asks permission with a diff, and completes", async () => {
    fixture.script([
      { kind: "tool", name: "Write", input: { file_path: "acp-allowed.txt", content: "ok\n" } },
      { kind: "text", text: "Wrote it." },
    ]);
    const before = agent.permissionRequests.length;
    assert.equal((await agent.prompt(sessionId, "Write a file.")).stopReason, "end_turn");
    const request = agent.permissionRequests[before]!;
    const toolCallId = request.toolCall.toolCallId;
    assert.equal(request.toolCall.kind, "edit");
    assert.equal(request.toolCall.title, "Write acp-allowed.txt");
    assert.deepEqual(request.toolCall.content, [
      { type: "diff", path: "acp-allowed.txt", oldText: null, newText: "ok\n" },
    ]);
    assert.deepEqual(
      request.options.map((option) => option.kind),
      ["allow_once", "allow_always", "reject_once"],
    );
    const statuses = agent
      .toolUpdates(sessionId, toolCallId)
      .map((update) => ("status" in update ? update.status : undefined));
    assert.equal(statuses[0], "pending", "the tool call is announced before it runs");
    assert.equal(statuses.at(-1), "completed");
    assert.equal(await readFile(path.join(cwd, "acp-allowed.txt"), "utf8"), "ok\n");
  });

  await check("rejecting a permission request fails the tool call", async () => {
    fixture.script([
      { kind: "tool", name: "Write", input: { file_path: "acp-rejected.txt", content: "x" } },
      { kind: "text", text: "Understood." },
    ]);
    agent.onPermission = async () => ({ outcome: { outcome: "selected", optionId: "reject-once" } });
    assert.equal((await agent.prompt(sessionId, "Write it.")).stopReason, "end_turn");
    const toolCallId = agent.permissionRequests.at(-1)!.toolCall.toolCallId;
    const last = agent.toolUpdates(sessionId, toolCallId).at(-1)!;
    assert.ok("status" in last && last.status === "failed");
    await assert.rejects(readFile(path.join(cwd, "acp-rejected.txt")));
  });

  await check("session/cancel during a permission request ends the turn as cancelled", async () => {
    fixture.script([{ kind: "tool", name: "Write", input: { file_path: "acp-cancelled.txt", content: "x" } }]);
    agent.onPermission = async (params) => {
      await agent.connection.cancel({ sessionId: params.sessionId });
      return { outcome: { outcome: "cancelled" } };
    };
    assert.equal((await agent.prompt(sessionId, "Write it.")).stopReason, "cancelled");
    assert.equal(fixture.remaining(), 0, "the model is not called again");
    await assert.rejects(readFile(path.join(cwd, "acp-cancelled.txt")));
    agent.onPermission = async () => ({ outcome: { outcome: "selected", optionId: "allow-once" } });
  });

  await check("session/cancel while the model is responding ends the turn as cancelled", async () => {
    fixture.script([{ kind: "text", text: "Too late.", delayMs: 3_000 }]);
    const requests = fixture.requests.length;
    const pending = agent.prompt(sessionId, "Take your time.");
    await until("model request", () => fixture.requests.length > requests);
    await agent.connection.cancel({ sessionId });
    const started = Date.now();
    assert.equal((await pending).stopReason, "cancelled");
    assert.ok(Date.now() - started < 2_000, "the turn stops without waiting for the reply");
  });

  await check("modes switch from the client and are reported back", async () => {
    await agent.connection.setSessionMode({ sessionId, modeId: "plan" });
    await until("mode update", () =>
      agent.updatesOf(sessionId, "current_mode_update").some((u) => "currentModeId" in u && u.currentModeId === "plan"),
    );
    await rejectsWith(agent.connection.setSessionMode({ sessionId, modeId: "yolo" }), -32602);
  });

  await check("plan approval is a switch_mode permission request", async () => {
    fixture.script([
      { kind: "tool", name: "ExitPlanMode", input: { summary: "Ship it" } },
      { kind: "text", text: "Implementing." },
      { kind: "text", text: "Done." },
    ]);
    agent.onPermission = async () => ({ outcome: { outcome: "selected", optionId: "approve-manual" } });
    const response = await agent.prompt(sessionId, "Plan the change.");
    const request = agent.permissionRequests.at(-1)!;
    assert.equal(request.toolCall.kind, "switch_mode");
    assert.deepEqual(
      request.options.map((option) => option.optionId),
      ["approve-clear-context", "approve-accept-edits", "approve-manual", "keep-planning"],
    );
    assert.equal(response.stopReason, "end_turn", "the implementation turn after approval ends normally");
    assert.ok(
      agent
        .updatesOf(sessionId, "current_mode_update")
        .some((u) => "currentModeId" in u && u.currentModeId === "default"),
    );
    agent.onPermission = async () => ({ outcome: { outcome: "selected", optionId: "allow-once" } });
  });

  await check("AskUserQuestion becomes a form elicitation", async () => {
    fixture.script([
      {
        kind: "tool",
        name: "AskUserQuestion",
        input: { questions: [{ question: "Which size?", header: "Size", options: [{ label: "S" }, { label: "L" }] }] },
      },
      { kind: "text", text: "Large it is." },
    ]);
    agent.onElicitation = async () => ({ action: "accept", content: { q1: "L" } });
    assert.equal((await agent.prompt(sessionId, "Ask me.")).stopReason, "end_turn");
    const elicitation = agent.elicitations.at(-1)! as Json;
    assert.equal(elicitation.mode, "form");
    assert.equal(elicitation.message, "Which size?");
    assert.match(
      JSON.stringify(fixture.requests.at(-1)!.messages),
      /User has answered your questions: .*Which size\?.*L/,
    );
  });

  await check("slash commands run locally and reply as agent messages", async () => {
    const before = fixture.requests.length;
    const textBefore = agent.text(sessionId).length;
    assert.equal((await agent.prompt(sessionId, "/cost")).stopReason, "end_turn");
    assert.equal(fixture.requests.length, before, "no model request");
    assert.match(agent.text(sessionId).slice(textBefore), /token/i);
  });

  await check("images and embedded resources reach the model", async () => {
    fixture.script([{ kind: "text", text: "I see it." }]);
    await agent.prompt(sessionId, [
      { type: "text", text: "Describe these." },
      { type: "image", mimeType: "image/png", data: PNG_1X1 },
      { type: "resource", resource: { uri: `file://${cwd}/notes.txt`, text: "draft\n", mimeType: "text/plain" } },
    ]);
    const sent = JSON.stringify((fixture.requests.at(-1)!.messages as unknown[]).at(-1));
    assert.match(sent, /"type":"image"/);
    assert.match(sent, /<context source=\\".*notes\.txt\\">/);
    await rejectsWith(agent.prompt(sessionId, [{ type: "audio", mimeType: "audio/wav", data: "AAAA" }]), -32602);
  });

  console.log("\n[3] permission rules and trust");

  await check("deny rules hold without a request; an untrusted project's allow rule is ignored", async () => {
    fixture.script([
      { kind: "tool", name: "WebFetch", input: { url: "https://example.com", prompt: "summarize" } },
      { kind: "tool", name: "Edit", input: { file_path: "notes.txt", old_string: "draft", new_string: "edited" } },
      { kind: "text", text: "Done." },
    ]);
    agent.onPermission = async () => ({ outcome: { outcome: "selected", optionId: "reject-once" } });
    const before = agent.permissionRequests.length;
    await agent.prompt(sessionId, "Fetch, then edit.");
    const asked = agent.permissionRequests.slice(before).map((request) => request.toolCall.title);
    assert.deepEqual(asked, ["Edit notes.txt"], "WebFetch is denied without asking");
    assert.equal(await readFile(path.join(cwd, "notes.txt"), "utf8"), "draft\n");
    agent.onPermission = async () => ({ outcome: { outcome: "selected", optionId: "allow-once" } });
  });

  console.log("\n[4] saved sessions");

  await check("session/list returns saved sessions with their first prompt as the title", async () => {
    const { sessions } = await agent.connection.listSessions({ cwd });
    const listed = sessions.find((session) => session.sessionId === sessionId);
    assert.equal(listed?.title, "Say hello.");
    assert.equal(listed?.cwd, cwd);
  });

  await check("session/close ends the session; later prompts are rejected", async () => {
    await agent.connection.closeSession({ sessionId });
    await rejectsWith(agent.prompt(sessionId, "Still there?"), -32002);
    assert.equal(await agent.stop(), 0, "closing stdin exits cleanly");
    const methods = new Set(agent.raw.map((message) => message.method).filter(Boolean));
    assert.ok(
      methods.has("session/update") && methods.has("session/request_permission") && methods.has("elicitation/create"),
    );
    assert.ok(agent.raw.length > 50, "every message the agent wrote was checked against the schema");
  });

  await check("session/load replays the conversation, then continues it", async () => {
    const loader = start({ spawnCwd: root });
    await loader.initialize();
    await loader.connection.loadSession({ sessionId, cwd, mcpServers: [] });
    const replay = loader.updatesOf(sessionId);
    const userText = replay
      .flatMap((u) => (u.sessionUpdate === "user_message_chunk" && u.content.type === "text" ? [u.content.text] : []))
      .join("|");
    assert.match(userText, /^Say hello\.\|Write a file\./, "user prompts in order, without hidden context");
    assert.ok(!/plan_mode|context_update/.test(userText));
    assert.match(loader.text(sessionId), /Hello from Easy Agent\./);
    const replayedWrite = replay.find((u) => u.sessionUpdate === "tool_call" && u.title === "Write acp-allowed.txt");
    assert.ok(replayedWrite, "tool calls are replayed");
    fixture.script([{ kind: "text", text: "Still here." }]);
    assert.equal((await loader.prompt(sessionId, "Continue.")).stopReason, "end_turn");
    const history = JSON.stringify(fixture.requests.at(-1)!.messages);
    assert.match(history, /Say hello\./, "the model sees the restored conversation");
    assert.equal(await loader.stop(), 0);
  });

  await check("session/resume reopens without replay; session/delete removes it", async () => {
    const resumer = start();
    await resumer.initialize();
    await resumer.connection.resumeSession({ sessionId, cwd, mcpServers: [] });
    assert.deepEqual(
      resumer.updatesOf(sessionId).filter((u) => u.sessionUpdate !== "available_commands_update"),
      [],
    );
    await resumer.connection.deleteSession({ sessionId });
    const { sessions } = await resumer.connection.listSessions({});
    assert.ok(!sessions.some((session) => session.sessionId === sessionId));
    await rejectsWith(resumer.connection.loadSession({ sessionId, cwd, mcpServers: [] }), -32002);
    assert.equal(await resumer.stop(), 0);
  });

  console.log("\n[5] editor configuration");

  await check("MCP servers from session/new are connected and their tools usable", async () => {
    const editor = start();
    await editor.initialize();
    const serverPath = await writeEchoServer();
    const id = await editor.newSession([
      { name: "editor-echo", command: process.execPath, args: [serverPath], env: [] },
    ]);
    fixture.script([
      { kind: "tool", name: "mcp__editor-echo__echo", input: { message: "pong" } },
      { kind: "text", text: "Echoed." },
    ]);
    assert.equal((await editor.prompt(id, "Use the echo tool.")).stopReason, "end_turn");
    assert.match(JSON.stringify(fixture.requests.at(-1)!.messages), /echo:pong/);
    assert.equal(await editor.stop(), 0);
  });

  await check("--trust-project-config applies the project's settings for that process only", async () => {
    const trusted = start({ args: ["--trust-project-config"] });
    await trusted.initialize();
    const id = await trusted.newSession();
    fixture.script([
      { kind: "tool", name: "Edit", input: { file_path: "notes.txt", old_string: "draft", new_string: "edited" } },
      { kind: "text", text: "Edited." },
    ]);
    await trusted.prompt(id, "Edit it.");
    assert.equal(trusted.permissionRequests.length, 0, "the project allow rule applies");
    assert.equal(await readFile(path.join(cwd, "notes.txt"), "utf8"), "edited\n");
    assert.equal(await trusted.stop(), 0);
  });

  console.log("\n[6] authentication");

  await check("without credentials, sessions need authentication and a terminal login is offered", async () => {
    const anonymous = start({ env: { ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_BASE_URL: "" } });
    const init = await anonymous.initialize({ auth: { terminal: true } });
    assert.deepEqual(
      init.authMethods?.map((method) => ({ id: method.id, ...("args" in method ? { args: method.args } : {}) })),
      [{ id: "eagent-login", args: ["--login"] }],
    );
    await rejectsWith(anonymous.newSession(), -32000);
    await rejectsWith(anonymous.connection.authenticate({ methodId: "eagent-login" }), -32000);
    assert.equal(await anonymous.stop(), 0);
  });

  await check("the registry's legacy terminal-auth capability also gets the login method", async () => {
    const legacy = start();
    const init = await legacy.connection.initialize({
      protocolVersion: 1,
      clientCapabilities: { terminal: true, _meta: { "terminal-auth": true } },
    });
    assert.equal(init.authMethods?.[0]?.id, "eagent-login");
    assert.equal(await legacy.stop(), 0);
  });

  console.log("\n[7] registry entry");

  await check("the ACP Registry entry matches the package and the registry's rules", async () => {
    const out = path.join(root, "registry");
    const generated = spawnSync(
      process.execPath,
      ["--import", TSX_IMPORT, path.join(PROJECT_ROOT, "scripts", "acp-registry-entry.ts"), "--out", out],
      { encoding: "utf8" },
    );
    assert.equal(generated.status, 0, generated.stderr);
    const dir = path.join(out, "easy-agent");
    const entry = JSON.parse(await readFile(path.join(dir, "agent.json"), "utf8")) as Json;
    const pkg = JSON.parse(await readFile(path.join(PROJECT_ROOT, "package.json"), "utf8")) as Json;
    assert.match(entry.id as string, /^[a-z][a-z0-9-]*$/);
    assert.equal(path.basename(dir), entry.id);
    assert.match(entry.version as string, /^\d+\.\d+\.\d+$/);
    assert.equal(entry.version, pkg.version);
    for (const field of ["name", "description", "license_url"]) assert.ok(entry[field], field);
    const npx = (entry.distribution as { npx: { package: string; args: string[] } }).npx;
    assert.equal(npx.package, `${pkg.name}@${pkg.version}`, "the package is pinned to this version");
    assert.deepEqual(npx.args, ["--acp"]);
    const icon = await readFile(path.join(dir, "icon.svg"), "utf8");
    assert.match(icon, /width="16" height="16"/);
    assert.match(icon, /viewBox="0 0 16 16"/);
    for (const [, value] of icon.matchAll(/(?:fill|stroke)="([^"]*)"/g)) {
      assert.ok(["currentColor", "none", "inherit"].includes(value!), `icon colour ${value}`);
    }
  });
} finally {
  for (const agentProcess of processes) if (agentProcess.child.exitCode === null) agentProcess.child.kill();
  await fixture.close();
  await rm(root, { recursive: true, force: true });
}

console.log(`\nACP: ${passed} passed, 0 failed.`);
process.exit(0);
