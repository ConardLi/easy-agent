/**
 * Request records (`trace.level`), against the fixture model.
 *
 * - Recording does not change what is sent: the requests with `off` and with
 *   `summary` are byte-identical.
 * - Each record matches the request the fixture received: the hash and size
 *   of the system prompt, the tool list, and every message (rebuilt from the
 *   file's `reused` prefixes), the cache markers, and the usage the response
 *   reported. System prompt sections, tools, and messages carry their
 *   components and sources; no text of the prompt, the files, or the
 *   conversation reaches the file.
 * - The main loop, a sub-agent, the Auto Mode classifier, and compaction are
 *   recorded with their purpose and parent request; retries are counted.
 * - The file sits next to the transcript with private permissions; `off`, a
 *   session without a transcript, and `cleanupPeriodDays: 0` write none
 *   while the latest record stays in memory; retention and session deletion
 *   remove it; session listing ignores it.
 * - A translated protocol (OpenAI Chat) records the bytes actually sent.
 * - Messages restored from a transcript get the same source as when marked.
 *
 * Run: node --import tsx src/scripts/test-request-trace.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "easy-agent-request-trace-")));
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
process.env.EASY_AGENT_DISABLE_HOOKS = "1";
process.env.EASY_AGENT_MAX_RETRIES = "2";
process.chdir(cwd);

const SECRET = "TRACE-SECRET-7f3a91";
await writeFile(path.join(cwd, "AGENT.md"), `Project rule: mention ${SECRET}-rules when asked.\n`);
await writeFile(path.join(cwd, "notes.txt"), `file body ${SECRET}-file\n`);

const { createAnthropicFixture, FIXTURE_MODEL } = await import("./fixtures/anthropicFixture.js");
type RecordedRequest = import("./fixtures/anthropicFixture.js").RecordedRequest;
const fixture = createAnthropicFixture();
await fixture.start();
process.env.ANTHROPIC_MODEL = FIXTURE_MODEL;

const sdk = await import("../sdk/index.js");
const { runInScopeOf } = await import("../sdk/session.js");
const storage = await import("../session/storage.js");
const { resetSettingsCache } = await import("../config/sources.js");
const { getLatestRequestRecord } = await import("../trace/requestTrace.js");
const { flushRequestTraces } = await import("../trace/traceStore.js");
const sources = await import("../core/messageSources.js");
type AgentRuntime = import("../sdk/index.js").AgentRuntime;
type RequestRecord = import("../trace/requestTrace.js").RequestRecord;

const userSettings = path.join(home, ".easy-agent", "settings.json");
const writeJson = (file: string, value: unknown) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

async function setUserSettings(settings: Record<string, unknown>): Promise<void> {
  await writeJson(userSettings, settings);
  resetSettingsCache();
}

async function withRuntime<T>(harness: string | undefined, fn: (runtime: AgentRuntime) => Promise<T>): Promise<T> {
  const runtime = await sdk.createAgentRuntime({
    cwd,
    trust: "session",
    services: false,
    logger: { warn() {}, error() {} },
    ...(harness ? { harness: { name: harness } } : {}),
  });
  try {
    return await fn(runtime);
  } finally {
    await runtime.dispose();
  }
}

async function tracePath(sessionId: string): Promise<string> {
  return storage.getTracePath(cwd, sessionId);
}

type TraceLine = Record<string, unknown> & { type: string };

async function readTrace(sessionId: string): Promise<TraceLine[]> {
  await flushRequestTraces();
  const text = await readFile(await tracePath(sessionId), "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as TraceLine);
}

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

/** Requests of a file with their message hashes rebuilt from `reused` prefixes. */
function requestsOf(lines: TraceLine[]): Array<RequestRecord & { messageHashes: string[] }> {
  const hashesById = new Map<string, string[]>();
  return lines
    .filter((line) => line.type === "request")
    .map((line) => {
      const record = line as unknown as RequestRecord & {
        messages: RequestRecord["messages"] & { reused?: { requestId: string; count: number } };
      };
      const reused = record.messages.reused;
      const prefix = reused ? hashesById.get(reused.requestId)!.slice(0, reused.count) : [];
      assert.deepEqual(
        record.messages.segments.map((segment) => segment.index),
        record.messages.segments.map((_, index) => prefix.length + index),
        "written segments continue after the reused prefix",
      );
      const messageHashes = [...prefix, ...record.messages.segments.map((segment) => segment.hash)];
      hashesById.set(record.requestId, messageHashes);
      return { ...record, messageHashes };
    });
}

