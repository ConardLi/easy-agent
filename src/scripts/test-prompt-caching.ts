/**
 * Prompt caching on the Anthropic request path.
 *
 * Covers breakpoint placement (tools, static system section, previous and
 * last message), input immutability, the four-marker API limit, the
 * EASY_AGENT_DISABLE_PROMPT_CACHING compatibility switch, cache usage
 * propagation from the stream, and the `/cost` usage summary.
 *
 * Run: node --import tsx src/scripts/test-prompt-caching.ts
 */

import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";

const root = await mkdtemp(path.join(os.tmpdir(), "easy-agent-prompt-cache-"));
process.env.HOME = root;
process.env.USERPROFILE = root;
process.chdir(root);
delete process.env.EASY_AGENT_DISABLE_PROMPT_CACHING;

const {
  buildCachedSystem,
  isPromptCachingDisabled,
  withMessageCacheBreakpoints,
  withToolsCacheBreakpoint,
} = await import("../services/api/promptCache.js");
const { streamMessage } = await import("../services/api/streaming.js");
const { formatSessionUsage, getCacheHitRate } = await import("../utils/tokens.js");
const { SYSTEM_PROMPT_STATIC_END, SYSTEM_PROMPT_STATIC_START, SYSTEM_PROMPT_DYNAMIC_START, SYSTEM_PROMPT_DYNAMIC_END } =
  await import("../context/systemPrompt.js");

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function countMarkers(value: unknown): number {
  return (JSON.stringify(value).match(/"cache_control"/g) ?? []).length;
}

const SYSTEM = [
  SYSTEM_PROMPT_STATIC_START,
  "You are Easy Agent.",
  SYSTEM_PROMPT_STATIC_END,
  SYSTEM_PROMPT_DYNAMIC_START,
  "Environment: fixture",
  SYSTEM_PROMPT_DYNAMIC_END,
].join("\n\n");

const TOOLS = [
  { name: "Read", description: "Read a file", input_schema: { type: "object" as const, properties: {} } },
  { name: "Bash", description: "Run a command", input_schema: { type: "object" as const, properties: {} } },
  { name: "mcp__deferred", description: "Deferred", input_schema: { type: "object" as const, properties: {} }, defer_loading: true },
];

const TOOL_LOOP: MessageParam[] = [
  { role: "user", content: "List the files" },
  { role: "assistant", content: [
    { type: "thinking", thinking: "plan", signature: "sig" },
    { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
  ] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.txt" }] },
  { role: "assistant", content: [{ type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "a.txt" } }] },
  { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_2", content: "hello" },
    { type: "text", text: "" },
  ] },
];

console.log("\n[1] breakpoint placement");

await check("system prompt splits after the static section and caches only that block", () => {
  const blocks = buildCachedSystem(SYSTEM);
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0]!.text.endsWith(SYSTEM_PROMPT_STATIC_END));
  assert.deepEqual(blocks[0]!.cache_control, { type: "ephemeral" });
  assert.equal(blocks[1]!.cache_control, undefined);
  assert.ok(blocks[1]!.text.startsWith(SYSTEM_PROMPT_DYNAMIC_START));
  assert.equal(`${blocks[0]!.text}\n\n${blocks[1]!.text}`, SYSTEM);
});

await check("a system prompt without section markers is cached as one block", () => {
  assert.deepEqual(buildCachedSystem("Custom agent prompt"), [
    { type: "text", text: "Custom agent prompt", cache_control: { type: "ephemeral" } },
  ]);
});

await check("the last loaded tool is marked and deferred tools are skipped", () => {
  const before = JSON.stringify(TOOLS);
  const marked = withToolsCacheBreakpoint(TOOLS);
  assert.equal(countMarkers(marked), 1);
  assert.deepEqual((marked[1] as { cache_control?: unknown }).cache_control, { type: "ephemeral" });
  assert.equal(JSON.stringify(TOOLS), before, "tool definitions are not mutated");
  const allDeferred = [TOOLS[2]!];
  assert.equal(withToolsCacheBreakpoint(allDeferred), allDeferred);
});

await check("the last message and the previous user message are marked", () => {
  const before = JSON.stringify(TOOL_LOOP);
  const marked = withMessageCacheBreakpoints(TOOL_LOOP);
  assert.equal(countMarkers(marked), 2);
  const last = marked[4]!.content as unknown as Array<Record<string, unknown>>;
  assert.deepEqual(last[0]!.cache_control, { type: "ephemeral" }, "empty trailing text is skipped");
  assert.equal(last[1]!.cache_control, undefined);
  const previous = marked[2]!.content as unknown as Array<Record<string, unknown>>;
  assert.deepEqual(previous[0]!.cache_control, { type: "ephemeral" });
  assert.equal(marked[0], TOOL_LOOP[0], "unmarked messages are passed through by reference");
  assert.equal(JSON.stringify(TOOL_LOOP), before, "session history is not mutated");
});

