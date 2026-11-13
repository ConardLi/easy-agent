/**
 * Attribution coverage of request records and the context breakdown, against
 * the fixture model.
 *
 * Sessions exercise every model-visible input of the main loop: typed
 * prompts, a UserPromptSubmit hook's context, a SessionStart hook, plan mode,
 * a background notification, a teammate's mail, a context update, a skill, a
 * custom command, ultrathink, tool results, compaction, and the deferred tool
 * list ToolSearch adds. For every request the fixture receives:
 *
 * - The record's body size is the size the fixture received, and the
 *   envelope plus the system, tools, and messages parts add up to it.
 * - The system prompt segments cover its text byte for byte, each segment's
 *   hash is of its slice, and none is unattributed.
 * - Every tool schema is one segment with its hash.
 * - Every message is split by an oracle that reads the raw request: typed
 *   prompts are user input, other text must start with a prefix the oracle
 *   knows. The record's sources and part hashes must match it. A new kind of
 *   model-visible input that has no source fails here: the oracle cannot
 *   place it, or the record calls it user input.
 * - Across the sessions every message source is seen, except those only
 *   other purposes carry (covered by test:request-trace).
 *
 * The breakdown: before the first request, after /clear, and after a rewind
 * it is the estimate; after a request its components account for every byte
 * of the request; while a turn runs it is the turn's finished request plus
 * the messages since;
 * a resumed session splits the restored hook context the same way.
 *
 * Run: node --import tsx src/scripts/test-context-coverage.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "easy-agent-context-coverage-")));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
await Promise.all([mkdir(path.join(home, ".easy-agent"), { recursive: true }), mkdir(cwd, { recursive: true })]);
for (const key of Object.keys(process.env)) {
  if (/^(?:ANTHROPIC_|EASY_AGENT_|CLAUDE_CODE_|OPENAI_)/.test(key) || /TOOL_SEARCH|THINKING/.test(key)) {
    delete process.env[key];
  }
}
process.env.HOME = home;
process.env.USERPROFILE = home;
process.chdir(cwd);

const HOOK_CONTEXT = "Hook context: the release branch is frozen.";
const SESSION_START_CONTEXT = "Session start context: CI runs nightly.";
await writeFile(path.join(cwd, "AGENT.md"), "Project rule: keep answers short.\n");
await writeFile(path.join(cwd, "notes.txt"), "file body\n");
await mkdir(path.join(cwd, ".easy-agent", "skills", "review"), { recursive: true });
await writeFile(
  path.join(cwd, ".easy-agent", "skills", "review", "SKILL.md"),
  "---\nname: review\ndescription: Review the change before committing.\n---\nRead the diff and list problems.\n",
);
await mkdir(path.join(cwd, ".easy-agent", "commands"), { recursive: true });
await writeFile(
  path.join(cwd, ".easy-agent", "commands", "hello.md"),
  "---\ndescription: Say hello\n---\nSay hello.\n",
);
const nodeEcho = (text: string) => `node -e "console.log('${text}')"`;
await writeFile(
  path.join(home, ".easy-agent", "settings.json"),
  `${JSON.stringify(
    {
      toolSearch: "on",
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: nodeEcho(SESSION_START_CONTEXT) }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: nodeEcho(HOOK_CONTEXT) }] }],
      },
    },
    null,
    2,
  )}\n`,
);

const { createAnthropicFixture, FIXTURE_MODEL } = await import("./fixtures/anthropicFixture.js");
type RecordedRequest = import("./fixtures/anthropicFixture.js").RecordedRequest;
const fixture = createAnthropicFixture();
await fixture.start();
process.env.ANTHROPIC_MODEL = FIXTURE_MODEL;

const sdk = await import("../sdk/index.js");
const { runInScopeOf } = await import("../sdk/session.js");
const storage = await import("../session/storage.js");
const { flushRequestTraces } = await import("../trace/traceStore.js");
const { MESSAGE_ITEMS } = await import("../core/queryEngine/contextBreakdown.js");
const { CONTEXT_UPDATE_MARKER } = await import("../constants/systemPromptMarkers.js");
const { getProjectMemoryDir, MEMORY_ENTRYPOINT } = await import("../context/memory/memdir.js");
const { enqueuePendingNotification } = await import("../state/notificationStore.js");
const { setActiveTeam, clearActiveTeam } = await import("../state/teamContext.js");
const { writeToMailbox } = await import("../utils/teammateMailbox.js");
const { TEAM_LEAD_NAME } = await import("../utils/teamHelpers.js");
type AgentSession = import("../sdk/index.js").AgentSession;
type SessionContext = import("../sdk/index.js").SessionContext;
type RequestRecord = import("../trace/requestTrace.js").RequestRecord;
type MessageTraceSegment = import("../trace/requestTrace.js").MessageTraceSegment;
type MessageSource = import("../core/messageSources.js").MessageSource;

const memoryDir = await getProjectMemoryDir(cwd);
await mkdir(memoryDir, { recursive: true });
await writeFile(path.join(memoryDir, MEMORY_ENTRYPOINT), "- [Style](style.md): prefer small commits\n");

const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ─── The oracle ─────────────────────────────────────────────────────────

/** Prompts the test typed; only these are user input. */
const typed = new Set<string>();

