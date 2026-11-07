/**
 * Cost of request records, run before a release (`npm run verify:release`).
 *
 * 1. Time a request spends on its record: opening the trace, measuring the
 *    request as sent, and finishing it. Requests grow like a long coding
 *    session (40 tools, a 25 KB system prompt, then tool calls with 4 KB
 *    results up to ~240 messages). The budget is 5 ms per request, at the
 *    95th percentile and for the first request of a resumed session, whose
 *    messages have not been measured before. Writing the file happens off
 *    the request and is reported separately.
 * 2. Size of the record file against the transcript for a session of 30
 *    turns run through the SDK and the fixture model; the budget is 2×.
 *
 * Run: node --import tsx src/scripts/perf-request-trace.ts
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";

const BUDGET_MS = 5;
const SIZE_RATIO = 2;

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "easy-agent-trace-perf-")));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
await Promise.all([mkdir(path.join(home, ".easy-agent"), { recursive: true }), mkdir(cwd, { recursive: true })]);
for (const key of Object.keys(process.env)) {
  if (/^(?:ANTHROPIC_|EASY_AGENT_|CLAUDE_CODE_)/.test(key)) delete process.env[key];
}
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.EASY_AGENT_DISABLE_HOOKS = "1";
process.chdir(cwd);

const { createAnthropicFixture, FIXTURE_MODEL } = await import("./fixtures/anthropicFixture.js");
const fixture = createAnthropicFixture();
await fixture.start();
process.env.ANTHROPIC_MODEL = FIXTURE_MODEL;

const { configureRequestTrace, describeSystemPrompt, startRequestTrace } = await import("../trace/requestTrace.js");
const { flushRequestTraces } = await import("../trace/traceStore.js");
const { createSessionScope, runInSessionScope } = await import("../state/sessionScope.js");
const { createSessionId, getSessionPaths, getTracePath } = await import("../session/storage.js");
const { createAgentRuntime } = await import("../sdk/index.js");

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};
const fmt = (ms: number) => `${ms.toFixed(2)} ms`;

const filler = (size: number, seed: number) => {
  const words = ["alpha", "beta", "gamma", "delta", "const", "return", "function", "import", "value", "result"];
  let text = "";
  for (let i = 0; text.length < size; i++) text += `${words[(i * 7 + seed) % words.length]} `;
  return text.slice(0, size);
};

try {
  // ─── 1. Time per request ─────────────────────────────────────────────
  const tools = Array.from({ length: 40 }, (_, index) => ({
    name: `Tool${index}`,
    description: filler(600, index),
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: filler(120, index + 1) } },
      required: ["path"],
    },
  }));
  const parts = Array.from({ length: 12 }, (_, index) => ({
    component: `prompt_section:part${index}`,
    text: filler(2000, index),
  }));
  const systemText = parts.map((part) => part.text).join("\n\n");
  describeSystemPrompt(systemText, parts);

  const sessionId = createSessionId();
  const scope = createSessionScope();
  const timings: number[] = [];
  let coldMs = 0;
  let messageCount = 0;
  let requestBytes = 0;
  await runInSessionScope(scope, async () => {
    configureRequestTrace({ cwd, sessionId: () => sessionId, persist: true, turnId: () => "turn" });
    const history: MessageParam[] = [{ role: "user", content: filler(400, 3) }];
    const measure = (messages: MessageParam[]) => {
      const started = performance.now();
      const trace = startRequestTrace({ purpose: "main" }, FIXTURE_MODEL);
      trace.sent({
        protocol: "anthropic",
        model: FIXTURE_MODEL,
        systemText,
        system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
        tools,
        messages,
        sourceMessages: messages,
        params: {
          maxTokens: 32000,
          betas: [],
          toolSearch: false,
          promptCaching: true,
          cacheMarkers: 0,
          promptCacheKey: false,
        },
      });
      trace.firstEvent();
      trace.complete({ stopReason: "tool_use", usage: { input_tokens: 1000, output_tokens: 100 } });
      return performance.now() - started;
    };
    for (let step = 0; step < 120; step++) {
      const id = `toolu_${step}`;
      history.push(
        {
          role: "assistant",
          content: [{ type: "tool_use", id, name: "Tool1", input: { path: `src/file${step}.ts` } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: filler(4000, step) }] },
      );
      // Cache markers copy the last message, as on the wire.
      const last = history.at(-1)!;
      timings.push(measure([...history.slice(0, -1), { ...last }]));
    }
    messageCount = history.length;
    requestBytes = Buffer.byteLength(JSON.stringify(history));
    // A resumed session: the same conversation as new objects, measured for the first time.
    coldMs = measure(JSON.parse(JSON.stringify(history)) as MessageParam[]);
    const flushStart = performance.now();
    await flushRequestTraces();
    console.log(`  file writes drained in ${fmt(performance.now() - flushStart)} after the last request`);
  });
  const p50 = percentile(timings, 50);
  const p95 = percentile(timings, 95);
  const max = Math.max(...timings);
  console.log(
    `  ${timings.length} requests up to ${messageCount} messages (${(requestBytes / 1024).toFixed(0)} KB): p50 ${fmt(p50)}, p95 ${fmt(p95)}, max ${fmt(max)}`,
  );
  console.log(`  first request of a resumed session (${messageCount} messages measured fresh): ${fmt(coldMs)}`);
  assert.ok(p95 <= BUDGET_MS, `p95 ${fmt(p95)} exceeds ${BUDGET_MS} ms`);
  assert.ok(coldMs <= BUDGET_MS, `cold request ${fmt(coldMs)} exceeds ${BUDGET_MS} ms`);
  console.log(`  ✓ a request spends at most ${BUDGET_MS} ms on its record`);

  // ─── 2. File size against the transcript ─────────────────────────────
  await writeFile(path.join(cwd, "module.ts"), `${filler(2400, 9)}\n`);
  const runtime = await createAgentRuntime({
    cwd,
    trust: "session",
    services: false,
    logger: { warn() {}, error() {} },
  });
  let id = "";
  try {
    const session = await runtime.createSession({ permissionMode: "auto" });
    id = session.id;
    for (let turn = 0; turn < 30; turn++) {
      fixture.script([
        { kind: "tool", name: "Read", input: { file_path: path.join(cwd, "module.ts") } },
        { kind: "text", text: `Turn ${turn}: ${filler(300, turn)}` },
      ]);
      await session.send(`Question ${turn}: ${filler(160, turn)}`);
    }
    await session.close();
  } finally {
    await runtime.dispose();
  }
  await flushRequestTraces();
  const transcriptBytes = (await stat((await getSessionPaths(cwd, id)).transcriptPath)).size;
  const traceFile = await getTracePath(cwd, id);
  const traceBytes = (await stat(traceFile)).size;
  const requests = (await readFile(traceFile, "utf8")).split("\n").filter((line) => line.includes('"type":"request"'));
  const ratio = traceBytes / transcriptBytes;
  console.log(
    `  30 turns, ${requests.length} requests: transcript ${(transcriptBytes / 1024).toFixed(1)} KB, records ${(traceBytes / 1024).toFixed(1)} KB (${ratio.toFixed(2)}×)`,
  );
  assert.ok(ratio <= SIZE_RATIO, `records are ${ratio.toFixed(2)}× the transcript`);
  console.log(`  ✓ the record file stays within ${SIZE_RATIO}× the transcript`);
  console.log("\nRequest record performance: 2 passed, 0 failed.");
} finally {
  await fixture.close();
  process.chdir(os.tmpdir());
  await rm(root, { recursive: true, force: true });
}