/** The record matches the body the fixture received. */
function assertMatches(
  record: RequestRecord & { messageHashes: string[] },
  request: RecordedRequest,
  segments: Map<string, unknown[]>,
): void {
  const body = request.body;
  const system = JSON.stringify(body.system);
  assert.equal(record.system.hash, digest(system), "system hash");
  assert.equal(record.system.bytes, Buffer.byteLength(system), "system bytes");
  const tools = JSON.stringify(body.tools);
  assert.equal(record.tools.hash, digest(tools), "tools hash");
  assert.equal(record.tools.bytes, Buffer.byteLength(tools), "tools bytes");
  assert.equal(record.tools.count, (body.tools as unknown[]).length);
  const toolSegments = segments.get(`tools:${record.tools.hash}`) as Array<{ component: string; hash: string }>;
  assert.deepEqual(
    toolSegments.map((segment) => segment.hash),
    (body.tools as unknown[]).map((tool) => digest(JSON.stringify(tool))),
    "one segment per tool, in order",
  );
  assert.deepEqual(
    toolSegments.map((segment) => segment.component),
    (body.tools as Array<{ name: string }>).map((tool) => `tool:${tool.name}`),
  );
  const messages = request.messages;
  assert.equal(record.messages.count, messages.length);
  assert.deepEqual(
    record.messageHashes,
    messages.map((message) => digest(JSON.stringify(message))),
    "every message hash matches",
  );
  assert.equal(record.messages.bytes, Buffer.byteLength(JSON.stringify(messages)), "messages bytes");
  assert.equal(record.params.cacheMarkers, JSON.stringify(body).split('"cache_control"').length - 1, "cache markers");
  assert.equal(record.params.maxTokens, body.max_tokens);
  assert.equal(record.model.sent, body.model);
  assert.equal(record.protocol, "anthropic");
  assert.equal(record.estimated, true);
}

function segmentsOf(lines: TraceLine[]): Map<string, unknown[]> {
  return new Map(
    lines
      .filter((line) => line.type === "segments")
      .map((line) => [`${line.part}:${line.hash}`, line.segments as unknown[]]),
  );
}

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const normalize = (requests: RecordedRequest[]) =>
  requests.map((request) => JSON.stringify(request.body).replace(/toolu_\d+/g, "toolu_N"));

