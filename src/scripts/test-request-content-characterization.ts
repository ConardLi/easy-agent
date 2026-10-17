/**
 * Request content characterization (golden-master) test.
 *
 * Locks what the default configuration sends to the model: every system
 * prompt block, every tool definition in order, the cache markers, the
 * request parameters and beta headers, and the messages. The other goldens
 * cover turns and events; this one catches a changed byte in the prompt or a
 * tool schema, which would also break prompt caching.
 *
 * One runtime runs per process, so each scenario runs in a child process with
 * its own HOME and workspace and prints its normalized requests as JSON. The
 * parent collects them, moves system prompt text and tool definitions into a
 * shared content section (each distinct text once), and compares the result
 * with the golden.
 *
 * Normalized values: temp paths, the project memory key, today's date, the
 * operating system line, and the PowerShell tool, which exists only on
 * Windows (its presence there is asserted separately).
 *
 * Run:    node --import tsx src/scripts/test-request-content-characterization.ts
 * Update: node --import tsx src/scripts/test-request-content-characterization.ts --update
 *         (regenerate the golden, only after an intentional change)
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const GOLDEN_PATH = path.join(import.meta.dirname, "__golden__", "request-content-characterization.golden.txt");
const SCENARIO_START = "<<<REQUESTS>>>";
const SCENARIO_END = "<<<END>>>";
const PLATFORM_ONLY_TOOLS = process.platform === "win32" ? ["PowerShell"] : [];

interface CapturedRequest {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface ScenarioOutput {
  requests: CapturedRequest[];
  /** Tools removed from the recording because only this platform has them. */
  platformTools: string[];
}

// ─── Scenarios ───────────────────────────────────────────────────────────

const SCENARIOS = [
  "default",
  "project-memory",
  "plan-mode",
  "skills-and-agents",
  "mcp-tool-search",
  "mcp-inline",
  "after-compaction",
  "openai-chat",
  "gemini",
] as const;
type ScenarioName = (typeof SCENARIOS)[number];

const DESCRIPTIONS: Record<ScenarioName, string> = {
  default: "Empty workspace: a Read round trip, then a second user message.",
  "project-memory": "AGENTS.md and AGENT.md in the project, and a project memory entry.",
  "plan-mode": "A session started in plan mode.",
  "skills-and-agents": "A project skill and a project sub-agent in a trusted workspace.",
  "mcp-tool-search": "One stdio MCP server with toolSearch set to on: deferred tools behind ToolSearch.",
  "mcp-inline":
    "The same MCP server with the default ToolSearch setting; on an endpoint other than api.anthropic.com every tool stays inline.",
  "after-compaction": "One turn, /compact, then the next turn.",
  "openai-chat": "An openai-chat model profile as the default model.",
  gemini: "A gemini model profile as the default model.",
};

// ─── Child: run one scenario ─────────────────────────────────────────────

const PROVIDER_ENV = /^(?:ANTHROPIC_|EASY_AGENT_|CLAUDE_CODE_|OPENAI_|GEMINI_|GOOGLE_|MCP_|WEB_SEARCH_)/;
const PROVIDER_ENV_NAMES = new Set(["MAX_THINKING_TOKENS", "DISABLE_INTERLEAVED_THINKING", "ENABLE_TOOL_SEARCH"]);

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")));
  });
}

/** A provider endpoint that records each request and answers with one canned stream. */
async function startRecordingServer(
  reply: string,
  sink: CapturedRequest[],
): Promise<{ server: Server; baseURL: string }> {
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    sink.push({ path: request.url ?? "", headers: pickHeaders(request.headers), body });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(reply);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const OPENAI_TEXT_STREAM = [
  `data: {"id":"cmpl-test","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello."}}]}\n\n`,
  `data: {"id":"cmpl-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n`,
  "data: [DONE]\n\n",
].join("");

const GEMINI_TEXT_STREAM = `data: {"responseId":"resp-test","candidates":[{"content":{"parts":[{"text":"Hello."}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}\n\n`;

/** Headers that change what the provider does. Client identity and lengths are left out. */
function pickHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of ["anthropic-beta", "anthropic-version"]) {
    const value = headers[name];
    if (value !== undefined) picked[name] = Array.isArray(value) ? value.join(",") : value;
  }
  return picked;
}

