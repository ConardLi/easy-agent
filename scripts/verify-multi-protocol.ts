/**
 * Stage 30 verification — multi-protocol support (no real API keys needed).
 *
 * Exercises the three load-bearing pieces in isolation:
 *   1. Profile resolution: ${ENV} interpolation, defaultModel, and the
 *      project/local inline-apiKey security guard.
 *   2. Request translation: Anthropic (tools + system) → OpenAI / Gemini via
 *      llm-bridge produces a well-formed provider request.
 *   3. Stream mapping: a mocked OpenAI / Gemini SSE response is parsed and
 *      assembled into our StreamEvent sequence + AssistantMessage, including
 *      tool-call argument assembly and stopReason === "tool_use" forcing.
 *
 * Run: npx tsx scripts/verify-multi-protocol.ts
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

let pass = 0;
let fail = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.error(`  ✗ ${label}`);
  }
}
function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

/** Build a web ReadableStream emitting the given SSE text chunks. */
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function main(): Promise<void> {
  // ── [1] Profile resolution ───────────────────────────────────────────────
  section("[1] Profile resolution (env interpolation, defaultModel, secret guard)");

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ea-mp-"));
  const projDir = path.join(tmp, "proj");
  await fs.mkdir(path.join(projDir, ".easy-agent"), { recursive: true });

  process.env.MP_TEST_KEY = "sk-from-env-123";

  // Project-scope settings: one good profile using ${ENV}, one with an inline
  // literal apiKey (must be stripped because project scope is untrusted).
  await fs.writeFile(
    path.join(projDir, ".easy-agent", "settings.json"),
    JSON.stringify(
      {
        defaultModel: "gpt5",
        models: {
          gpt5: {
            protocol: "openai-chat",
            model: "gpt-5.1",
            baseURL: "https://api.openai.com/v1",
            apiKey: "${MP_TEST_KEY}",
          },
          leaky: {
            protocol: "gemini",
            model: "gemini-2.5-pro",
            apiKey: "sk-inline-should-be-ignored",
          },
        },
      },
      null,
      2,
    ),
  );

  const { loadProfiles, resolveProfile } = await import("../src/services/api/providers/profile.js");

  const loaded = await loadProfiles(projDir);
  assert(loaded.defaultModel === "gpt5", "defaultModel read from project settings");
  assert(loaded.profiles.gpt5?.apiKey === "sk-from-env-123", "${ENV} apiKey interpolated");
  assert(loaded.profiles.gpt5?.protocol === "openai-chat", "protocol parsed");
  assert(
    loaded.profiles.leaky?.apiKey === undefined,
    "inline literal apiKey from project scope is stripped",
  );
  assert(
    loaded.warnings.some((w) => w.includes("leaky") && w.includes("apiKey")),
    "warning emitted for stripped inline secret",
  );

  const synthetic = await resolveProfile("claude-sonnet-4-20250514", projDir);
  assert(
    synthetic.protocol === "anthropic" && synthetic.model === "claude-sonnet-4-20250514",
    "unknown handle → synthetic anthropic profile (backwards compatible)",
  );

  // ── [2] Request translation (Anthropic → OpenAI / Gemini) ─────────────────
  section("[2] Request translation via llm-bridge");

  const { toUniversal, fromUniversal } = await import("llm-bridge");
  const anthropicReq = {
    model: "gpt-5.1",
    max_tokens: 1024,
    system: "You are a helpful assistant.",
    messages: [{ role: "user", content: "What is the weather in SF?" }],
    tools: [
      {
        name: "get_weather",
        description: "Get weather",
        input_schema: {
          type: "object",
          properties: { location: { type: "string" } },
          required: ["location"],
        },
      },
    ],
  };
  const universal = toUniversal("anthropic", anthropicReq as never);
  const openaiBody = fromUniversal("openai", universal) as Record<string, unknown>;
  const geminiBody = fromUniversal("google", universal) as Record<string, unknown>;

  assert(Array.isArray(openaiBody.messages), "OpenAI body has messages[]");
  assert(Array.isArray(openaiBody.tools), "OpenAI body has tools[]");
  assert(
    JSON.stringify(openaiBody).includes("get_weather"),
    "OpenAI body preserves the tool name",
  );
  assert(
    Array.isArray((geminiBody as { contents?: unknown }).contents),
    "Gemini body has contents[]",
  );
  assert(
    JSON.stringify(geminiBody).includes("get_weather"),
    "Gemini body preserves the function declaration",
  );

  // ── [3] Stream mapping (mocked OpenAI SSE → StreamEvent) ───────────────────
  section("[3] Stream mapping: mocked OpenAI tool-call stream");

  const openaiChunks = [
    `data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":"Let me check."}}]}\n\n`,
    `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}\n\n`,
    `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"location\\":"}}]}}]}\n\n`,
    `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"SF\\"}"}}]}}]}\n\n`,
    `data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":7,"total_tokens":19}}\n\n`,
    `data: [DONE]\n\n`,
  ];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(sseStream(openaiChunks), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;

  const { streamViaProvider } = await import("../src/services/api/providers/providerStream.js");

  try {
    const events: string[] = [];
    let toolName = "";
    let assembledInput = "";
    const gen = streamViaProvider(
      { id: "gpt5", protocol: "openai-chat", model: "gpt-5.1", apiKey: "x" },
      {
        messages: [{ role: "user", content: "weather?" }],
        model: "gpt5",
        tools: [
          {
            name: "get_weather",
            description: "Get weather",
            input_schema: { type: "object", properties: { location: { type: "string" } } },
          },
        ],
      } as never,
    );
    let next = await gen.next();
    while (!next.done) {
      const ev = next.value;
      events.push(ev.type);
      if (ev.type === "tool_use_start") toolName = ev.name;
      if (ev.type === "tool_use_input") assembledInput += ev.partial_json;
      next = await gen.next();
    }
    const result = next.value;

    assert(events.includes("text"), "emits text events");
    assert(events.includes("tool_use_start"), "emits tool_use_start");
    assert(events.includes("tool_use_input"), "emits tool_use_input");
    assert(events.includes("message_done"), "emits message_done");
    assert(toolName === "get_weather", "tool name surfaced");
    assert(assembledInput === '{"location":"SF"}', "tool input JSON streamed correctly");

    const toolBlock = result.assistantMessage.content.find((b) => b.type === "tool_use");
    assert(!!toolBlock, "assembled message contains a tool_use block");
    assert(
      toolBlock?.type === "tool_use" &&
        JSON.stringify(toolBlock.input) === '{"location":"SF"}',
      "assembled tool_use.input parsed from streamed args",
    );
    assert(
      result.stopReason === "tool_use",
      "stopReason forced to 'tool_use' so the agentic loop executes tools",
    );
    assert(result.usage.input_tokens === 12 && result.usage.output_tokens === 7, "usage mapped");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // ── [4] HTTP error → retryable APIError ───────────────────────────────────
  section("[4] Provider HTTP error maps to a classifiable APIError");

  const { classifyAPIError, isRetryableError } = await import("../src/services/api/errors.js");
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: "rate limited" } }), {
      status: 429,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    const { streamViaProvider } = await import("../src/services/api/providers/providerStream.js");
    const gen = streamViaProvider(
      { id: "gpt5", protocol: "openai-chat", model: "gpt-5.1", apiKey: "x" },
      { messages: [{ role: "user", content: "hi" }], model: "gpt5" } as never,
    );
    let threw: unknown;
    try {
      await gen.next();
    } catch (e) {
      threw = e;
    }
    assert(threw !== undefined, "non-2xx response throws");
    assert(classifyAPIError(threw) === "rate_limit", "429 classified as rate_limit");
    assert(isRetryableError(threw) === true, "429 is retryable (reuses Anthropic SDK APIError)");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // ── [5] 200-but-not-a-stream guard (misrouted baseURL) ────────────────────
  section("[5] Non-stream 200 (e.g. baseURL missing /v1) fails loudly, not silently");

  globalThis.fetch = (async () =>
    new Response("<!doctype html><html><body>gateway homepage</body></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    })) as typeof fetch;
  try {
    const { streamViaProvider } = await import("../src/services/api/providers/providerStream.js");
    const { classifyAPIError, isRetryableError } = await import("../src/services/api/errors.js");
    const gen = streamViaProvider(
      { id: "gpt5", protocol: "openai-chat", model: "gpt-5.1", apiKey: "x" },
      { messages: [{ role: "user", content: "hi" }], model: "gpt5" } as never,
    );
    let threw: unknown;
    const emitted: string[] = [];
    try {
      let next = await gen.next();
      while (!next.done) {
        emitted.push(next.value.type);
        next = await gen.next();
      }
    } catch (e) {
      threw = e;
    }
    assert(threw !== undefined, "non-stream 200 throws instead of yielding empty output");
    assert(emitted.length === 0, "no content events leaked before the error");
    assert(
      threw instanceof Error && /baseURL/.test(threw.message),
      "error message hints at the baseURL misconfiguration",
    );
    assert(
      classifyAPIError(threw) === "invalid_request" && isRetryableError(threw) === false,
      "deterministic (not retried) so the user sees it once",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  // ── [6] Multi-turn tool history → correct provider request shape ──────────
  section("[6] Tool round-trip translation (the real failure: 2nd turn after a tool call)");

  const { streamViaProvider: svp } = await import("../src/services/api/providers/providerStream.js");

  const toolHistory = [
    { role: "user", content: "weather in SF?" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "call_1", name: "get_weather", input: { location: "SF" }, thoughtSignature: "SIG123" },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "Sunny" }] },
  ];
  const toolDefs = [
    { name: "get_weather", description: "w", input_schema: { type: "object", properties: { location: { type: "string" } } } },
  ];

  /** Mock fetch: record the outgoing request body, reply with a tiny valid stream. */
  function captureFetch(streamChunk: string): { body: () => Record<string, unknown> } {
    let captured: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      captured = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(sseStream([streamChunk]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    return { body: () => captured };
  }

  async function drain(profile: Record<string, unknown>): Promise<void> {
    const gen = svp(profile as never, { messages: toolHistory, model: String(profile.id), tools: toolDefs } as never);
    let n = await gen.next();
    while (!n.done) n = await gen.next();
  }

  try {
    // openai-chat: tool_result must become a role:"tool" message with tool_call_id;
    // the assistant must carry tool_calls; NO leaked "_original" junk text.
    let cap = captureFetch(`data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n` + `data: [DONE]\n\n`);
    await drain({ id: "gpt5", protocol: "openai-chat", model: "gpt-5.1", apiKey: "x" });
    const chatMsgs = cap.body().messages as Array<Record<string, unknown>>;
    assert(
      chatMsgs.some((m) => m.role === "tool" && m.tool_call_id === "call_1"),
      "openai-chat: tool_result → role:'tool' with tool_call_id",
    );
    assert(
      chatMsgs.some((m) => m.role === "assistant" && Array.isArray(m.tool_calls)),
      "openai-chat: assistant carries tool_calls",
    );
    assert(!JSON.stringify(chatMsgs).includes("_original"), "openai-chat: no leaked llm-bridge junk text");

    // openai-responses: needs a function_call item AND a function_call_output,
    // both keyed by the same call_id.
    cap = captureFetch(`data: [DONE]\n\n`);
    await drain({ id: "gpt5r", protocol: "openai-responses", model: "gpt-5.1", apiKey: "x" });
    const respInput = cap.body().input as Array<Record<string, unknown>>;
    assert(
      respInput.some((i) => i.type === "function_call" && i.call_id === "call_1"),
      "openai-responses: emits function_call with call_id",
    );
    assert(
      respInput.some((i) => i.type === "function_call_output" && i.call_id === "call_1"),
      "openai-responses: emits function_call_output with matching call_id",
    );

    // gemini: the model functionCall part must carry the replayed thoughtSignature.
    cap = captureFetch(`data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}\n\n`);
    await drain({ id: "gemini", protocol: "gemini", model: "gemini-3.5-flash", apiKey: "x" });
    const contents = cap.body().contents as Array<Record<string, unknown>>;
    const modelParts = contents
      .filter((c) => c.role === "model")
      .flatMap((c) => (c.parts as Array<Record<string, unknown>>) ?? []);
    const fcPart = modelParts.find((p) => p.functionCall);
    assert(!!fcPart, "gemini: history retains the functionCall part");
    assert(fcPart?.thoughtSignature === "SIG123", "gemini: thoughtSignature replayed onto functionCall");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // gemini: capture thoughtSignature off the wire into the tool_use block.
  section("[7] Gemini captures thoughtSignature from the stream");
  try {
    globalThis.fetch = (async () =>
      new Response(
        sseStream([
          `data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"location":"SF"},"id":"g1"},"thoughtSignature":"ZZZ999"}]}}],"responseId":"r1"}\n\n`,
          `data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}\n\n`,
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )) as typeof fetch;
    const gen = svp(
      { id: "gemini", protocol: "gemini", model: "gemini-3.5-flash", apiKey: "x" } as never,
      { messages: [{ role: "user", content: "weather?" }], model: "gemini", tools: toolDefs } as never,
    );
    let n = await gen.next();
    while (!n.done) n = await gen.next();
    const result = n.value;
    const tu = result.assistantMessage.content.find((b) => b.type === "tool_use");
    assert(!!tu, "gemini: tool_use assembled from stream");
    assert(
      tu?.type === "tool_use" && (tu as { thoughtSignature?: string }).thoughtSignature === "ZZZ999",
      "gemini: thoughtSignature captured onto tool_use block",
    );
    assert(result.stopReason === "tool_use", "gemini: stopReason forced to tool_use");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // ── [8] Gemini thoughtSignature error → flatten-and-retry self-heal ───────
  section("[8] Gemini recovers from upstream thoughtSignature corruption");
  try {
    const sentBodies: Array<Record<string, unknown>> = [];
    let call = 0;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      sentBodies.push(JSON.parse(init.body) as Record<string, unknown>);
      call++;
      if (call === 1) {
        // Upstream rejects the signature (returned as 429 by this gateway).
        return new Response(JSON.stringify({ error: { message: "Corrupted thought signature.", code: "400" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      // Retry (flattened) succeeds.
      return new Response(
        sseStream([
          `data: {"candidates":[{"content":{"parts":[{"text":"recovered"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2}}\n\n`,
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;

    const history = [
      { role: "user", content: "weather?" },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "get_weather", input: { location: "SF" }, thoughtSignature: "AY89bad" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "Sunny" }] },
    ];
    const gen = svp(
      { id: "gemini", protocol: "gemini", model: "gemini-3.5-flash", apiKey: "x" } as never,
      { messages: history, model: "gemini", tools: toolDefs } as never,
    );
    let text = "";
    let n = await gen.next();
    while (!n.done) {
      if (n.value.type === "text") text += n.value.text;
      n = await gen.next();
    }
    assert(call === 2, "gemini: retried exactly once after signature rejection");
    assert(text === "recovered", "gemini: recovered turn streams normally");

    // First attempt sent the real functionCall; the retry flattened it to text.
    const firstContents = sentBodies[0].contents as Array<Record<string, unknown>>;
    const retryContents = sentBodies[1].contents as Array<Record<string, unknown>>;
    const firstHasFc = firstContents.some((c) => (c.parts as Array<Record<string, unknown>>).some((p) => p.functionCall));
    const retryHasFc = retryContents.some((c) => (c.parts as Array<Record<string, unknown>>).some((p) => p.functionCall));
    assert(firstHasFc, "gemini: first attempt used structured functionCall");
    assert(!retryHasFc, "gemini: retry flattened tool history to text (no functionCall → no signature)");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Unrelated gemini errors must still surface (not be swallowed by recovery).
  section("[9] Gemini non-signature errors still surface");
  try {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "quota exceeded" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const gen = svp(
      { id: "gemini", protocol: "gemini", model: "gemini-3.5-flash", apiKey: "x" } as never,
      { messages: [{ role: "user", content: "hi" }], model: "gemini", tools: toolDefs } as never,
    );
    let threw = false;
    try {
      let n = await gen.next();
      while (!n.done) n = await gen.next();
    } catch {
      threw = true;
    }
    assert(threw, "gemini: a real 429 (non-signature) still throws for the retry loop");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // ── [10] Reasoning params on the wire (/effort + /think) ──────────────────
  section("[10] /effort + /think reach the provider request body (Stage 34)");
  {
    const { setSessionEffortLevel, setSessionThinkingConfig } = await import(
      "../src/utils/thinking.js"
    );
    const { streamViaProvider: svp2 } = await import(
      "../src/services/api/providers/providerStream.js"
    );

    let capturedBody: Record<string, unknown> = {};
    function capture(chunk: string): void {
      globalThis.fetch = (async (_url: string, init: { body: string }) => {
        capturedBody = JSON.parse(init.body) as Record<string, unknown>;
        return new Response(sseStream([chunk]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as typeof fetch;
    }
    const chatDone =
      `data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n` + `data: [DONE]\n\n`;
    const respDone = `data: [DONE]\n\n`;
    const gemDone = `data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}\n\n`;
    async function run(profile: Record<string, unknown>, chunk: string): Promise<void> {
      capture(chunk);
      const gen = svp2(profile as never, {
        messages: [{ role: "user", content: "hi" }],
        model: String(profile.id),
      } as never);
      let n = await gen.next();
      while (!n.done) n = await gen.next();
    }
    const chat = { id: "gpt5", protocol: "openai-chat", model: "gpt-5.5", apiKey: "x" };
    const resp = { id: "gpt5r", protocol: "openai-responses", model: "gpt-5.5", apiKey: "x" };
    const gem = { id: "gemini", protocol: "gemini", model: "gemini-3.5-flash", apiKey: "x" };

    try {
      // Default (no /effort, thinking on) → server decides; no explicit param.
      setSessionEffortLevel(undefined);
      setSessionThinkingConfig(undefined);
      await run(chat, chatDone);
      assert(capturedBody.reasoning_effort === undefined, "openai-chat: default sends no reasoning_effort");

      // /effort high → reasoning_effort: "high".
      setSessionEffortLevel("high");
      await run(chat, chatDone);
      assert(capturedBody.reasoning_effort === "high", "openai-chat: /effort high → reasoning_effort:high");

      // /effort max → clamps to OpenAI "xhigh".
      setSessionEffortLevel("max");
      await run(chat, chatDone);
      assert(capturedBody.reasoning_effort === "xhigh", "openai-chat: /effort max → reasoning_effort:xhigh");

      // openai-responses uses the nested reasoning.effort field.
      setSessionEffortLevel("medium");
      await run(resp, respDone);
      assert(
        (capturedBody.reasoning as { effort?: string } | undefined)?.effort === "medium",
        "openai-responses: /effort medium → reasoning.effort:medium",
      );

      // /think off → OpenAI "minimal" (lowest, observable toggle).
      setSessionEffortLevel(undefined);
      setSessionThinkingConfig({ type: "disabled" });
      await run(chat, chatDone);
      assert(capturedBody.reasoning_effort === "minimal", "openai-chat: /think off → reasoning_effort:minimal");

      // Gemini /effort high → thinkingLevel (NOT the deprecated thinkingBudget).
      setSessionEffortLevel("high");
      setSessionThinkingConfig(undefined);
      await run(gem, gemDone);
      const gcfg = (capturedBody.generationConfig as { thinkingConfig?: Record<string, unknown> } | undefined)
        ?.thinkingConfig;
      assert(gcfg?.thinkingLevel === "high", "gemini: /effort high → thinkingConfig.thinkingLevel:high");
      assert(gcfg?.thinkingBudget === undefined, "gemini: thinkingLevel not mixed with thinkingBudget (avoids 400)");

      // Gemini /think off → no thinkingConfig at all.
      setSessionEffortLevel(undefined);
      setSessionThinkingConfig({ type: "disabled" });
      await run(gem, gemDone);
      assert(
        (capturedBody.generationConfig as { thinkingConfig?: unknown } | undefined)?.thinkingConfig ===
          undefined,
        "gemini: /think off → no thinkingConfig",
      );
    } finally {
      setSessionEffortLevel(undefined);
      setSessionThinkingConfig(undefined);
      globalThis.fetch = originalFetch;
    }
  }

  // ── [11] Anthropic custom-endpoint client (baseURL /v1 + keyless) ─────────
  section("[11] Anthropic baseURL normalization + keyless custom endpoint");
  {
    const {
      CUSTOM_ENDPOINT_USER_AGENT,
      getAnthropicClientForProfile,
      normalizeAnthropicBaseURL,
      resetClient,
    } = await import("../src/services/api/client.js");
    assert(
      normalizeAnthropicBaseURL("https://token.mmh1.top/v1") === "https://token.mmh1.top",
      "strips a trailing /v1 (SDK re-adds /v1/messages → no double /v1)",
    );
    assert(
      normalizeAnthropicBaseURL("https://api.minimaxi.com/anthropic") === "https://api.minimaxi.com/anthropic",
      "leaves a non-/v1 baseURL untouched (MiniMax stays correct)",
    );
    assert(
      normalizeAnthropicBaseURL("https://host/v1/") === "https://host",
      "strips trailing slash then /v1",
    );

    // The Anthropic SDK adds `User-Agent: Anthropic/JS <version>`. Some
    // compatible gateways block that SDK fingerprint while accepting the same
    // endpoint/model/key with a neutral caller identity. Verify custom
    // endpoints use Easy Agent's identity and still honor per-profile headers.
    let capturedHeaders = new Headers();
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedHeaders = new Headers(init.headers);
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      resetClient();
      const client = getAnthropicClientForProfile({
        baseURL: "https://gateway.test/v1",
        apiKey: "test-key",
        headers: { "x-profile-header": "present" },
      });
      await client.messages.create({
        model: "claude-test",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      });
      assert(
        capturedHeaders.get("user-agent") === CUSTOM_ENDPOINT_USER_AGENT,
        "custom Anthropic endpoint uses Easy Agent user-agent (avoids SDK-fingerprint WAF blocks)",
      );
      assert(
        capturedHeaders.get("x-profile-header") === "present",
        "Anthropic profile headers reach the SDK request",
      );

      const overridden = getAnthropicClientForProfile({
        baseURL: "https://gateway.test/v1",
        apiKey: "test-key",
        headers: { "User-Agent": "gateway-required-agent" },
      });
      assert(
        overridden !== client,
        "Anthropic client cache separates profiles with different headers",
      );
      await overridden.messages.create({
        model: "claude-test",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      });
      assert(
        capturedHeaders.get("user-agent") === "gateway-required-agent",
        "profile user-agent overrides the Easy Agent custom-endpoint default",
      );
    } finally {
      resetClient();
      globalThis.fetch = originalFetch;
    }
  }

  // Stage 34 capability checks must be forward-compatible with newer model
  // minors instead of treating every post-4.6 Opus/Sonnet as legacy.
  section("[12] Claude 4.7 adaptive-thinking / effort capability detection");
  {
    const { modelSupportsAdaptiveThinking, modelSupportsEffort } = await import(
      "../src/utils/thinking.js"
    );
    assert(modelSupportsAdaptiveThinking("claude-opus-4-7"), "Opus 4.7 supports adaptive thinking");
    assert(modelSupportsEffort("claude-opus-4-7"), "Opus 4.7 supports effort");
    assert(modelSupportsAdaptiveThinking("claude-sonnet-4-7"), "Sonnet 4.7 supports adaptive thinking");
    assert(!modelSupportsAdaptiveThinking("claude-opus-4-5"), "Opus 4.5 remains on budget thinking");
  }

  await fs.rm(tmp, { recursive: true, force: true });

  console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