/** Starts of the hidden inputs the orchestration layer adds, and their sources. */
const HIDDEN: ReadonlyArray<[string, MessageSource]> = [
  ["<available-deferred-tools>", "deferred_tools"],
  ["[session-start]", "hook_output"],
  ["[stop-hook]", "hook_output"],
  ["[plan_mode_attachment]", "plan_attachment"],
  ["[plan_mode_exit]", "plan_attachment"],
  ["[task-notification]", "background_notification"],
  ["<teammate-messages>", "team_message"],
  [CONTEXT_UPDATE_MARKER, "context_update"],
  ["[ultrathink]", "meta"],
  ["<command-message>", "command"],
  ["<command-name>", "command"],
  ["[command_invocation:", "command"],
  ["[skill_invocation:", "skill_body"],
  ["This session is being continued from a previous conversation", "compaction_summary"],
];
const USER_CONTEXT = `[user-context]\n${HOOK_CONTEXT}\n\n`;

interface ExpectedPart {
  source: MessageSource;
  content: string;
}

function classify(text: string): MessageSource {
  if (typed.has(text)) return "user_input";
  const hidden = HIDDEN.find(([prefix]) => text.startsWith(prefix));
  assert.ok(hidden, `model-visible input without a registered source: ${JSON.stringify(text.slice(0, 80))}`);
  return hidden[1];
}

/** How the raw message splits by source, read from the request alone. */
function expectedParts(message: { role: string; content: unknown }): ExpectedPart[] {
  if (message.role === "assistant") {
    const blocks = message.content as Array<{ type: string; text?: string }>;
    const first =
      typeof message.content === "string" ? message.content : (blocks.find((b) => b.type === "text")?.text ?? "");
    return [{ source: first.startsWith("[CompactBoundary]") ? "compaction_summary" : "assistant", content: "" }];
  }
  const blocks =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : (message.content as Array<{ type: string; text?: string }>);
  const parts: ExpectedPart[] = [];
  for (const block of blocks) {
    if (block.type === "tool_result") parts.push({ source: "tool_result", content: JSON.stringify(block) });
    else if (block.type !== "text") assert.fail(`unexpected ${block.type} block in a user message`);
    else if (block.text!.startsWith(USER_CONTEXT)) {
      const rest = block.text!.slice(USER_CONTEXT.length);
      parts.push({ source: "hook_output", content: USER_CONTEXT }, { source: classify(rest), content: rest });
    } else parts.push({ source: classify(block.text!), content: block.text! });
  }
  return parts;
}

// ─── Reading records ────────────────────────────────────────────────────

interface PromptSegment {
  component: string;
  bytes: number;
  hash: string;
}
type FullRecord = RequestRecord & {
  allSegments: MessageTraceSegment[];
  systemSegments: PromptSegment[];
  toolSegments: PromptSegment[];
};