async function writeEchoServer(file: string): Promise<void> {
  const serverModule = (specifier: string) => import.meta.resolve(`@modelcontextprotocol/sdk/${specifier}`);
  await writeFile(
    file,
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
}

async function runScenario(name: ScenarioName): Promise<ScenarioOutput> {
  for (const key of Object.keys(process.env)) {
    if (PROVIDER_ENV.test(key) || PROVIDER_ENV_NAMES.has(key)) delete process.env[key];
  }
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "easy-agent-request-char-")));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  const userDir = path.join(home, ".easy-agent");
  const projectDir = path.join(cwd, ".easy-agent");
  await Promise.all([mkdir(userDir, { recursive: true }), mkdir(projectDir, { recursive: true })]);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.EASY_AGENT_DISABLE_HOOKS = "1";
  process.chdir(cwd);

  const userSettings: Record<string, unknown> = {};
  const captured: CapturedRequest[] = [];
  const servers: Server[] = [];
  let trust: "session" | undefined;

  switch (name) {
    case "project-memory": {
      await writeFile(path.join(cwd, "AGENTS.md"), "# Project rules\n\nRun `npm test` before every commit.\n");
      await writeFile(path.join(cwd, "AGENT.md"), "# Agent notes\n\nPrefer small pull requests.\n");
      break;
    }
    case "skills-and-agents": {
      trust = "session";
      await mkdir(path.join(projectDir, "skills", "review"), { recursive: true });
      await writeFile(
        path.join(projectDir, "skills", "review", "SKILL.md"),
        "---\nname: review\ndescription: Review the staged changes for bugs.\n---\n\nRead the diff and list concrete problems.\n",
      );
      await mkdir(path.join(projectDir, "agents"), { recursive: true });
      await writeFile(
        path.join(projectDir, "agents", "tester.md"),
        "---\nname: tester\ndescription: Writes and runs tests for a change.\ntools: Read, Bash\n---\n\nWrite focused tests and run them.\n",
      );
      break;
    }
    case "mcp-tool-search":
    case "mcp-inline": {
      const serverFile = path.join(root, "echo-server.mjs");
      await writeEchoServer(serverFile);
      userSettings.mcpServers = { echo: { command: process.execPath, args: [serverFile] } };
      if (name === "mcp-tool-search") userSettings.toolSearch = "on";
      break;
    }
    case "openai-chat":
    case "gemini": {
      const recording = await startRecordingServer(
        name === "gemini" ? GEMINI_TEXT_STREAM : OPENAI_TEXT_STREAM,
        captured,
      );
      servers.push(recording.server);
      userSettings.models = {
        remote: {
          protocol: name,
          model: name === "gemini" ? "gemini-test" : "gpt-test",
          baseURL: name === "gemini" ? `${recording.baseURL}/v1beta` : `${recording.baseURL}/v1`,
          apiKey: "test-key",
        },
      };
      userSettings.defaultModel = "remote";
      break;
    }
    default:
      break;
  }
  if (Object.keys(userSettings).length) {
    await writeFile(path.join(userDir, "settings.json"), JSON.stringify(userSettings, null, 2));
  }

  const { createAnthropicFixture } = await import("./fixtures/anthropicFixture.js");
  const fixture = createAnthropicFixture();
  await fixture.start();

  if (name === "project-memory") {
    const { getProjectMemoryDir } = await import("../context/memory/memdir.js");
    const memoryDir = await getProjectMemoryDir(cwd);
    await mkdir(memoryDir, { recursive: true });
    await writeFile(
      path.join(memoryDir, "MEMORY.md"),
      "# Project Memory\n\n- [Test command](test-command.md): the suite runs with `npm test`\n",
    );
    await writeFile(
      path.join(memoryDir, "test-command.md"),
      "---\nname: Test command\ndescription: the suite runs with npm test\ntype: project\n---\n\nRun `npm test`.\n",
    );
  }

  const { createAgentRuntime } = await import("../sdk/index.js");
  const runtime = await createAgentRuntime({
    cwd,
    ...(trust ? { trust } : {}),
    services: name.startsWith("mcp-") ? {} : false,
    logger: { warn: () => {}, error: () => {} },
  });
  const session = await runtime.createSession({
    ...(name === "plan-mode" ? { permissionMode: "plan" as const } : {}),
  });

  switch (name) {
    case "default": {
      await writeFile(path.join(cwd, "notes.txt"), "remember the milk\n");
      fixture.script([
        { kind: "tool", name: "Read", input: { file_path: path.join(cwd, "notes.txt") } },
        { kind: "text", text: "It says to remember the milk." },
        { kind: "text", text: "You're welcome." },
      ]);
      await session.send("What does notes.txt say?");
      await session.send("Thanks.");
      break;
    }
    case "after-compaction": {
      fixture.script([
        { kind: "text", text: "Hello." },
        { kind: "text", text: "<summary>The user said hello and the assistant greeted them.</summary>" },
        { kind: "text", text: "Still here." },
      ]);
      await session.send("Hello.");
      await session.runCommand("compact");
      await session.send("Are you still there?");
      break;
    }
    default: {
      fixture.script([{ kind: "text", text: "Hello." }]);
      await session.send("Hello.");
      break;
    }
  }

  await runtime.dispose();
  await fixture.close();
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));

  const requests: CapturedRequest[] = [
    ...fixture.requests.map((request) => ({
      path: request.path,
      headers: pickHeaders(request.headers),
      body: request.body,
    })),
    ...captured,
  ];

  const { getProjectPathInfo } = await import("../context/memory/memdir.js");
  const { getLocalDateString } = await import("../context/systemPrompt.js");
  const { projectKey } = await getProjectPathInfo(cwd);
  const replacements: Array<[string, string]> = [
    [projectKey, "<PROJECT_KEY>"],
    [cwd, "<CWD>"],
    [home, "<HOME>"],
    [root, "<TMP>"],
    [getLocalDateString(), "<DATE>"],
    [process.execPath, "<NODE>"],
  ];
  const normalizeString = (value: string): string => {
    let out = value;
    for (const [from, to] of replacements) out = out.split(from).join(to);
    return out
      .replace(/<(?:CWD|HOME|TMP)>[^\s)"'`]*/g, (match) => match.replace(/\\/g, "/"))
      .replace(/(- Operating system: ).*/g, "$1<OS>")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<UUID>")
      .replace(/plans\/[0-9a-f]{8}\.md/g, "plans/<SLUG>.md");
  };
  const normalizeValue = (value: unknown): unknown => {
    if (typeof value === "string") return normalizeString(value);
    if (Array.isArray(value)) return value.map(normalizeValue);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeValue(item)]));
    }
    return value;
  };

  const platformTools: string[] = [];
  /** Anthropic `{name}`, OpenAI `{function: {name}}`, and Gemini `{functionDeclarations: [{name}]}`. */
  const keepTool = (tool: Record<string, unknown>): boolean => {
    const toolName = (tool.name ?? (tool.function as { name?: string } | undefined)?.name) as string | undefined;
    if (!toolName || !PLATFORM_ONLY_TOOLS.includes(toolName)) return true;
    if (!platformTools.includes(toolName)) platformTools.push(toolName);
    return false;
  };
  const dropPlatformTools = (body: Record<string, unknown>) => {
    if (!Array.isArray(body.tools)) return;
    body.tools = (body.tools as Array<Record<string, unknown>>).filter(keepTool).map((tool) =>
      Array.isArray(tool.functionDeclarations)
        ? {
            ...tool,
            functionDeclarations: (tool.functionDeclarations as Array<Record<string, unknown>>).filter(keepTool),
          }
        : tool,
    );
  };

  const normalized = requests.map((request) => {
    const body = normalizeValue(request.body) as Record<string, unknown>;
    dropPlatformTools(body);
    return {
      path: normalizeString(request.path).replace(/127\.0\.0\.1:\d+/, "<HOST>"),
      headers: request.headers,
      body,
    };
  });
  await rm(root, { recursive: true, force: true }).catch(() => {});
  return { requests: normalized, platformTools };
}

