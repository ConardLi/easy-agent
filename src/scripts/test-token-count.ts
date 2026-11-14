/**
 * Token counts of requests, against the fixture model.
 *
 * - Only Anthropic-protocol requests to api.anthropic.com, or to a profile
 *   with `countTokens: true`, are counted; others send nothing extra and
 *   their breakdown stays the estimate it was.
 * - A counted main-loop request records the provider's count of its system
 *   prompt, tools, and messages. The parts match what the fixture counts for
 *   the request it received, and add up to the input usage it reported
 *   (uncached, cache reads, and cache writes). The system prompt, tool list,
 *   and probe are counted once while they stay the same.
 * - The breakdown and `/context` use the counts and show the cache.
 * - An endpoint without counting (404) is not asked again; a failed count is
 *   retried on the next request; either way the request goes through and the
 *   breakdown says it is an estimate.
 * - A count that settles after its request is added to the record and the
 *   file; the breakdown waits for it.
 * - Requests of other purposes, and an Agent with `trace.level` off, are not
 *   counted.
 *
 * Run: node --import tsx src/scripts/test-token-count.ts
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "easy-agent-token-count-")));
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
process.env.EASY_AGENT_MAX_RETRIES = "0";
process.chdir(cwd);

await writeFile(path.join(cwd, "AGENT.md"), "Project rule: keep answers short.\n");
await writeFile(path.join(cwd, "notes.txt"), "file body\n");

const { createAnthropicFixture, fixtureTokens, FIXTURE_MODEL } = await import("./fixtures/anthropicFixture.js");
type RecordedRequest = import("./fixtures/anthropicFixture.js").RecordedRequest;
const fixture = createAnthropicFixture();
await fixture.start();
process.env.ANTHROPIC_MODEL = FIXTURE_MODEL;
const baseURL = process.env.ANTHROPIC_BASE_URL!;

const sdk = await import("../sdk/index.js");
const { runInScopeOf } = await import("../sdk/session.js");
const storage = await import("../session/storage.js");
const { resetSettingsCache } = await import("../config/sources.js");
const { getLatestRequestRecord, startRequestTrace } = await import("../trace/requestTrace.js");
const { flushRequestTraces } = await import("../trace/traceStore.js");
const { shouldCountTokens } = await import("../services/api/tokenCount.js");
type AgentRuntime = import("../sdk/index.js").AgentRuntime;
type AgentSession = import("../sdk/index.js").AgentSession;
type RequestRecord = import("../trace/requestTrace.js").RequestRecord;
type RequestTokenCount = import("../trace/requestTrace.js").RequestTokenCount;

const profile = (model: string, extra: Record<string, unknown> = {}) => ({
  protocol: "anthropic",
  model,
  baseURL,
  countTokens: true,
  ...extra,
});
const PROFILES = {
  counted: profile("fixture-counted"),
  late: profile("fixture-late"),
  gateway: profile("fixture-gateway"),
  flaky: profile("fixture-flaky"),
  quiet: profile("fixture-quiet"),
  plain: profile("fixture-plain", { countTokens: undefined }),
};
await writeFile(
  path.join(home, ".easy-agent", "settings.json"),
  `${JSON.stringify({ models: PROFILES, harnesses: { quiet: { trace: { level: "off" } } } }, null, 2)}\n`,
);
resetSettingsCache();

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
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

/** Requests of a session's file, with token counts written later merged in. */
async function recordsOf(sessionId: string): Promise<Array<RequestRecord & { lateCount: boolean }>> {
  await flushRequestTraces();
  const lines = (await readFile(await storage.getTracePath(cwd, sessionId), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown> & { type: string });
  const late = new Map(
    lines
      .filter((line) => line.type === "token_count")
      .map((line) => {
        const { type: _type, requestId, ...count } = line;
        return [requestId as string, count as unknown as RequestTokenCount];
      }),
  );
  return lines
    .filter((line) => line.type === "request")
    .map((line) => {
      const record = line as unknown as RequestRecord;
      const lateCount = late.get(record.requestId);
      return { ...record, ...(lateCount ? { tokenCount: lateCount } : {}), lateCount: lateCount !== undefined };
    });
}

async function contextOutput(session: AgentSession, args: string[] = []): Promise<string> {
  const out: string[] = [];
  const off = session.subscribe((event) => {
    if (event.type === "command_output") out.push(event.message);
  });
  await session.runCommand("context", args);
  off();
  return out.join("\n");
}

/** Send `prompt` and return the text the model streamed. */
async function say(session: AgentSession, prompt: string): Promise<string> {
  let text = "";
  const off = session.subscribe((event) => {
    if (event.type === "text_delta") text += event.text;
  });
  await session.send(prompt);
  off();
  return text;
}

const inputTotal = (
  usage: RequestRecord["result"] extends infer R ? (R extends { usage: infer U } ? U : never) : never,
) => usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);