async function recordsOf(sessionId: string): Promise<FullRecord[]> {
  await flushRequestTraces();
  const lines = (await readFile(await storage.getTracePath(cwd, sessionId), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown> & { type: string });
  const segments = new Map(
    lines.filter((line) => line.type === "segments").map((line) => [`${line.part}:${line.hash}`, line.segments]),
  );
  const byId = new Map<string, MessageTraceSegment[]>();
  return lines
    .filter((line) => line.type === "request")
    .map((line) => {
      const record = line as unknown as RequestRecord & { messages: { reused?: { requestId: string; count: number } } };
      const reused = record.messages.reused;
      const allSegments = [
        ...(reused ? byId.get(reused.requestId)!.slice(0, reused.count) : []),
        ...record.messages.segments,
      ];
      byId.set(record.requestId, allSegments);
      return {
        ...record,
        allSegments,
        systemSegments: (segments.get(`system:${record.system.hash}`) ?? []) as PromptSegment[],
        toolSegments: (segments.get(`tools:${record.tools.hash}`) ?? []) as PromptSegment[],
      };
    });
}

const seenSources = new Set<MessageSource>();
const seenComponents = new Set<string>();

/** The record accounts for every byte of the request, and its sources match the oracle's. */
function assertCovers(record: FullRecord, request: RecordedRequest): void {
  const body = request.body as {
    system?: unknown;
    tools?: unknown[];
    messages: Array<{ role: string; content: unknown }>;
  };
  assert.equal(record.bodyBytes, request.bodyBytes, "body bytes are the bytes received");
  assert.equal(record.system.bytes, body.system === undefined ? 0 : bytesOf(body.system));
  assert.equal(record.tools.bytes, body.tools === undefined ? 0 : bytesOf(body.tools));
  assert.equal(record.messages.bytes, bytesOf(body.messages));
  const keys = (["system", "tools", "messages"] as const).filter((key) => body[key] !== undefined);
  const keyBytes = keys.reduce((sum, key) => sum + Buffer.byteLength(`,"${key}":`), 0);
  assert.equal(
    record.envelopeBytes,
    request.bodyBytes - record.system.bytes - record.tools.bytes - record.messages.bytes,
    "the envelope is the rest of the body",
  );
  assert.ok(record.envelopeBytes! >= keyBytes, "the envelope holds at least the part keys");

  if (record.purpose === "main") {
    const text =
      typeof body.system === "string"
        ? body.system
        : (body.system as Array<{ text: string }>).map((block) => block.text).join("\n\n");
    const buffer = Buffer.from(text);
    let offset = 0;
    for (const segment of record.systemSegments) {
      assert.notEqual(segment.component, "prompt:unattributed");
      assert.equal(
        segment.hash,
        digest(buffer.subarray(offset, offset + segment.bytes).toString()),
        `${segment.component} is its slice of the prompt`,
      );
      offset += segment.bytes;
      seenComponents.add(segment.component);
    }
    assert.equal(offset, buffer.length, "the system prompt segments cover the whole text");
  }

  const tools = (body.tools ?? []) as Array<{ name: string }>;
  assert.deepEqual(
    record.toolSegments.map((segment) => [segment.component, segment.hash, segment.bytes]),
    tools.map((tool) => [`tool:${tool.name}`, digest(JSON.stringify(tool)), bytesOf(tool)]),
    "one segment per tool schema",
  );

  assert.equal(record.allSegments.length, body.messages.length);
  body.messages.forEach((message, index) => {
    const segment = record.allSegments[index]!;
    assert.equal(segment.hash, digest(JSON.stringify(message)), `message ${index} hash`);
    assert.equal(segment.bytes, bytesOf(message), `message ${index} bytes`);
    if (record.purpose !== "main") return;
    const expected = expectedParts(message);
    const sources = [...new Set(expected.map((part) => part.source))];
    if (sources.length === 1) {
      assert.equal(segment.parts, undefined, `message ${index} has one source`);
      assert.equal(segment.source, sources[0], `message ${index} source`);
    } else {
      assert.ok(segment.parts, `message ${index} is split by source (${sources.join(", ")})`);
      assert.deepEqual(
        segment.parts.map((part) => [part.source, part.hash]),
        expected.map((part) => [part.source, digest(part.content)]),
        `message ${index} parts`,
      );
      assert.equal(
        segment.parts.reduce((sum, part) => sum + part.bytes, 0),
        segment.bytes,
        `message ${index} parts add up`,
      );
    }
    for (const source of sources) seenSources.add(source);
  });
}

async function assertSession(sessionId: string, requests: RecordedRequest[]): Promise<FullRecord[]> {
  const records = await recordsOf(sessionId);
  assert.equal(records.length, requests.length, "one record per request received");
  for (const [index, record] of records.entries()) assertCovers(record, requests[index]!);
  return records;
}

/** The breakdown accounts for every byte of the latest main request. */
function assertBreakdown(context: SessionContext, record: FullRecord): void {
  assert.equal(context.basis, "request");
  assert.equal(context.request?.requestId, record.requestId);
  const bytes = context.components.reduce((sum, component) => sum + component.bytes, 0);
  assert.equal(bytes - context.request!.unsent.bytes, record.bodyBytes, "components cover the request body");
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  assert.equal(sum(context.categories.map((category) => category.tokens)), context.used);
  assert.equal(sum(Object.values(context.totals)), context.used);
  for (const category of context.categories) {
    assert.equal(sum(category.items.map((item) => item.tokens)), category.tokens, `${category.id} items add up`);
    assert.equal(
      sum(context.components.filter((c) => c.category === category.id).map((c) => c.tokens)),
      category.tokens,
      `${category.id} components add up`,
    );
  }
  assert.ok(
    context.components.every((c) => c.category !== null || c.tokens === 0),
    "framing carries no tokens",
  );
}

// ─── Sessions ───────────────────────────────────────────────────────────

async function withRuntime<T>(fn: (runtime: import("../sdk/index.js").AgentRuntime) => Promise<T>): Promise<T> {
  const runtime = await sdk.createAgentRuntime({
    cwd,
    trust: "session",
    services: false,
    logger: { warn() {}, error() {} },
  });
  try {
    return await fn(runtime);
  } finally {
    await runtime.dispose();
  }
}

async function say(session: AgentSession, prompt: string): Promise<void> {
  typed.add(prompt);
  await session.send(prompt);
}

/** Wait for the turn a notification or a teammate's mail starts on its own. */
async function settle(session: AgentSession, start: number): Promise<void> {
  const sleep = () => new Promise((resolve) => setTimeout(resolve, 10));
  while (fixture.requests.length === start) await sleep();
  while (session.getState().busy) await sleep();
}

async function commandOutput(session: AgentSession, args: string[]): Promise<string> {
  const out: string[] = [];
  const off = session.subscribe((event) => {
    if (event.type === "command_output") out.push(event.message);
  });
  await session.runCommand("context", args);
  off();
  return out.join("\n");
}

const latestMain = (records: FullRecord[]) => records.filter((record) => record.purpose === "main").at(-1)!;

try {
  console.log("\n[1] the estimate before a request");

  let firstSessionId = "";
  await withRuntime(async (runtime) => {
    const session = await runtime.createSession({ permissionMode: "auto" });
    firstSessionId = session.id;
    const sessionStart = fixture.requests.length;
    const all = () => assertSession(session.id, fixture.requests.slice(sessionStart));

    await check("before the first request the breakdown is the estimate", async () => {
      const context = await session.getContext();
      assert.equal(context.basis, "estimate");
      assert.deepEqual(context.components, []);
      assert.equal(context.request, undefined);
      assert.match(await commandOutput(session, []), /Estimated used: /);
      assert.match(await commandOutput(session, ["details"]), /Estimated: no request has been sent yet/);
    });

    console.log("\n[2] every input of the main loop");

    await check("typed prompts, both hooks, the deferred tool list, and tool results", async () => {
      fixture.script([
        { kind: "tool", name: "Read", input: { file_path: path.join(cwd, "notes.txt") } },
        { kind: "text", text: "Read it." },
      ]);
      await say(session, "Read notes.txt");
      const records = await all();
      const first = records[0]!.allSegments;
      assert.ok(first.some((segment) => segment.parts?.some((part) => part.source === "deferred_tools")));
      assert.ok(first.some((segment) => segment.parts?.some((part) => part.source === "hook_output")));
      assertBreakdown(await session.getContext(), latestMain(records));
    });

    await check("a background notification, a context update, and ultrathink", async () => {
      fixture.script([{ kind: "text", text: "Noted." }]);
      const start = fixture.requests.length;
      runInScopeOf(session, () =>
        enqueuePendingNotification({ mode: "task-notification", text: "<task-notification>done</task-notification>" }),
      );
      await settle(session, start);
      await writeFile(path.join(cwd, "AGENT.md"), "Project rule: keep answers very short.\n");
      fixture.script([{ kind: "text", text: "Thought about it." }]);
      await say(session, "ultrathink about the notification");
      const records = await all();
      assertBreakdown(await session.getContext(), latestMain(records));
    });

    await check("a teammate's mail", async () => {
      const start = fixture.requests.length;
      const teamName = "coverage-team";
      runInScopeOf(session, () =>
        setActiveTeam({
          teamName,
          leadAgentId: `${TEAM_LEAD_NAME}@${teamName}`,
          teamFilePath: path.join(home, "team.json"),
          createdAt: Date.now(),
        }),
      );
      try {
        await writeToMailbox(
          TEAM_LEAD_NAME,
          { from: "researcher", text: "Found the cause.", timestamp: new Date().toISOString() },
          teamName,
        );
        fixture.script([{ kind: "text", text: "Thanks." }]);
        await settle(session, start);
      } finally {
        runInScopeOf(session, () => clearActiveTeam());
      }
      await all();
      assert.equal(fixture.requests.length - start, 1);
    });

    await check("a skill and a custom command", async () => {
      fixture.script([{ kind: "text", text: "Reviewed." }]);
      await session.send("/review the last change");
      fixture.script([{ kind: "text", text: "Hello." }]);
      await session.send("/hello");
      await all();
    });

    await check("/context details lists every component with its bytes", async () => {
      const context = await session.getContext();
      const output = await commandOutput(session, ["details"]);
      for (const component of context.components) {
        const shown = component.id.startsWith("rule:")
          ? `rule:${path.relative(cwd, component.id.slice(5))}`
          : component.id;
        assert.ok(output.includes(shown), shown);
      }
      assert.match(output, new RegExp(`account for ${context.request!.bytes.toLocaleString("en-US")} of them`));
      assert.match(await commandOutput(session, []), /Used: .*, read from the last request/);
    });

    await check("while a turn runs: the turn's finished request and the messages since", async () => {
      const start = fixture.requests.length;
      fixture.script([
        { kind: "tool", name: "Read", input: { file_path: path.join(cwd, "notes.txt") } },
        { kind: "text", text: "Slow answer.", delayMs: 400 },
      ]);
      typed.add("Read it slowly");
      const turn = session.send("Read it slowly");
      while (fixture.requests.length < start + 2) await new Promise((resolve) => setTimeout(resolve, 10));
      const during = await session.getContext();
      await turn;
      const records = await all();
      assert.equal(during.basis, "request");
      assert.equal(during.request?.requestId, records.at(-2)!.requestId, "the first request of the turn");
      assert.equal(
        during.request?.unsent.messages,
        2,
        "the tool call and its result, which the request in flight carries",
      );
    });

    await check(
      "compaction: the summary is attributed, and the estimate stands in until the next request",
      async () => {
        fixture.script([{ kind: "text", text: "Summary of the work." }]);
        await session.runCommand("compact");
        assert.equal((await session.getContext()).basis, "estimate", "the conversation was rebuilt");
        fixture.script([{ kind: "text", text: "Continuing." }]);
        await say(session, "Continue");
        const records = await all();
        assert.ok(records.some((record) => record.purpose === "compaction"));
        assertBreakdown(await session.getContext(), records.at(-1)!);
      },
    );

    await check("after a rewind or /clear the breakdown is the estimate again", async () => {
      const checkpoint = session.listCheckpoints().at(-1)!;
      await session.rewind({ to: checkpoint.id, scope: "conversation" });
      assert.equal((await session.getContext()).basis, "estimate");
      fixture.script([{ kind: "text", text: "Again." }]);
      await say(session, "Once more");
      assertBreakdown(await session.getContext(), latestMain(await all()));
      await session.runCommand("clear");
      assert.equal((await session.getContext()).basis, "estimate");
    });
    await session.close();
  });

  await check("plan mode attachments", async () => {
    await withRuntime(async (runtime) => {
      const session = await runtime.createSession({ permissionMode: "plan" });
      const start = fixture.requests.length;
      fixture.script([{ kind: "text", text: "Here is a plan." }]);
      await say(session, "Plan the change");
      await assertSession(session.id, fixture.requests.slice(start));
      await session.close();
    });
  });

  await check("a resumed session splits the restored hook context the same way", async () => {
    await withRuntime(async (runtime) => {
      const session = await runtime.resumeSession(firstSessionId);
      fixture.script([{ kind: "text", text: "Resumed." }]);
      const start = fixture.requests.length;
      await say(session, "After resume");
      const records = await recordsOf(session.id);
      assertCovers(records.at(-1)!, fixture.requests[start]!);
      assert.ok(records.at(-1)!.allSegments.some((segment) => segment.parts?.some((p) => p.source === "hook_output")));
      await session.close();
    });
  });

  console.log("\n[3] coverage");

  await check("every component of the prompt was seen", () => {
    for (const component of [
      "prompt:marker",
      "prompt_section:identity",
      "prompt_section:instructions",
      "prompt_section:environment",
      "prompt_section:agent_md",
      `rule:${path.join(cwd, "AGENT.md")}`,
      "prompt_section:memory",
      "rule:memory",
      "prompt_section:skills",
      "skill:project:review",
      "prompt_section:agents",
      "agent:built-in:general-purpose",
    ]) {
      assert.ok(seenComponents.has(component), `${component} in ${[...seenComponents].join(", ")}`);
    }
  });

  await check("every message source was seen", () => {
    // Sources only the requests of other purposes carry; test:request-trace covers them.
    const otherPurposes: MessageSource[] = [
      "subagent_prompt",
      "classifier_input",
      "web_page",
      "compaction_input",
      "search_query",
    ];
    const main = (Object.keys(MESSAGE_ITEMS) as MessageSource[]).filter((source) => !otherPurposes.includes(source));
    const missing = main.filter((source) => !seenSources.has(source));
    assert.deepEqual(missing, [], "sources without a scenario");
  });

  console.log(`\nContext coverage: ${passed} passed, 0 failed.`);
} finally {
  await fixture.close();
  process.chdir(os.tmpdir());
}
