/**
 * Prompt caching on the request path.
 *
 * Anthropic: breakpoint placement (static and dynamic system blocks, the
 * previous request's tail, the last message), the spare tool marker,
 * input immutability, the four-marker API limit, single-shot callers, and
 * the EASY_AGENT_DISABLE_PROMPT_CACHING compatibility switch.
 *
 * OpenAI / Gemini: cached prompt tokens are reported as
 * `cache_read_input_tokens`, and `prompt_cache_key` is sent only where it is
 * documented or explicitly enabled.
 *
 * Run: node --import tsx src/scripts/test-prompt-caching.ts
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
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
  applyAnthropicPromptCache,
  buildCachedSystem,
  isPromptCachingDisabled,
  withMessageCacheBreakpoints,
  withToolsCacheBreakpoint,
} = await import("../services/api/promptCache.js");
const { streamMessage, createMessage } = await import("../services/api/streaming.js");
const { streamViaProvider, shouldSendPromptCacheKey } = await import("../services/api/providers/providerStream.js");
const { formatSessionUsage, getCacheHitRate } = await import("../utils/tokens.js");
const { SYSTEM_PROMPT_STATIC_END, SYSTEM_PROMPT_STATIC_START, SYSTEM_PROMPT_DYNAMIC_START, SYSTEM_PROMPT_DYNAMIC_END } =
  await import("../context/systemPrompt.js");
type ModelProfile = import("../services/api/providers/profile.js").ModelProfile;

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function countMarkers(value: unknown): number {
  return (JSON.stringify(value).match(/"cache_control"/g) ?? []).length;
}

function markerOf(value: unknown): unknown {
  return (value as { cache_control?: unknown }).cache_control;
}

const EPHEMERAL = { type: "ephemeral" };

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
  {
    name: "mcp__deferred",
    description: "Deferred",
    input_schema: { type: "object" as const, properties: {} },
    defer_loading: true,
  },
];

const TOOL_LOOP: MessageParam[] = [
  { role: "user", content: "List the files" },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "plan", signature: "sig" },
      { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
    ],
  },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.txt" }] },
  { role: "assistant", content: [{ type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "a.txt" } }] },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "toolu_2", content: "hello" },
      { type: "text", text: "" },
    ],
  },
];

console.log("\n[1] Anthropic breakpoint placement");

await check("the system prompt splits after the static block and both blocks are marked", () => {
  const blocks = buildCachedSystem(SYSTEM);
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0]!.text.endsWith(SYSTEM_PROMPT_STATIC_END));
  assert.ok(blocks[1]!.text.startsWith(SYSTEM_PROMPT_DYNAMIC_START));
  assert.deepEqual(
    blocks.map((block) => block.cache_control),
    [EPHEMERAL, EPHEMERAL],
  );
  assert.equal(`${blocks[0]!.text}\n\n${blocks[1]!.text}`, SYSTEM, "the text sent is unchanged");
});

await check("a system prompt without section markers is one marked block", () => {
  assert.deepEqual(buildCachedSystem("Custom agent prompt"), [
    { type: "text", text: "Custom agent prompt", cache_control: EPHEMERAL },
  ]);
});

await check("tools take the spare marker only when the system prompt is a single block", () => {
  const split = applyAnthropicPromptCache({ system: SYSTEM, tools: TOOLS, messages: [], markMessages: false });
  assert.equal(countMarkers(split.tools), 0);
  const single = applyAnthropicPromptCache({ system: "Custom", tools: TOOLS, messages: [], markMessages: false });
  assert.deepEqual(markerOf(single.tools![1]), EPHEMERAL, "the last loaded tool is marked");
  assert.equal(markerOf(single.tools![2]), undefined, "deferred tools are not in the prompt");
  const none = applyAnthropicPromptCache({ tools: TOOLS, messages: [], markMessages: false });
  assert.equal(countMarkers(none.tools), 1);
  const allDeferred = [TOOLS[2]!];
  assert.equal(withToolsCacheBreakpoint(allDeferred), allDeferred);
});

await check("the last message and the previous request's last message are marked", () => {
  const before = JSON.stringify(TOOL_LOOP);
  const marked = withMessageCacheBreakpoints(TOOL_LOOP);
  assert.equal(countMarkers(marked), 2);
  const last = marked[4]!.content as unknown as Array<Record<string, unknown>>;
  assert.deepEqual(last[0]!.cache_control, EPHEMERAL, "empty trailing text is skipped");
  assert.equal(last[1]!.cache_control, undefined);
  const previous = marked[2]!.content as unknown as Array<Record<string, unknown>>;
  assert.deepEqual(previous[0]!.cache_control, EPHEMERAL);
  assert.equal(marked[0], TOOL_LOOP[0], "unmarked messages are passed through by reference");
  assert.equal(JSON.stringify(TOOL_LOOP), before, "session history is not mutated");
});

await check("hidden messages before a new prompt do not move the previous-request marker", () => {
  const turn: MessageParam[] = [
    ...TOOL_LOOP.slice(0, 3),
    { role: "assistant", content: [{ type: "text", text: "Done." }] },
    { role: "user", content: "[context_update]\n<system-reminder>...</system-reminder>" },
    { role: "user", content: "Next question" },
  ];
  const marked = withMessageCacheBreakpoints(turn);
  assert.equal(countMarkers(marked), 2);
  assert.equal(countMarkers(marked[2]), 1, "the tool result the previous request ended with");
  assert.equal(countMarkers(marked[4]), 0, "the context update is not mistaken for the previous tail");
  assert.equal(countMarkers(marked[5]), 1);
});

await check("string content becomes a marked text block and thinking blocks are never marked", () => {
  const marked = withMessageCacheBreakpoints([{ role: "user", content: "hi" }]);
  assert.deepEqual(marked[0]!.content, [{ type: "text", text: "hi", cache_control: EPHEMERAL }]);
  const thinkingOnly = withMessageCacheBreakpoints([
    { role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "s" }] },
  ]);
  assert.equal(countMarkers(thinkingOnly), 0);
  assert.deepEqual(withMessageCacheBreakpoints([]), []);
});

await check("the compatibility switch accepts the usual truthy spellings", () => {
  for (const value of ["1", "true", "YES", " on "])
    assert.equal(isPromptCachingDisabled({ EASY_AGENT_DISABLE_PROMPT_CACHING: value }), true);
  for (const value of [undefined, "", "0", "false"])
    assert.equal(isPromptCachingDisabled({ EASY_AGENT_DISABLE_PROMPT_CACHING: value }), false);
});

console.log("\n[2] Anthropic request on the wire");

const anthropicBodies: Array<Record<string, unknown>> = [];

function sse(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    anthropicBodies.push(body);
    const usage = { input_tokens: 7, output_tokens: 1, cache_creation_input_tokens: 40, cache_read_input_tokens: 2000 };
    if (body.stream !== true) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "msg_once",
          type: "message",
          role: "assistant",
          model: "claude-fixture",
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage,
        }),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      [
        sse("message_start", {
          type: "message_start",
          message: {
            id: "msg_cache",
            type: "message",
            role: "assistant",
            model: "claude-fixture",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { ...usage, output_tokens: 0 },
          },
        }),
        sse("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
        sse("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "done" },
        }),
        sse("content_block_stop", { type: "content_block_stop", index: 0 }),
        sse("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        }),
        sse("message_stop", { type: "message_stop" }),
      ].join(""),
    );
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
    promptCacheKey: "session-1",
  });
  let step = await generator.next();
  while (!step.done) step = await generator.next();
  return { body: anthropicBodies.at(-1)!, usage: step.value.usage as unknown as Record<string, unknown> };
}

try {
  await check("both system blocks, the previous tail and the last message carry the four markers", async () => {
    const { body } = await send();
    assert.equal(countMarkers(body), 4, "the API accepts at most four cache_control markers");
    const system = body.system as Array<Record<string, unknown>>;
    assert.deepEqual(
      system.map((block) => block.cache_control),
      [EPHEMERAL, EPHEMERAL],
    );
    assert.equal(countMarkers(body.tools), 0);
    assert.equal(countMarkers(body.messages), 2);
    assert.equal(body.prompt_cache_key, undefined, "prompt_cache_key is an OpenAI field");
  });

  await check("cache usage reported by the stream reaches the result", async () => {
    const { usage } = await send();
    assert.equal(usage.cache_read_input_tokens, 2000);
    assert.equal(usage.cache_creation_input_tokens, 40);
  });

  await check("single-shot calls mark only the system prompt and tools, and only when asked", async () => {
    const base = {
      model: "claude-fixture",
      messages: [{ role: "user" as const, content: "classify" }],
      system: "Classifier prompt",
      tools: TOOLS.slice(0, 1),
    };
    await createMessage(base);
    assert.equal(countMarkers(anthropicBodies.at(-1)), 0, "one-off calls do not pay for a cache write");
    await createMessage({ ...base, cacheStablePrefix: true });
    const body = anthropicBodies.at(-1)!;
    assert.equal(countMarkers(body.system), 1);
    assert.equal(countMarkers(body.tools), 1);
    assert.equal(countMarkers(body.messages), 0);
  });

  await check("EASY_AGENT_DISABLE_PROMPT_CACHING restores the uncached request shape", async () => {
    process.env.EASY_AGENT_DISABLE_PROMPT_CACHING = "1";
    try {
      const { body } = await send();
      assert.equal(countMarkers(body), 0);
      assert.equal(body.system, SYSTEM);
      assert.deepEqual(body.tools, TOOLS);
      await createMessage({
        model: "claude-fixture",
        messages: [{ role: "user", content: "x" }],
        system: "S",
        cacheStablePrefix: true,
      });
      assert.equal(countMarkers(anthropicBodies.at(-1)), 0);
    } finally {
      delete process.env.EASY_AGENT_DISABLE_PROMPT_CACHING;
    }
  });
} finally {
  server.close();
}

console.log("\n[3] OpenAI and Gemini");

let providerBody: Record<string, unknown> = {};
let providerChunks: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: string, init: { body?: string }) => {
  providerBody = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  const encoder = new TextEncoder();
  // Small chunks so usage lines are split across reads.
  const bytes = encoder.encode(providerChunks.join(""));
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}) as typeof fetch;

async function runProvider(profile: ModelProfile, chunks: string[], promptCacheKey?: string) {
  providerChunks = chunks;
  const generator = streamViaProvider(profile, {
    messages: [{ role: "user", content: "hi" }],
    system: SYSTEM,
    thinking: { type: "disabled" },
    ...(promptCacheKey ? { promptCacheKey } : {}),
  });
  let step = await generator.next();
  while (!step.done) step = await generator.next();
  return { body: providerBody, usage: step.value.usage };
}

const CHAT_WITH_CACHE = [
  `data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}\n\n`,
  `data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1200,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":1024}}}\n\n`,
  "data: [DONE]\n\n",
];
const CHAT_WITHOUT_CACHE = [
  `data: {"id":"c2","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}\n\n`,
  `data: {"id":"c2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":5}}\n\n`,
  "data: [DONE]\n\n",
];
const RESPONSES_WITH_CACHE = [
  `event: response.created\ndata: {"response":{"id":"r1","model":"gpt"}}\n\n`,
  `event: response.output_text.delta\ndata: {"delta":"ok"}\n\n`,
  `event: response.completed\ndata: {"response":{"status":"completed","usage":{"input_tokens":3000,"input_tokens_details":{"cached_tokens":2944},"output_tokens":9}}}\n\n`,
];
const GEMINI_WITH_CACHE = [
  `data: {"responseId":"g1","candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5000,"candidatesTokenCount":3,"cachedContentTokenCount":4096}}\n\n`,
];

const openai = (protocol: "openai-chat" | "openai-responses", extra: Partial<ModelProfile> = {}): ModelProfile => ({
  id: "p",
  protocol,
  model: "gpt-fixture",
  apiKey: "k",
  ...extra,
});

try {
  await check("Chat Completions cached_tokens become cache_read_input_tokens", async () => {
    const { usage } = await runProvider(openai("openai-chat"), CHAT_WITH_CACHE);
    assert.deepEqual(usage, { input_tokens: 176, output_tokens: 5, cache_read_input_tokens: 1024 });
    assert.equal(getCacheHitRate(usage), 1024 / 1200);
  });

  await check("usage without cache data keeps its previous shape", async () => {
    const { usage } = await runProvider(openai("openai-chat"), CHAT_WITHOUT_CACHE);
    assert.deepEqual(usage, { input_tokens: 12, output_tokens: 5 });
  });

  await check("Responses API input_tokens_details.cached_tokens are reported", async () => {
    const { usage } = await runProvider(openai("openai-responses"), RESPONSES_WITH_CACHE);
    assert.deepEqual(usage, { input_tokens: 56, output_tokens: 9, cache_read_input_tokens: 2944 });
  });

  await check("Gemini cachedContentTokenCount is reported", async () => {
    const profile: ModelProfile = { id: "g", protocol: "gemini", model: "gemini-fixture", apiKey: "k" };
    const { usage, body } = await runProvider(profile, GEMINI_WITH_CACHE, "session-1");
    assert.deepEqual(usage, { input_tokens: 904, output_tokens: 3, cache_read_input_tokens: 4096 });
    assert.equal(body.prompt_cache_key, undefined);
  });

  await check("prompt_cache_key goes to api.openai.com by default and elsewhere only on opt-in", async () => {
    assert.equal(
      (await runProvider(openai("openai-chat"), CHAT_WITHOUT_CACHE, "session-1")).body.prompt_cache_key,
      "session-1",
    );
    assert.equal(
      (await runProvider(openai("openai-responses"), RESPONSES_WITH_CACHE, "session-1")).body.prompt_cache_key,
      "session-1",
    );
    const gateway = openai("openai-chat", { baseURL: "https://gateway.example/v1" });
    assert.equal((await runProvider(gateway, CHAT_WITHOUT_CACHE, "session-1")).body.prompt_cache_key, undefined);
    const optedIn = openai("openai-chat", { baseURL: "https://gateway.example/v1", promptCacheKey: true });
    assert.equal((await runProvider(optedIn, CHAT_WITHOUT_CACHE, "session-1")).body.prompt_cache_key, "session-1");
    const optedOut = openai("openai-responses", { promptCacheKey: false });
    assert.equal(shouldSendPromptCacheKey(optedOut), false);
    assert.equal(
      (await runProvider(openai("openai-chat"), CHAT_WITHOUT_CACHE)).body.prompt_cache_key,
      undefined,
      "no key without a session",
    );
  });

  await check("the compatibility switch also stops prompt_cache_key", async () => {
    process.env.EASY_AGENT_DISABLE_PROMPT_CACHING = "1";
    try {
      assert.equal(
        (await runProvider(openai("openai-chat"), CHAT_WITHOUT_CACHE, "session-1")).body.prompt_cache_key,
        undefined,
      );
    } finally {
      delete process.env.EASY_AGENT_DISABLE_PROMPT_CACHING;
    }
  });
} finally {
  globalThis.fetch = realFetch;
}

console.log("\n[4] usage summary");

await check("/cost output is unchanged without cache activity", () => {
  assert.equal(
    formatSessionUsage({ input_tokens: 12, output_tokens: 3 }),
    "Session usage\n- Input tokens: 12\n- Output tokens: 3\n- Total tokens: 15",
  );
  assert.equal(getCacheHitRate({ input_tokens: 12, output_tokens: 3 }), null);
});

await check("/cost reports cache reads, writes, hit rate, and a total that includes them", () => {
  const usage = {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 800,
    cache_creation_input_tokens: 100,
  };
  assert.equal(
    formatSessionUsage(usage),
    "Session usage\n- Input tokens: 100\n- Cache read tokens: 800\n- Cache write tokens: 100\n- Cache hit rate: 80%\n- Output tokens: 50\n- Total tokens: 1050",
  );
});

// Windows cannot remove the process's current directory.
process.chdir(os.tmpdir());
await rm(root, { recursive: true, force: true });
console.log(`\nPrompt caching: ${passed} passed, 0 failed.`);