try {
  console.log("\n[1] which endpoints are counted");

  await check("the first-party API counts by default; other endpoints and protocols only on opt-in", () => {
    const anthropic = { id: "a", protocol: "anthropic" as const, model: "claude" };
    assert.equal(shouldCountTokens({ ...anthropic, baseURL: "https://api.anthropic.com" }), true);
    assert.equal(shouldCountTokens({ ...anthropic, baseURL: "https://api.anthropic.com", countTokens: false }), false);
    assert.equal(shouldCountTokens({ ...anthropic, baseURL: "https://gateway.example" }), false);
    assert.equal(shouldCountTokens({ ...anthropic, baseURL: "https://gateway.example", countTokens: true }), true);
    assert.equal(shouldCountTokens({ id: "o", protocol: "openai-chat", model: "gpt", countTokens: true }), false);
  });

  await check("an endpoint that did not opt in sends nothing extra and keeps the estimate", async () => {
    fixture.countTokens("on");
    await withRuntime(undefined, async (runtime) => {
      for (const model of [undefined, "plain"]) {
        const session = await runtime.createSession(model ? { model } : {});
        fixture.script([{ kind: "text", text: "Plain." }]);
        await session.send("Hello");
        assert.equal(fixture.countRequests.length, 0);
        const record = runInScopeOf(session, () => getLatestRequestRecord("main"))!;
        assert.equal(record.tokenCount, undefined);
        const context = await session.getContext();
        assert.equal(context.basis, "request");
        assert.equal(context.estimated, true);
        assert.deepEqual(
          { method: context.request!.tokens.method, countError: context.request!.tokens.countError },
          { method: "estimate", countError: undefined },
        );
        assert.equal(context.request!.cacheReadTokens, undefined);
        const output = await contextOutput(session);
        assert.ok(output.includes("Token figures are estimated from sizes. /context details"), output);
        assert.ok(!output.includes("Prompt cache"), output);
        await session.close();
      }
    });
  });

  console.log("\n[2] a counted session");

  await check("the parts match the request received and add up to the reported usage", async () => {
    fixture.countTokens("on");
    await withRuntime(undefined, async (runtime) => {
      const session = await runtime.createSession({ model: "counted", permissionMode: "auto" });
      const start = fixture.requests.length;
      const countStart = fixture.countRequests.length;
      fixture.script([
        { kind: "tool", name: "Read", input: { file_path: path.join(cwd, "notes.txt") }, cache: { write: 40 } },
        { kind: "text", text: "Read it.", cache: { read: 40, write: 12 } },
      ]);
      assert.equal(await say(session, "Read notes.txt"), "Read it.");
      const received: RecordedRequest[] = fixture.requests.slice(start);
      const records = await recordsOf(session.id);
      assert.equal(records.length, received.length);
      assert.equal(records.length, 2);
      for (const [index, record] of records.entries()) {
        assert.equal(record.purpose, "main");
        const expected = fixtureTokens(received[index]!.body as Parameters<typeof fixtureTokens>[0]);
        assert.deepEqual(record.tokenCount, { status: "counted", ...expected }, `request ${index + 1}`);
        const count = record.tokenCount as Extract<RequestTokenCount, { status: "counted" }>;
        assert.equal(count.system + count.tools + count.messages, count.total);
        assert.equal(inputTotal(record.result!.usage), count.total, "the parts add up to the usage");
      }
      assert.deepEqual(
        {
          read: records[1]!.result!.usage.cache_read_input_tokens,
          write: records[1]!.result!.usage.cache_creation_input_tokens,
        },
        { read: 40, write: 12 },
      );
      assert.equal(records[0]!.system.hash, records[1]!.system.hash);
      assert.equal(records[0]!.tools.hash, records[1]!.tools.hash);
      assert.equal(
        fixture.countRequests.length - countStart,
        4 + 1,
        "probe, system, tools, and request once; the second request only itself",
      );
      for (const request of fixture.countRequests.slice(countStart)) {
        assert.equal(request.body.model, "fixture-counted");
        assert.equal(request.body.max_tokens, undefined);
        assert.equal(request.body.stream, undefined);
      }

      const context = await session.getContext();
      const last = records[1]!;
      const count = last.tokenCount as Extract<RequestTokenCount, { status: "counted" }>;
      assert.equal(context.basis, "request");
      assert.equal(context.estimated, false);
      assert.deepEqual(context.request!.tokens, {
        method: "count",
        system: count.system,
        tools: count.tools,
        messages: count.messages,
      });
      assert.equal(context.request!.inputTokens, count.total);
      assert.equal(context.request!.cacheReadTokens, 40);
      assert.equal(context.request!.cacheWriteTokens, 12);
      assert.equal(context.request!.outputTokens, 5);
      const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
      const partOf = (part: string) => sum(context.components.filter((c) => c.part === part).map((c) => c.tokens));
      assert.equal(partOf("system"), count.system);
      assert.equal(partOf("tools"), count.tools);
      assert.equal(partOf("messages") - context.request!.unsent.tokens, count.messages);
      assert.equal(context.used, count.total + context.request!.unsent.tokens);
      assert.equal(sum(context.categories.map((category) => category.tokens)), context.used);
      assert.equal(sum(Object.values(context.totals)), context.used);

      const output = await contextOutput(session);
      assert.ok(output.includes(`the provider counted ${count.total.toLocaleString("en-US")} input tokens`), output);
      assert.ok(output.includes("Prompt cache: read 40 tok, wrote 12 tok"), output);
      assert.ok(
        output.includes(
          `The provider counted the system prompt (${count.system.toLocaleString("en-US")} tok), tools (${count.tools.toLocaleString("en-US")} tok), and messages (${count.messages.toLocaleString("en-US")} tok)`,
        ),
        output,
      );
      const details = await contextOutput(session, ["details"]);
      assert.ok(details.includes("items within each are split by size"), details);
      await session.close();
    });
  });

  await check(
    "a count that settles after its request is added to the record, and the breakdown waits for it",
    async () => {
      fixture.countTokens("on", { delayMs: 300 });
      await withRuntime(undefined, async (runtime) => {
        const session = await runtime.createSession({ model: "late" });
        const start = fixture.requests.length;
        fixture.script([{ kind: "text", text: "Late." }]);
        await session.send("Hello");
        const record = runInScopeOf(session, () => getLatestRequestRecord("main"))!;
        assert.equal(record.tokenCount, undefined, "the request finished first");
        const context = await session.getContext();
        assert.equal(context.estimated, false);
        const expected = fixtureTokens(fixture.requests[start]!.body as Parameters<typeof fixtureTokens>[0]);
        assert.deepEqual(record.tokenCount, { status: "counted", ...expected });
        const [written] = await recordsOf(session.id);
        assert.equal(written!.lateCount, true, "written as a token_count line");
        assert.deepEqual(written!.tokenCount, record.tokenCount);
        await session.close();
      });
    },
  );

  console.log("\n[3] when counting does not work");

  await check("an endpoint without counting is asked once; requests go through as estimates", async () => {
    fixture.countTokens("off");
    await withRuntime(undefined, async (runtime) => {
      const session = await runtime.createSession({ model: "gateway" });
      const countStart = fixture.countRequests.length;
      fixture.script([
        { kind: "text", text: "First." },
        { kind: "text", text: "Second." },
      ]);
      assert.equal(await say(session, "One"), "First.");
      const asked = fixture.countRequests.length - countStart;
      assert.ok(asked > 0 && asked <= 4, `asked ${asked} times`);
      assert.equal(await say(session, "Two"), "Second.");
      assert.equal(fixture.countRequests.length - countStart, asked, "not asked again");
      const records = await recordsOf(session.id);
      assert.deepEqual(
        records.map((record) => record.tokenCount),
        [{ status: "unsupported" }, { status: "unsupported" }],
      );
      const context = await session.getContext();
      assert.equal(context.estimated, true);
      assert.equal(context.request!.tokens.method, "estimate");
      assert.equal(context.request!.tokens.countError, "unsupported");
      const output = await contextOutput(session);
      assert.ok(output.includes("estimated from sizes: the endpoint does not count tokens"), output);
      await session.close();
    });
  });

  await check("a failed count is tried again on the next request", async () => {
    fixture.countTokens("error");
    await withRuntime(undefined, async (runtime) => {
      const session = await runtime.createSession({ model: "flaky" });
      const countStart = fixture.countRequests.length;
      fixture.script([
        { kind: "text", text: "First." },
        { kind: "text", text: "Second." },
      ]);
      assert.equal(await say(session, "One"), "First.");
      const first = fixture.countRequests.length - countStart;
      let context = await session.getContext();
      assert.equal(context.request!.tokens.countError, "failed");
      assert.ok((await contextOutput(session)).includes("estimated from sizes: the token count failed"));

      fixture.countTokens("on");
      assert.equal(await say(session, "Two"), "Second.");
      assert.ok(fixture.countRequests.length - countStart > first, "asked again");
      context = await session.getContext();
      assert.equal(context.estimated, false);
      const records = await recordsOf(session.id);
      assert.deepEqual(records[0]!.tokenCount, { status: "failed" });
      assert.equal(records[1]!.tokenCount?.status, "counted");
      await session.close();
    });
  });

  console.log("\n[4] what is not counted");

  await check("an Agent with trace.level off counts nothing", async () => {
    fixture.countTokens("on");
    await withRuntime("quiet", async (runtime) => {
      const session = await runtime.createSession({ model: "quiet" });
      const countStart = fixture.countRequests.length;
      fixture.script([{ kind: "text", text: "Quiet." }]);
      await session.send("Hello");
      assert.equal(fixture.countRequests.length, countStart);
      const record = runInScopeOf(session, () => getLatestRequestRecord("main"))!;
      assert.equal(record.tokenCount, undefined);
      assert.equal((await session.getContext()).estimated, true);
      await session.close();
    });
  });

  await check("only main-loop requests want a count, once, after they were measured", () => {
    const sent = {
      protocol: "anthropic",
      model: "m",
      messages: [{ role: "user" as const, content: "hi" }],
      sourceMessages: [{ role: "user" as const, content: "hi" }],
      params: {
        maxTokens: 1,
        betas: [],
        toolSearch: false,
        promptCaching: false,
        cacheMarkers: 0,
        promptCacheKey: false,
      },
    };
    for (const purpose of ["subagent", "classifier", "webFetch", "webSearch", "compaction"] as const) {
      const trace = startRequestTrace({ purpose });
      trace.sent(sent);
      assert.equal(trace.wantsTokenCount, false, purpose);
    }
    const main = startRequestTrace({ purpose: "main" });
    assert.equal(main.wantsTokenCount, false, "not before it was sent");
    main.sent(sent);
    assert.equal(main.wantsTokenCount, true);
    main.tokenCount(Promise.resolve({ status: "failed" }));
    assert.equal(main.wantsTokenCount, false, "counted once");
  });
} finally {
  await fixture.close();
}

console.log(`\nToken counts: ${passed} passed, 0 failed.`);
