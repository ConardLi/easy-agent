/**
 * providerStream characterization (golden-master) test.
 *
 * Purpose: a behavior-locking safety net for the providerStream.ts refactor
 * (二期 A). It drives `streamViaProvider` / `collectViaProvider` — the only two
 * public entry points — across a matrix of provider protocols (OpenAI Chat /
 * OpenAI Responses / Gemini) and message shapes (text, multi-turn tool history,
 * images), with a mocked `fetch` that:
 *
 *   1. captures the translated request {url, headers, body} the module sends
 *      upstream (this is the conversion output that the refactor moves), and
 *   2. returns a canned provider SSE stream so the assembled StreamEvent
 *      sequence + StreamResult can be recorded (this covers the Gemini native
 *      parser/assembler and stop-reason normalization).
 *
 * The recording is normalized (volatile ids/keys stripped) and compared against
 * a committed golden. As long as the split preserves behavior, the recording
 * stays byte-identical and this test passes. No network / API key needed.
 *
 * Run:    npx tsx src/scripts/test-providerstream-characterization.ts
 * Update: npx tsx src/scripts/test-providerstream-characterization.ts --update
 */

import * as path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert";
import {
  streamViaProvider,
  collectViaProvider,
} from "../services/api/providers/providerStream.js";
import type { ModelProfile } from "../services/api/providers/profile.js";
import type { StreamRequestParams } from "../services/api/streaming.js";

const GOLDEN_PATH = path.join(
  import.meta.dirname,
  "__golden__",
  "providerstream-characterization.golden.txt",
);

// ─── Mock fetch ──────────────────────────────────────────────────────────────

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

let captured: CapturedRequest | null = null;
const realFetch = globalThis.fetch;

function encoder(): TextEncoder {
  return new TextEncoder();
}

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = encoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