await check("string content becomes a marked text block and thinking blocks are never marked", () => {
  const marked = withMessageCacheBreakpoints([{ role: "user", content: "hi" }]);
  assert.deepEqual(marked[0]!.content, [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }]);
  const thinkingOnly = withMessageCacheBreakpoints([
    { role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "s" }] },
  ]);
  assert.equal(countMarkers(thinkingOnly), 0);
  assert.deepEqual(withMessageCacheBreakpoints([]), []);
});

await check("the compatibility switch accepts the usual truthy spellings", () => {
  for (const value of ["1", "true", "YES", " on "]) assert.equal(isPromptCachingDisabled({ EASY_AGENT_DISABLE_PROMPT_CACHING: value }), true);
  for (const value of [undefined, "", "0", "false"]) assert.equal(isPromptCachingDisabled({ EASY_AGENT_DISABLE_PROMPT_CACHING: value }), false);
});

console.log("\n[2] Anthropic request on the wire");

interface Captured { body: Record<string, unknown>; headers: IncomingHttpHeaders }
const requests: Captured[] = [];

function sse(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    requests.push({ body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>, headers: request.headers });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      sse("message_start", { type: "message_start", message: {
        id: "msg_cache", type: "message", role: "assistant", model: "claude-fixture", content: [],
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 7, output_tokens: 0, cache_creation_input_tokens: 40, cache_read_input_tokens: 2000 },
      } }),
      sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }),
      sse("content_block_stop", { type: "content_block_stop", index: 0 }),
      sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
      sse("message_stop", { type: "message_stop" }),
    ].join(""));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.ANTHROPIC_AUTH_TOKEN = "fixture-token";

async function send(): Promise<{ body: Record<string, unknown>; usage: Record<string, unknown> }> {
  const generator = streamMessage({
    model: "claude-fixture",
    messages: TOOL_LOOP,
    system: SYSTEM,
    tools: TOOLS,
    thinking: { type: "disabled" },
  });
  let step = await generator.next();
  while (!step.done) step = await generator.next();
  return { body: requests.at(-1)!.body, usage: step.value.usage as unknown as Record<string, unknown> };
}

try {
  await check("tools, static system, previous and last message carry the four markers", async () => {
    const { body } = await send();
    assert.equal(countMarkers(body), 4, "the API accepts at most four cache_control markers");
    const system = body.system as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(system));
    assert.deepEqual(system[0]!.cache_control, { type: "ephemeral" });
    const tools = body.tools as Array<Record<string, unknown>>;
    assert.deepEqual(tools[1]!.cache_control, { type: "ephemeral" });
    assert.equal(tools[2]!.cache_control, undefined);
    assert.equal(countMarkers(body.messages), 2);
  });

  await check("cache usage reported by the stream reaches the result", async () => {
    const { usage } = await send();
    assert.equal(usage.cache_read_input_tokens, 2000);
    assert.equal(usage.cache_creation_input_tokens, 40);
  });

  await check("EASY_AGENT_DISABLE_PROMPT_CACHING restores the uncached request shape", async () => {
    process.env.EASY_AGENT_DISABLE_PROMPT_CACHING = "1";
    try {
      const { body } = await send();
      assert.equal(countMarkers(body), 0);
      assert.equal(body.system, SYSTEM);
      assert.deepEqual(body.tools, TOOLS);
    } finally {
      delete process.env.EASY_AGENT_DISABLE_PROMPT_CACHING;
    }
  });
} finally {
  server.close();
}

console.log("\n[3] usage summary");

await check("/cost output is unchanged without cache activity", () => {
  assert.equal(
    formatSessionUsage({ input_tokens: 12, output_tokens: 3 }),
    "Session usage\n- Input tokens: 12\n- Output tokens: 3\n- Total tokens: 15",
  );
  assert.equal(getCacheHitRate({ input_tokens: 12, output_tokens: 3 }), null);
});

await check("/cost reports cache reads, writes, hit rate, and a total that includes them", () => {
  const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 800, cache_creation_input_tokens: 100 };
  assert.equal(
    formatSessionUsage(usage),
    "Session usage\n- Input tokens: 100\n- Cache read tokens: 800\n- Cache write tokens: 100\n- Cache hit rate: 80%\n- Output tokens: 50\n- Total tokens: 1050",
  );
});

// Windows cannot remove the process's current directory.
process.chdir(os.tmpdir());
await rm(root, { recursive: true, force: true });
console.log(`\nPrompt caching: ${passed} passed, 0 failed.`);