// ─── Parent: collect and render ──────────────────────────────────────────

function runChild(name: ScenarioName): Promise<ScenarioOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, SELF, "--scenario", name], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      const start = stdout.indexOf(SCENARIO_START);
      const end = stdout.indexOf(SCENARIO_END);
      if (code !== 0 || start < 0 || end < 0) {
        reject(new Error(`scenario ${name} failed (exit ${code})\n${stdout}\n${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout.slice(start + SCENARIO_START.length, end)) as ScenarioOutput);
    });
  });
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

const stableJson = (value: unknown) => JSON.stringify(sortKeys(value), null, 2);

/** Each distinct long text or tool definition is printed once and referenced by id elsewhere. */
class ContentTable {
  readonly entries: Array<{ id: string; text: string }> = [];
  readonly #ids = new Map<string, string>();
  #counters = { S: 0, T: 0 };

  ref(kind: "S" | "T", text: string): string {
    const key = `${kind}:${text}`;
    let id = this.#ids.get(key);
    if (!id) {
      this.#counters[kind] += 1;
      id = `${kind}${this.#counters[kind]}`;
      this.#ids.set(key, id);
      this.entries.push({ id, text });
    }
    return id;
  }
}

const LONG_TEXT = 200;

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** Replace system text and tool definitions with references; long strings elsewhere too. */
function extractContent(body: Record<string, unknown>, table: ContentTable): Record<string, unknown> {
  const textRef = (text: string) => `<<${table.ref("S", text)} ${text.length} chars ${digest(text)}>>`;
  const toolRef = (tool: unknown) => {
    const name =
      (tool as { name?: string }).name ?? (tool as { function?: { name?: string } }).function?.name ?? "(unnamed)";
    const { cache_control: cacheControl, ...definition } = tool as Record<string, unknown>;
    const ref = `<<${table.ref("T", stableJson(definition))} ${name}>>`;
    return cacheControl ? { ref, cache_control: cacheControl } : ref;
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return value.length > LONG_TEXT ? textRef(value) : value;
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    }
    return value;
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "tools" && Array.isArray(value)) {
      out.tools = value.map((tool) =>
        Array.isArray((tool as { functionDeclarations?: unknown[] }).functionDeclarations)
          ? { functionDeclarations: (tool as { functionDeclarations: unknown[] }).functionDeclarations.map(toolRef) }
          : toolRef(tool),
      );
    } else out[key] = walk(value);
  }
  return out;
}