try {
  console.log("\n[1] what is sent");

  await check("requests are byte-identical with trace.level off and summary", async () => {
    const script = () =>
      fixture.script([
        { kind: "tool", name: "Read", input: { file_path: path.join(cwd, "notes.txt") } },
        { kind: "text", text: "Read it." },
      ]);
    const run = async (harness: string | undefined) => {
      const start = fixture.requests.length;
      await withRuntime(harness, async (runtime) => {
        const session = await runtime.createSession({ permissionMode: "auto" });
        script();
        await session.send("Read notes.txt");
        await session.close();
      });
      return normalize(fixture.requests.slice(start));
    };
    await setUserSettings({ harnesses: { quiet: { trace: { level: "off" } } } });
    const off = await run("quiet");
    const summary = await run(undefined);
    assert.equal(off.length, 2);
    assert.deepEqual(summary, off);
  });

  console.log("\n[2] the record of a session");

  let sessionId = "";
  await check("each main-loop request is recorded and matches what the fixture received", async () => {
    await setUserSettings({});
    const start = fixture.requests.length;
    await withRuntime(undefined, async (runtime) => {
      const session = await runtime.createSession({ permissionMode: "auto" });
      sessionId = session.id;
      fixture.script([
        { kind: "tool", name: "Read", input: { file_path: path.join(cwd, "notes.txt") } },
        { kind: "text", text: `Done ${SECRET}-reply` },
      ]);
      await session.send(`Please read notes.txt ${SECRET}-prompt`);
      fixture.script([{ kind: "text", text: "Again." }]);
      await session.send("And once more");

      const latest = runInScopeOf(session, () => getLatestRequestRecord());
      assert.ok(latest, "the latest request stays in memory");
      assert.equal(latest.messages.segments.length, latest.messages.count, "in memory every segment is kept");
      await session.close();
    });
    const received = fixture.requests.slice(start);
    assert.equal(received.length, 3);

    const lines = await readTrace(sessionId);
    assert.deepEqual(lines[0], { type: "trace_meta", version: 1, sessionId });
    const segments = segmentsOf(lines);
    const requests = requestsOf(lines);
    assert.equal(requests.length, 3);
    for (const [index, record] of requests.entries()) assertMatches(record, received[index]!, segments);
    assert.ok(
      requests.every((record) => record.purpose === "main" && !record.parentRequestId),
      "main-loop requests have no parent",
    );
    assert.ok((requests[1]!.messages as { reused?: { count: number } }).reused!.count >= 1, "later requests reuse");
    assert.ok(
      requests[1]!.messages.segments.length < requests[1]!.messages.count,
      "only new messages are written again",
    );
    assert.equal(lines.filter((line) => line.type === "segments" && line.part === "system").length, 1);
    for (const record of requests) {
      assert.deepEqual(record.result!.usage, { input_tokens: 10, output_tokens: 5 });
      assert.equal(record.result!.attempts, 1);
      assert.deepEqual(record.result!.retries, []);
      assert.ok(typeof record.result!.firstEventMs === "number");
      assert.equal(record.sessionId, sessionId);
    }
    assert.deepEqual(
      requests.map((record) => record.result!.stopReason),
      ["tool_use", "end_turn", "end_turn"],
    );

    const transcript = (await readFile((await storage.getSessionPaths(cwd, sessionId)).transcriptPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; role?: string; messageId?: string });
    const turnIds = transcript.filter((entry) => entry.type === "message" && entry.role === "user");
    assert.equal(requests[0]!.turnId, turnIds[0]!.messageId, "turnId is the transcript's messageId");
    assert.equal(requests[2]!.turnId, turnIds.at(-1)!.messageId);

    const text = await readFile(await tracePath(sessionId), "utf8");
    assert.ok(!text.includes(SECRET), "no text of the prompt, files, rules, or replies is recorded");
  });

  await check("system sections, tools, and messages carry their components and sources", async () => {
    const lines = await readTrace(sessionId);
    const [first, , third] = requestsOf(lines);
    const system = segmentsOf(lines).get(`system:${first!.system.hash}`) as Array<{
      component: string;
      bytes: number;
    }>;
    const components = system.map((segment) => segment.component);
    for (const component of [
      "prompt_section:identity",
      "prompt_section:instructions",
      "prompt_section:environment",
      "prompt_section:agent_md",
      "prompt_section:memory",
      "prompt:marker",
    ]) {
      assert.ok(components.includes(component), `${component} in ${components.join(", ")}`);
    }
    assert.ok(!components.includes("prompt:unattributed"));
    const blocks = fixture.requests.find(
      (request) => digest(JSON.stringify(request.body.system)) === first!.system.hash,
    )!.body.system as Array<{ text: string }>;
    assert.equal(
      system.reduce((sum, segment) => sum + segment.bytes, 0),
      Buffer.byteLength(blocks.map((block) => block.text).join("\n\n")),
      "system segments add up to the prompt text",
    );
    assert.deepEqual(
      third!.messages.bySource.tool_result?.count,
      1,
      "the tool result of the first turn is counted by source",
    );
    assert.deepEqual(Object.keys(third!.messages.bySource).sort(), ["assistant", "tool_result", "user_input"]);
    assert.equal(third!.messages.bySource.user_input!.count, 2);
  });

  await check("the file is private, next to the transcript, and ignored by session listing", async () => {
    const file = await tracePath(sessionId);
    assert.equal(path.dirname(file), path.dirname((await storage.getSessionPaths(cwd, sessionId)).transcriptPath));
    assert.ok(file.endsWith(`${sessionId}.trace.ndjson`));
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
    const listed = await storage.listProjectSessions(cwd);
    assert.ok(listed.some((session) => session.sessionId === sessionId));
    assert.ok(listed.every((session) => !session.sessionId.includes("trace")));
  });

  await check("a resumed session appends to the same file", async () => {
    const before = requestsOf(await readTrace(sessionId)).length;
    await withRuntime(undefined, async (runtime) => {
      const session = await runtime.resumeSession(sessionId);
      fixture.script([{ kind: "text", text: "Resumed." }]);
      await session.send("Resumed prompt");
      await session.close();
    });
    const lines = await readTrace(sessionId);
    assert.equal(lines.filter((line) => line.type === "trace_meta").length, 1, "one meta line");
    const requests = requestsOf(lines);
    assert.equal(requests.length, before + 1);
    assertMatches(requests.at(-1)!, fixture.requests.at(-1)!, segmentsOf(lines));
  });

  console.log("\n[3] purposes, parents, and retries");

  await check("a sub-agent's requests name the request that started it", async () => {
    const start = fixture.requests.length;
    let id = "";
    await withRuntime(undefined, async (runtime) => {
      const session = await runtime.createSession({ permissionMode: "auto" });
      id = session.id;
      fixture.script([
        {
          kind: "tool",
          name: "Agent",
          input: { description: "probe", prompt: "Say hi", subagent_type: "general-purpose" },
        },
        { kind: "text", text: "sub-agent reply" },
        { kind: "text", text: "All done." },
      ]);
      await session.send("Delegate this");
      await session.close();
    });
    assert.equal(fixture.requests.length - start, 3);
    const lines = await readTrace(id);
    const requests = requestsOf(lines);
    assert.deepEqual(
      requests.map((record) => record.purpose),
      ["main", "subagent", "main"],
    );
    const [main, sub] = requests;
    assert.equal(sub!.parentRequestId, main!.requestId);
    assert.equal(sub!.agent?.type, "general-purpose");
    assert.equal(sub!.turnId, main!.turnId);
    assert.deepEqual(Object.keys(sub!.messages.bySource), ["subagent_prompt"]);
    const system = segmentsOf(lines).get(`system:${sub!.system.hash}`) as Array<{ component: string }>;
    assert.deepEqual(
      system.map((segment) => segment.component),
      ["agent:built-in:general-purpose"],
    );
    assertMatches(sub!, fixture.requests[start + 1]!, segmentsOf(lines));
  });

  await check("the Auto Mode classifier is recorded under the request whose tool call it judges", async () => {
    let id = "";
    await withRuntime(undefined, async (runtime) => {
      const session = await runtime.createSession({ permissionMode: "auto" });
      id = session.id;
      fixture.script([
        { kind: "tool", name: "Bash", input: { command: "touch made-by-bash.txt" } },
        {
          kind: "tool",
          name: "classify_result",
          input: { shouldBlock: false, reason: "creates a file in the project" },
        },
        { kind: "text", text: "Made it." },
      ]);
      await session.send("Make a file");
      await session.close();
    });
    const requests = requestsOf(await readTrace(id));
    const classifier = requests.find((record) => record.purpose === "classifier");
    assert.ok(classifier, `purposes: ${requests.map((record) => record.purpose).join(", ")}`);
    assert.equal(classifier.parentRequestId, requests[0]!.requestId);
    assert.equal(classifier.params.toolChoice, "tool:classify_result");
    assert.deepEqual(Object.keys(classifier.messages.bySource), ["classifier_input"]);
    assert.equal(classifier.result!.stopReason, "tool_use");
  });

  await check("compaction is recorded with its purpose", async () => {
    let id = "";
    await withRuntime(undefined, async (runtime) => {
      const session = await runtime.createSession();
      id = session.id;
      fixture.script([{ kind: "text", text: "First answer." }]);
      await session.send("First question");
      fixture.script([{ kind: "text", text: "Summary of the work." }]);
      await session.runCommand("compact");
      await session.close();
    });
    const compaction = requestsOf(await readTrace(id)).find((record) => record.purpose === "compaction");
    assert.ok(compaction);
    assert.deepEqual(Object.keys(compaction.messages.bySource), ["compaction_input"]);
    assert.equal(compaction.result!.firstEventMs, undefined, "single-shot requests have no first event");
  });

  await check("retries are counted on one record", async () => {
    let id = "";
    const start = fixture.requests.length;
    await withRuntime(undefined, async (runtime) => {
      const session = await runtime.createSession();
      id = session.id;
      // The Anthropic SDK retries a 500 twice within one attempt; the third
      // failure reaches Easy Agent's retry, which sends the request again.
      const failure = { kind: "error" as const, status: 500, message: "overloaded for a moment" };
      fixture.script([failure, failure, failure, { kind: "text", text: "Got through." }]);
      await session.send("Try");
      await session.close();
    });
    assert.equal(fixture.requests.length - start, 4);
    const [record] = requestsOf(await readTrace(id));
    assert.equal(record!.result!.attempts, 2);
    assert.equal(record!.result!.retries.length, 1);
    assert.equal(record!.result!.retries[0]!.attempt, 1);
    assert.equal(record!.result!.stopReason, "end_turn");
  });

  await check("a failed request is recorded with its error category", async () => {
    let id = "";
    await withRuntime(undefined, async (runtime) => {
      const session = await runtime.createSession();
      id = session.id;
      fixture.script([{ kind: "error", status: 400, message: "bad request" }]);
      await session.send("Fail");
      await session.close();
    });
    const [record] = requestsOf(await readTrace(id));
    assert.equal(record!.result!.stopReason, "error");
    assert.ok(record!.result!.error);
  });

  console.log("\n[4] when nothing is written");

  await check("trace.level off writes no file; the latest record stays in memory", async () => {
    await setUserSettings({ harnesses: { quiet: { trace: { level: "off" } } } });
    await withRuntime("quiet", async (runtime) => {
      const session = await runtime.createSession();
      fixture.script([{ kind: "text", text: "Quiet." }]);
      await session.send("Hello");
      assert.equal(runInScopeOf(session, () => getLatestRequestRecord("main"))?.result?.stopReason, "end_turn");
      await session.close();
      await flushRequestTraces();
      assert.equal(await exists(await tracePath(session.id)), false);
      assert.equal(await exists((await storage.getSessionPaths(cwd, session.id)).transcriptPath), true);
    });
  });

  await check("trace.level full warns and records at summary level", async () => {
    await setUserSettings({ harnesses: { full: { trace: { level: "full" } } } });
    await withRuntime("full", async (runtime) => {
      const harness = await runtime.getHarness();
      assert.ok(harness.issues.some((issue) => issue.path === "trace.level" && issue.level === "warning"));
      const session = await runtime.createSession();
      fixture.script([{ kind: "text", text: "Full." }]);
      await session.send("Hello");
      await session.close();
      assert.equal(requestsOf(await readTrace(session.id)).length, 1);
    });
    await setUserSettings({});
  });

  await check("a session without a transcript writes no file", async () => {
    await withRuntime(undefined, async (runtime) => {
      const session = await runtime.createSession({ persist: false });
      fixture.script([{ kind: "text", text: "Ephemeral." }]);
      await session.send("Hello");
      assert.ok(runInScopeOf(session, () => getLatestRequestRecord()));
      await session.close();
      await flushRequestTraces();
      assert.equal(await exists(await tracePath(session.id)), false);
    });
  });

  await check("retention removes old files, and cleanupPeriodDays 0 removes all and writes none", async () => {
    const projectDir = path.dirname(await tracePath(sessionId));
    const orphan = path.join(projectDir, "orphan-session.trace.ndjson");
    await writeFile(orphan, "{}\n");
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await utimes(orphan, old, old);
    await withRuntime(undefined, async () => {});
    assert.equal(await exists(orphan), false, "an old file goes after 30 days");
    assert.equal(await exists(await tracePath(sessionId)), true, "a recent one stays");

    await setUserSettings({ cleanupPeriodDays: 0 });
    await withRuntime(undefined, async (runtime) => {
      assert.deepEqual(
        (await readdir(projectDir)).filter((name) => name.endsWith(".trace.ndjson")),
        [],
        "every request record file is removed",
      );
      const session = await runtime.createSession();
      fixture.script([{ kind: "text", text: "Nothing kept." }]);
      await session.send("Hello");
      await session.close();
      await flushRequestTraces();
      assert.equal(await exists(await tracePath(session.id)), false);
    });
    await setUserSettings({});
  });

  await check("deleting a session removes its file", async () => {
    await withRuntime(undefined, async (runtime) => {
      const session = await runtime.createSession();
      fixture.script([{ kind: "text", text: "Short-lived." }]);
      await session.send("Hello");
      await session.close();
      await flushRequestTraces();
      assert.equal(await exists(await tracePath(session.id)), true);
      await runtime.deleteSession(session.id);
      assert.equal(await exists(await tracePath(session.id)), false);
    });
  });

  console.log("\n[5] translated protocols and message sources");

  await check("an OpenAI Chat request records the bytes it sent", async () => {
    const bodies: string[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        bodies.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
        response.end(
          chunk({
            id: "c1",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }],
          }) +
            chunk({
              id: "c1",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            }) +
            chunk({
              id: "c1",
              object: "chat.completion.chunk",
              choices: [],
              usage: { prompt_tokens: 7, completion_tokens: 2 },
            }) +
            "data: [DONE]\n\n",
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      await setUserSettings({
        models: { oai: { protocol: "openai-chat", model: "gpt-test", baseURL, apiKey: "test-key" } },
      });
      let id = "";
      await withRuntime(undefined, async (runtime) => {
        const session = await runtime.createSession({ model: "oai" });
        id = session.id;
        await session.send("Hello there");
        await session.close();
      });
      const [record] = requestsOf(await readTrace(id));
      assert.equal(record!.protocol, "openai-chat");
      assert.equal(record!.model.sent, "gpt-test");
      assert.equal(record!.wireBytes, Buffer.byteLength(bodies[0]!));
      assert.equal(record!.messages.count, 1);
      assert.equal(record!.result!.usage.input_tokens, 7);
    } finally {
      server.close();
      await setUserSettings({});
    }
  });

  await check("messages restored from a transcript get the source they were marked with", async () => {
    const { getPlanModeAttachment, getPlanModeExitAttachment } = await import("../context/planAttachments.js");
    const { formatContextNote } = await import("../context/sessionPromptContext.js");
    const { formatMailboxAttachment } = await import("../utils/teammateMailbox.js");
    const { markMessageSource, inferMessageSource, messageSourceOf } = sources;
    const restored = (message: import("@anthropic-ai/sdk/resources/messages.js").MessageParam) =>
      inferMessageSource(JSON.parse(JSON.stringify(message)));
    const plan = getPlanModeAttachment([], "/tmp/plan.md")!;
    assert.equal(messageSourceOf(plan), "plan_attachment");
    assert.equal(restored(plan), "plan_attachment");
    assert.equal(restored(getPlanModeExitAttachment("/tmp/plan.md", true)), "plan_attachment");
    assert.equal(restored({ role: "user", content: formatContextNote(["changed"]) }), "context_update");
    assert.equal(
      restored({
        role: "user",
        content: formatMailboxAttachment([{ from: "a", text: "hi", timestamp: "t", read: false } as never]),
      }),
      "team_message",
    );
    assert.equal(restored({ role: "user", content: "[task-notification]\ndone" }), "background_notification");
    assert.equal(restored({ role: "user", content: "[skill_invocation:x]\nbody" }), "skill_body");
    assert.equal(restored({ role: "user", content: "[command_invocation:x]\nbody" }), "command");
    assert.equal(restored({ role: "assistant", content: "[CompactBoundary]\ntype=auto" }), "compaction_summary");
    assert.equal(
      restored({ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] }),
      "tool_result",
    );
    assert.equal(
      restored({ role: "user", content: "[task-notification] typed by the user" }),
      "background_notification",
    );
    const typed = markMessageSource({ role: "user", content: "[task-notification] typed by the user" }, "user_input");
    assert.equal(messageSourceOf(typed), "user_input", "a mark wins over the prefix");
  });

  console.log(`\nRequest records: ${passed} passed, 0 failed.`);
} finally {
  await fixture.close();
  process.chdir(os.tmpdir());
  await rm(root, { recursive: true, force: true });
}
