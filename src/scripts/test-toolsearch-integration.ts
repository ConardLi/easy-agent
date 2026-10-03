/** ToolSearch request/dispatch integration. All HTTP requests are intercepted. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { query, runTools } from "../core/agenticLoop.js";
import { compactMessages, microCompactMessages } from "../context/compaction.js";
import { getFlagSettings, setFlagSettings } from "../config/sources.js";
import { toolSearchTool } from "../tools/toolSearchTool.js";
import { toolToApiParam, type Tool } from "../tools/Tool.js";
import { prepareRequest } from "../services/api/providers/providerStream.js";
import {
  extractDiscoveredToolNames,
  normalizeToolReferencesForAPI,
  prepareToolSearchRequest,
  TOOL_SEARCH_BETA_HEADER,
} from "../utils/toolSearch.js";
import { setSessionThinkingConfig } from "../utils/thinking.js";
import { fetchToolsForConnection } from "../services/mcp/fetchTools.js";
import { setMcpRegistryEntry, deleteMcpRegistryEntry, hasPendingMcpServers } from "../services/mcp/registry.js";
import type { ConnectedMcpServer, PendingMcpServer } from "../types/mcp.js";

const cwd = await mkdtemp(join(tmpdir(), "ea-toolsearch-"));
const originalFetch = globalThis.fetch;
const originalFlags = getFlagSettings();
const envKeys = [
  "EASY_AGENT_ENABLE_TOOL_SEARCH",
  "ENABLE_TOOL_SEARCH",
  "EASY_AGENT_DISABLE_HOOKS",
  "EASY_AGENT_DISABLE_EXPERIMENTAL_BETAS",
  "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
];
const savedEnv = envKeys.map((key) => [key, process.env[key]] as const);
let calls = 0;
const echo: Tool = {
  name: "DeferredEcho",
  description: "Return the supplied value",
  shouldDefer: true,
  inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  isEnabled: () => true,
  isReadOnly: () => true,
  async call(input) {
    calls++;
    return { content: String(input.value) };
  },
};
const pool = [toolSearchTool, echo];
const env = { protocol: "anthropic" as const };
const requests: { body: any; headers: Headers }[] = [];
let responses: { name: string; input: Record<string, unknown> }[] = [];
const event = (type: string, value: unknown) => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;

globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(url, init);
  const body = JSON.parse(await request.text());
  requests.push({ body, headers: request.headers });
  if (!body.stream) {
    return Response.json({
      id: "summary",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: "The tools were discovered and the echo returned OK." }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    });
  }
  const next = responses.shift();
  const content = next
    ? { type: "tool_use", id: `call_${requests.length}`, name: next.name, input: {} }
    : { type: "text", text: "" };
  const chunks = [
    event("message_start", {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    }),
    event("content_block_start", { type: "content_block_start", index: 0, content_block: content }),
    event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: next
        ? { type: "input_json_delta", partial_json: JSON.stringify(next.input) }
        : { type: "text_delta", text: "OK" },
    }),
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: next ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 10 },
    }),
    event("message_stop", { type: "message_stop" }),
  ];
  return new Response(chunks.join(""), { headers: { "content-type": "text/event-stream" } });
}) as typeof fetch;

async function drive(
  model = "toolsearch-test",
  tools = pool,
  messages: MessageParam[] = [{ role: "user", content: "Echo OK" }],
) {
  const loop = query({ model, tools, messages, maxTurns: 5, toolContext: { cwd }, permissionMode: "default" });
  let next = await loop.next();
  while (!next.done) next = await loop.next();
  assert.equal(next.value.reason, "completed");
  return next.value.state.messages;
}

try {
  for (const key of envKeys) delete process.env[key];
  process.env.EASY_AGENT_ENABLE_TOOL_SEARCH = "true";
  process.env.EASY_AGENT_DISABLE_HOOKS = "1";
  setSessionThinkingConfig({ type: "disabled" });
  setFlagSettings({
    models: {
      "toolsearch-test": {
        protocol: "anthropic",
        model: "claude-sonnet-4-5",
        baseURL: "https://toolsearch.invalid",
        apiKey: "fixture",
      },
      "small-alias": {
        protocol: "anthropic",
        model: "claude-haiku-4-5",
        baseURL: "https://toolsearch.invalid",
        apiKey: "fixture",
      },
    },
  });

  responses = [
    { name: "ToolSearch", input: { query: "select:DeferredEcho" } },
    { name: "DeferredEcho", input: { value: "OK" } },
  ];
  const history = await drive();
  assert.equal(calls, 1);
  assert.deepEqual(
    requests[0]!.body.tools.map((t: any) => t.name),
    ["ToolSearch"],
  );
  assert.match(JSON.stringify(requests[0]!.body.messages), /available-deferred-tools/);
  assert(requests[1]!.body.tools.some((t: any) => t.name === "DeferredEcho" && t.defer_loading));
  assert(requests[1]!.headers.get("anthropic-beta")?.includes(TOOL_SEARCH_BETA_HEADER));
  assert.match(JSON.stringify(requests[1]!.body.messages), /Tool loaded\./);
  assert(!JSON.stringify(history).includes("Tool loaded."));
  assert(!JSON.stringify(history).includes("available-deferred-tools"));
  console.log("✓ streamed search → schema → dispatch; API-only decorations never enter history");

  const restored = JSON.parse(JSON.stringify(history)) as MessageParam[];
  assert(extractDiscoveredToolNames(restored).has("DeferredEcho"));
  const longHistory = [
    ...restored,
    ...Array.from(
      { length: 16 },
      (_, i): MessageParam => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i}` }),
    ),
  ];
  assert(extractDiscoveredToolNames(microCompactMessages(longHistory).messages).has("DeferredEcho"));
  const compacted = await compactMessages(longHistory, undefined, { force: true, model: "toolsearch-test" });
  assert(compacted.didCompact);
  assert(extractDiscoveredToolNames(compacted.messages).has("DeferredEcho"));
  const shaped = prepareToolSearchRequest({
    tools: pool,
    messages: compacted.messages,
    model: "claude-sonnet-4-5",
    env,
  });
  assert(shaped.tools.some((t) => t.name === "DeferredEcho"));
  console.log("✓ JSON round-trip, real compaction boundary and post-compact schema retention");

  const scoped = await toolSearchTool.call({ query: "select:DeferredEcho,TaskCreate" }, { cwd, availableTools: pool });
  assert.deepEqual(scoped.content, [{ type: "tool_reference", tool_name: "DeferredEcho" }]);
  const forbidden = await runTools(
    [{ type: "tool_use", id: "forbidden", name: "TaskCreate", input: {} }],
    { cwd },
    { availableTools: pool },
  );
  assert(forbidden.executions[0]!.result.isError);
  const freshChild = prepareToolSearchRequest({
    tools: pool,
    messages: [],
    model: "claude-sonnet-4-5",
    env,
    source: "subagent",
  });
  assert(!freshChild.tools.some((t) => t.name === "DeferredEcho"));
  requests.length = 0;
  await drive("small-alias");
  assert.deepEqual(
    requests[0]!.body.tools.map((t: any) => t.name),
    ["DeferredEcho"],
  );
  assert(!requests[0]!.headers.has("anthropic-beta"));
  console.log("✓ restricted tool pool, fresh child discovery and Haiku profile alias fallback");

  const mcp = await fetchToolsForConnection({
    name: "toolsearch-fixture",
    capabilities: { tools: {} },
    client: {
      request: async () => ({
        tools: [
          {
            name: "pinned",
            description: "Always visible",
            inputSchema: { type: "object" },
            _meta: { "anthropic/alwaysLoad": true, "anthropic/searchHint": "health check" },
          },
          {
            name: "deferred",
            inputSchema: { type: "object" },
            _meta: { "anthropic/alwaysLoad": "true", "anthropic/searchHint": 42 },
          },
        ],
      }),
    },
  } as unknown as ConnectedMcpServer);
  assert(mcp[0]!.isMcp && mcp[0]!.alwaysLoad && mcp[0]!.searchHint === "health check");
  assert(mcp[1]!.isMcp && !mcp[1]!.alwaysLoad && !mcp[1]!.searchHint);
  const pendingName = "toolsearch-pending-fixture";
  setMcpRegistryEntry(
    pendingName,
    { name: pendingName, type: "pending", startedAt: Date.now() } as PendingMcpServer,
    [],
  );
  try {
    const pending = prepareToolSearchRequest({
      tools: [toolSearchTool],
      messages: [],
      model: "claude-sonnet-4-5",
      env,
      hasPendingMcpServers: hasPendingMcpServers(),
    });
    assert(pending.enabled);
    const missing = await toolSearchTool.call({ query: "unknown" }, { cwd, availableTools: [toolSearchTool] });
    assert(typeof missing.content === "string" && missing.content.includes(pendingName));
  } finally {
    deleteMcpRegistryEntry(pendingName);
  }
  console.log("✓ MCP metadata validation and registry-backed pending-server hints");

  const mixed = [
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "hooked",
          content: [
            { type: "text", text: "Hook context" },
            { type: "tool_reference", tool_name: "DeferredEcho" },
          ],
        },
      ],
    },
  ] as unknown as MessageParam[];
  const normalized = normalizeToolReferencesForAPI(mixed, {
    toolSearchEnabled: true,
    availableToolNames: new Set(["DeferredEcho"]),
  });
  const blocks = normalized[0]!.content as any[];
  assert.deepEqual(blocks[0].content, [{ type: "tool_reference", tool_name: "DeferredEcho" }]);
  assert(blocks.some((b) => b.type === "text" && b.text === "Hook context"));
  assert.deepEqual(
    normalizeToolReferencesForAPI(normalized, {
      toolSearchEnabled: true,
      availableToolNames: new Set(["DeferredEcho"]),
    }),
    normalized,
  );
  assert.equal((mixed[0]!.content as any[])[0].content.length, 2);
  console.log("✓ hook siblings remain outside reference results; normalization is immutable and idempotent");

  for (const protocol of ["openai-chat", "openai-responses", "gemini"] as const) {
    const ready = prepareToolSearchRequest({
      tools: pool,
      messages: restored,
      model: "fixture-model",
      env: { protocol },
    });
    const request = prepareRequest(
      {
        id: "provider-test",
        protocol,
        model: "fixture-model",
        baseURL: "https://toolsearch.invalid",
        apiKey: "fixture",
      },
      { tools: ready.tools, messages: ready.messages, toolSearchEnabled: true },
    );
    const wire = JSON.stringify(request.body);
    assert(!wire.includes('"tool_reference"'));
    assert(!wire.includes("defer_loading"));
    assert(wire.includes("<functions>"));
    assert(wire.includes("available-deferred-tools"));
  }
  console.log("✓ final OpenAI Chat / Responses / Gemini request bodies retain schemas without beta shapes");

  for (const mode of ["false", "true"]) {
    process.env.EASY_AGENT_ENABLE_TOOL_SEARCH = mode;
    if (mode === "true") process.env.EASY_AGENT_DISABLE_EXPERIMENTAL_BETAS = "1";
    requests.length = 0;
    await drive("toolsearch-test", pool, restored);
    const wire = JSON.stringify(requests[0]!.body);
    assert(!wire.includes('"tool_reference"'));
    assert(!wire.includes("defer_loading"));
    assert(!requests[0]!.headers.has("anthropic-beta"));
    assert(!requests[0]!.body.tools.some((t: any) => t.name === "ToolSearch"));
  }
  assert.deepEqual(Object.keys(toolToApiParam(echo, { deferLoading: true })).sort(), [
    "description",
    "input_schema",
    "name",
  ]);
  console.log("✓ disable / kill switch strip stale references, schemas and headers at the HTTP boundary");
  console.log("All ToolSearch integration checks passed.");
} finally {
  globalThis.fetch = originalFetch;
  setFlagSettings(originalFlags);
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(cwd, { recursive: true, force: true });
}