function installFetch(chunks: string[]): void {
  globalThis.fetch = (async (url: string, init: { headers?: Record<string, string>; body?: string }) => {
    captured = {
      url: String(url),
      headers: init.headers ?? {},
      body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    };
    return new Response(sseStream(chunks), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

// ─── Normalization ───────────────────────────────────────────────────────────

function normalize(text: string): string {
  let out = text;
  // Provider-supplied / time-based ids that legitimately vary run-to-run.
  out = out.replace(/call_\d+_[a-z0-9]+/g, "<CALLID>");
  out = out.replace(/gemini-\d+/g, "<GEMINI_MSG_ID>");
  // Secret header values (Authorization / x-goog-api-key) → <KEY>.
  out = out.replace(/("authorization":\s*")Bearer [^"]*(")/g, "$1Bearer <KEY>$2");
  out = out.replace(/("x-goog-api-key":\s*")[^"]*(")/g, "$1<KEY>$2");
  return out;
}

// ─── Recording helpers ───────────────────────────────────────────────────────

function stableJson(value: unknown): string {
  // Deterministic key order so object field ordering never flips the golden.
  return JSON.stringify(value, replacerSortKeys(), 2);
}

function replacerSortKeys(): (key: string, value: unknown) => unknown {
  return (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  };
}

interface Scenario {
  name: string;
  profile: ModelProfile;
  params: StreamRequestParams;
  chunks: string[];
}

async function record(s: Scenario): Promise<string> {
  installFetch(s.chunks);
  captured = null;
  const lines: string[] = [`>>> ${s.name}`];
  try {
    const events: unknown[] = [];
    const gen = streamViaProvider(s.profile, s.params);
    let next = await gen.next();
    while (!next.done) {
      events.push(next.value);
      next = await gen.next();
    }
    const result = next.value;

    // `captured` is reassigned inside the fetch closure, which TS can't see —
    // cast to break the stale `null` narrowing from `captured = null` above.
    const cap = captured as CapturedRequest | null;
    lines.push("-- REQUEST --");
    lines.push(`url: ${cap?.url ?? "(none)"}`);
    lines.push(`headers: ${stableJson(cap?.headers ?? {})}`);
    lines.push(`body: ${stableJson(cap?.body ?? {})}`);
    lines.push("-- EVENTS --");
    for (const e of events) lines.push(JSON.stringify(e));
    lines.push("-- RESULT --");
    lines.push(stableJson(result));
  } catch (err) {
    lines.push(`THREW: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    restoreFetch();
  }
  return lines.join("\n");
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SYSTEM = "You are a test assistant.";
const TOOLS: StreamRequestParams["tools"] = [
  {
    name: "Read",
    description: "Read a file",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
] as never;

const TEXT_MSGS = [{ role: "user", content: "Say hello." }] as never;

const TOOL_HISTORY_MSGS = [
  { role: "user", content: "Read a.txt" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Reading it." },
      { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a.txt" }, thoughtSignature: "SIG_HIST" },
    ],
  },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file body" }] },
  { role: "user", content: "Thanks." },
] as never;

const IMAGE_MSGS = [
  {
    role: "user",
    content: [
      { type: "text", text: "What is in this image?" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJDRA==" } },
    ],
  },
] as never;

const oai = (protocol: ModelProfile["protocol"], id: string): ModelProfile => ({
  id,
  protocol,
  model: "model-test",
  baseURL: "https://api.openai.test/v1",
  apiKey: "test-key",
});
const gem: ModelProfile = {
  id: "gem",
  protocol: "gemini",
  model: "gemini-test",
  baseURL: "https://gemini.test/v1beta",
  apiKey: "test-key",
};

function params(messages: never, extra: Partial<StreamRequestParams> = {}): StreamRequestParams {
  return { messages, model: "model-test", maxTokens: 1024, ...extra } as StreamRequestParams;
}

// Canned provider SSE bodies.
const OAI_TEXT_STREAM = [
  `data: {"id":"cmpl-test","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n`,
  `data: {"id":"cmpl-test","choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n`,
  `data: {"id":"cmpl-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n`,
  `data: [DONE]\n\n`,
];
const OAI_LENGTH_STREAM = [
  `data: {"id":"cmpl-test","choices":[{"index":0,"delta":{"content":"Partial"}}]}\n\n`,
  `data: {"id":"cmpl-test","choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\n`,
  `data: [DONE]\n\n`,
];
const OAI_MINIMAL = [`data: [DONE]\n\n`];

const GEMINI_RICH_STREAM = [
  `data: {"responseId":"resp-test","candidates":[{"content":{"parts":[{"text":"pondering","thought":true},{"text":"Here you go"},{"functionCall":{"name":"Read","args":{"path":"a.txt"},"id":"call_fixed_1"},"thoughtSignature":"SIG123"}]}}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4}}\n\n`,
  `data: {"candidates":[{"finishReason":"STOP"}]}\n\n`,
];
const GEMINI_MAXTOK_STREAM = [
  `data: {"responseId":"resp-test","candidates":[{"content":{"parts":[{"text":"truncated"}]},"finishReason":"MAX_TOKENS"}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":9}}\n\n`,
];
const GEMINI_MINIMAL = [
  `data: {"responseId":"resp-test","candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n`,
];

// ─── Build the recording ─────────────────────────────────────────────────────

async function buildRecording(): Promise<string> {
  const blocks: string[] = [];
  const push = (title: string, body: string): void => {
    blocks.push(`### ${title}\n${body}`);
  };

  // OpenAI Chat ---------------------------------------------------------------
  push("openai-chat / text + stream", await record({
    name: "openai-chat text",
    profile: oai("openai-chat", "oai"),
    params: params(TEXT_MSGS, { system: SYSTEM }),
    chunks: OAI_TEXT_STREAM,
  }));
  push("openai-chat / finish=length → max_tokens", await record({
    name: "openai-chat length",
    profile: oai("openai-chat", "oai"),
    params: params(TEXT_MSGS),
    chunks: OAI_LENGTH_STREAM,
  }));
  push("openai-chat / tool history → messages[]", await record({
    name: "openai-chat tool history",
    profile: oai("openai-chat", "oai"),
    params: params(TOOL_HISTORY_MSGS, { system: SYSTEM, tools: TOOLS }),
    chunks: OAI_MINIMAL,
  }));
  push("openai-chat / image → image_url", await record({
    name: "openai-chat image",
    profile: oai("openai-chat", "oai"),
    params: params(IMAGE_MSGS),
    chunks: OAI_MINIMAL,
  }));

  // OpenAI Responses ----------------------------------------------------------
  push("openai-responses / tool history → input[]", await record({
    name: "openai-responses tool history",
    profile: oai("openai-responses", "oair"),
    params: params(TOOL_HISTORY_MSGS, { system: SYSTEM, tools: TOOLS }),
    chunks: OAI_MINIMAL,
  }));
  push("openai-responses / image → input_image", await record({
    name: "openai-responses image",
    profile: oai("openai-responses", "oair"),
    params: params(IMAGE_MSGS),
    chunks: OAI_MINIMAL,
  }));

  // Gemini --------------------------------------------------------------------
  push("gemini / tool history → contents[]", await record({
    name: "gemini tool history",
    profile: gem,
    params: params(TOOL_HISTORY_MSGS, { system: SYSTEM, tools: TOOLS }),
    chunks: GEMINI_MINIMAL,
  }));
  push("gemini / image → inlineData", await record({
    name: "gemini image",
    profile: gem,
    params: params(IMAGE_MSGS),
    chunks: GEMINI_MINIMAL,
  }));
  push("gemini / rich stream (thinking + text + tool_use)", await record({
    name: "gemini rich stream",
    profile: gem,
    params: params(TEXT_MSGS, { system: SYSTEM }),
    chunks: GEMINI_RICH_STREAM,
  }));
  push("gemini / finish=MAX_TOKENS → max_tokens", await record({
    name: "gemini maxtokens",
    profile: gem,
    params: params(TEXT_MSGS),
    chunks: GEMINI_MAXTOK_STREAM,
  }));

  // collectViaProvider --------------------------------------------------------
  {
    installFetch(GEMINI_MINIMAL);
    captured = null;
    const collected = await collectViaProvider(gem, params(TEXT_MSGS));
    restoreFetch();
    push("collectViaProvider / gemini", `>>> collect gemini\n${stableJson(collected)}`);
  }

  return normalize(blocks.join("\n\n"));
}

async function main(): Promise<void> {
  const update = process.argv.includes("--update");
  const recording = await buildRecording();

  await mkdir(path.dirname(GOLDEN_PATH), { recursive: true });

  if (update) {
    await writeFile(GOLDEN_PATH, recording, "utf8");
    process.stdout.write(`\u001b[33m[updated]\u001b[0m golden written to ${GOLDEN_PATH}\n`);
    return;
  }

  let golden: string;
  try {
    golden = await readFile(GOLDEN_PATH, "utf8");
  } catch {
    process.stderr.write(
      `\u001b[31m[error]\u001b[0m no golden file at ${GOLDEN_PATH}.\n` +
        `Run once with --update to generate the baseline (from KNOWN-GOOD code).\n`,
    );
    process.exit(1);
    return;
  }

  if (recording === golden) {
    const groups = (recording.match(/^### /gm) ?? []).length;
    process.stdout.write(
      `\u001b[32m[pass]\u001b[0m providerStream characterization matches golden ` +
        `(${groups} scenarios, ${recording.split("\n").length} lines).\n`,
    );
    return;
  }

  const a = recording.split("\n");
  const b = golden.split("\n");
  const max = Math.max(a.length, b.length);
  let firstDiff = -1;
  for (let i = 0; i < max; i++) {
    if (a[i] !== b[i]) {
      firstDiff = i;
      break;
    }
  }
  process.stderr.write(`\u001b[31m[fail]\u001b[0m recording diverged from golden.\n`);
  if (firstDiff >= 0) {
    const ctxStart = Math.max(0, firstDiff - 3);
    process.stderr.write(`First difference at line ${firstDiff + 1}:\n`);
    for (let i = ctxStart; i <= firstDiff; i++) {
      process.stderr.write(`  golden ${i + 1}: ${JSON.stringify(b[i])}\n`);
      process.stderr.write(`  actual ${i + 1}: ${JSON.stringify(a[i])}\n`);
    }
  }
  process.stderr.write(
    `\nIf this change is INTENTIONAL, re-run with --update. Otherwise it's a regression.\n`,
  );
  assert.strictEqual(recording, golden, "providerStream characterization mismatch");
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