async function buildRecording(): Promise<{ recording: string; platformTools: Set<string> }> {
  const table = new ContentTable();
  const platformTools = new Set<string>();
  const blocks: string[] = [];
  for (const name of SCENARIOS) {
    const output = await runChild(name);
    for (const tool of output.platformTools) platformTools.add(tool);
    const lines = [`### ${name}`, DESCRIPTIONS[name], `requests: ${output.requests.length}`];
    output.requests.forEach((request, index) => {
      lines.push(
        "",
        `--- request ${index + 1}: POST ${request.path}`,
        `headers: ${stableJson(request.headers)}`,
        `body: ${stableJson(extractContent(request.body, table))}`,
      );
    });
    blocks.push(lines.join("\n"));
  }
  const content = table.entries.map((entry) => `=== ${entry.id} (${digest(entry.text)})\n${entry.text}`);
  return {
    recording: `${blocks.join("\n\n")}\n\n## Content\n\n${content.join("\n\n")}\n`,
    platformTools,
  };
}

async function main(): Promise<void> {
  const scenarioIndex = process.argv.indexOf("--scenario");
  if (scenarioIndex !== -1) {
    const name = process.argv[scenarioIndex + 1] as ScenarioName;
    if (!SCENARIOS.includes(name)) throw new Error(`unknown scenario ${name}`);
    const output = await runScenario(name);
    // Exit from the write callback: a pipe write is asynchronous, and process.exit would cut it off.
    // The explicit exit stops background handles (MCP clients, timers) from keeping the child alive.
    process.stdout.write(`${SCENARIO_START}${JSON.stringify(output)}${SCENARIO_END}\n`, () => process.exit(0));
    return;
  }

  const update = process.argv.includes("--update");
  const { recording, platformTools } = await buildRecording();
  for (const tool of PLATFORM_ONLY_TOOLS) {
    assert.ok(platformTools.has(tool), `${tool} should be offered on ${process.platform}`);
  }

  await mkdir(path.dirname(GOLDEN_PATH), { recursive: true });
  if (update) {
    await writeFile(GOLDEN_PATH, recording, "utf8");
    console.log(`[updated] ${path.relative(process.cwd(), GOLDEN_PATH)}`);
    return;
  }

  const golden = (await readFile(GOLDEN_PATH, "utf8").catch(() => "")).replace(/\r\n?/g, "\n");
  if (!golden) throw new Error(`no golden at ${GOLDEN_PATH}; run with --update from known-good code`);
  if (recording === golden) {
    console.log(
      `[pass] request content matches golden (${SCENARIOS.length} scenarios, ${recording.split("\n").length} lines)`,
    );
    return;
  }
  const actual = recording.split("\n");
  const expected = golden.split("\n");
  const first = actual.findIndex((line, index) => line !== expected[index]);
  const at = first === -1 ? Math.min(actual.length, expected.length) : first;
  console.error(`[fail] request content diverged from golden at line ${at + 1}:`);
  for (let i = Math.max(0, at - 3); i <= at; i++) {
    console.error(`  golden ${i + 1}: ${JSON.stringify(expected[i])}`);
    console.error(`  actual ${i + 1}: ${JSON.stringify(actual[i])}`);
  }
  console.error("If the change is intentional, re-run with --update and explain it in the PR.");
  assert.equal(recording, golden, "request content characterization mismatch");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
