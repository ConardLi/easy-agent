/**
 * Scripted Anthropic Messages API for offline tests.
 *
 * Each request is answered with the next scripted step, streamed as SSE
 * (or as one JSON message when the request does not ask for a stream):
 * a text reply, a single tool call, or an API error. Requests are recorded so tests
 * can assert what reached the provider. `GET /v1/models` lists the fixture
 * model and consumes no step. `start()` points ANTHROPIC_BASE_URL
 * at the server; call it before importing modules that create API clients.
 *
 * `POST /v1/messages/count_tokens` consumes no step and is recorded apart, in
 * `countRequests`. It answers 404 like most compatible gateways until
 * `countTokens("on")`; from then on it counts with `fixtureTokens()`, and the
 * usage of every reply reports the same count of what the request carried.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type ScriptStep = (
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      name: string;
      input: Record<string, unknown>;
      /** Stream the input JSON in fragments of this many characters instead of one delta. */
      inputChunk?: number;
    }
  /** Reject the request with this HTTP status and an `invalid_request_error` carrying `message`. */
  | { kind: "error"; status: number; message: string }
) & {
  /** Hold the reply this long after the response starts, to leave room for a cancel. */
  delayMs?: number;
  /** Report this many of the input tokens as cache reads and writes. */
  cache?: { read?: number; write?: number };
};

type ReplyStep = Exclude<ScriptStep, { kind: "error" }>;

export interface RecordedRequest {
  messages: unknown[];
  system?: unknown;
  /** The whole parsed request body. */
  body: Record<string, unknown>;
  /** Bytes of the body as received. */
  bodyBytes: number;
  /** Request path, e.g. `/v1/messages`. */
  path: string;
  headers: Record<string, string | string[] | undefined>;
}

/** `off`: 404 like an endpoint without counting; `on`: count; `error`: fail with 500. */
export type CountTokensMode = "off" | "on" | "error";

export interface AnthropicFixture {
  readonly requests: RecordedRequest[];
  /** Requests to the token-counting endpoint, whatever the mode. */
  readonly countRequests: RecordedRequest[];
  /** `delayMs` holds each count reply, so a count can settle after its request. */
  countTokens(mode: CountTokensMode, options?: { delayMs?: number }): void;
  /** Replace the queue of upcoming replies. */
  script(steps: ScriptStep[]): void;
  /** Replies not consumed yet. */
  remaining(): number;
  start(): Promise<void>;
  close(): Promise<void>;
}

export const FIXTURE_MODEL = "fixture-model";

/** Tokens the fixture adds to every request, and to a request with tools, like a provider's framing. */
export const FIXTURE_REQUEST_TOKENS = 3;
export const FIXTURE_TOOL_TOKENS = 20;

const tokensOfJson = (value: unknown): number => Math.ceil(Buffer.byteLength(JSON.stringify(value)) / 4);

/**
 * The fixture's tokenizer: a quarter token per byte of JSON for the system
 * prompt, each tool, and each message, plus the framing above. The counting
 * endpoint and the usage of replies both use it.
 */
export function fixtureTokens(body: { system?: unknown; tools?: unknown[]; messages?: unknown[] }): {
  system: number;
  tools: number;
  messages: number;
  total: number;
} {
  const system = body.system === undefined ? 0 : tokensOfJson(body.system);
  const tools =
    body.tools && body.tools.length > 0
      ? FIXTURE_TOOL_TOKENS + body.tools.reduce<number>((sum, tool) => sum + tokensOfJson(tool), 0)
      : 0;
  const messages = FIXTURE_REQUEST_TOKENS + (body.messages ?? []).reduce<number>((sum, m) => sum + tokensOfJson(m), 0);
  return { system, tools, messages, total: system + tools + messages };
}

function sse(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function fragments(json: string, size: number | undefined): string[] {
  if (!size || size <= 0) return [json];
  const parts: string[] = [];
  for (let start = 0; start < json.length; start += size) parts.push(json.slice(start, start + size));
  return parts;
}

export function createAnthropicFixture(): AnthropicFixture {
  let queue: ScriptStep[] = [];
  let toolSeq = 0;
  let countMode: CountTokensMode = "off";
  let countDelayMs = 0;
  const requests: RecordedRequest[] = [];
  const countRequests: RecordedRequest[] = [];

  /** Input usage of a reply: a fixed 10 tokens, or the request's count while counting is on. */
  const inputUsage = (step: ReplyStep, body: Parameters<typeof fixtureTokens>[0]) => {
    const read = step.cache?.read ?? 0;
    const write = step.cache?.write ?? 0;
    const input = countMode === "on" ? Math.max(0, fixtureTokens(body).total - read - write) : 10;
    return {
      input_tokens: input,
      ...(step.cache?.read !== undefined ? { cache_read_input_tokens: read } : {}),
      ...(step.cache?.write !== undefined ? { cache_creation_input_tokens: write } : {}),
    };
  };

  const streamFor = (step: ReplyStep, seq: number, usage: ReturnType<typeof inputUsage>): string => {
    const body =
      step.kind === "text"
        ? [
            sse("content_block_start", {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            }),
            sse("content_block_delta", {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: step.text },
            }),
          ]
        : [
            sse("content_block_start", {
              type: "content_block_start",
              index: 0,
              content_block: { type: "tool_use", id: `toolu_${++toolSeq}`, name: step.name, input: {} },
            }),
            ...fragments(JSON.stringify(step.input), step.inputChunk).map((partial_json) =>
              sse("content_block_delta", {
                type: "content_block_delta",
                index: 0,
                delta: { type: "input_json_delta", partial_json },
              }),
            ),
          ];
    return [
      sse("message_start", {
        type: "message_start",
        message: {
          id: `msg_${seq}`,
          type: "message",
          role: "assistant",
          model: FIXTURE_MODEL,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { ...usage, output_tokens: 0 },
        },
      }),
      ...body,
      sse("content_block_stop", { type: "content_block_stop", index: 0 }),
      sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: step.kind === "text" ? "end_turn" : "tool_use", stop_sequence: null },
        usage: { output_tokens: 5 },
      }),
      sse("message_stop", { type: "message_stop" }),
    ].join("");
  };

  /** The reply to a non-streaming request, such as a compaction summary. */
  const messageFor = (step: ReplyStep, seq: number, usage: ReturnType<typeof inputUsage>) => ({
    id: `msg_${seq}`,
    type: "message",
    role: "assistant",
    model: FIXTURE_MODEL,
    content:
      step.kind === "text"
        ? [{ type: "text", text: step.text }]
        : [{ type: "tool_use", id: `toolu_${++toolSeq}`, name: step.name, input: step.input }],
    stop_reason: step.kind === "text" ? "end_turn" : "tool_use",
    stop_sequence: null,
    usage: { ...usage, output_tokens: 5 },
  });

  const server: Server = createServer((request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: [{ type: "model", id: FIXTURE_MODEL, display_name: "Fixture", created_at: "2026-01-01T00:00:00Z" }],
          has_more: false,
          first_id: FIXTURE_MODEL,
          last_id: FIXTURE_MODEL,
        }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      let body: Record<string, unknown> & { messages?: unknown[]; system?: unknown };
      const received = Buffer.concat(chunks);
      try {
        body = JSON.parse(received.toString("utf8"));
      } catch {
        // A body cut short (the client went away mid-request) is rejected like
        // the API would, without being recorded or using a scripted reply.
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad JSON" } }));
        return;
      }
      const recorded: RecordedRequest = {
        messages: body.messages ?? [],
        system: body.system,
        body,
        bodyBytes: received.length,
        path: request.url ?? "",
        headers: { ...request.headers },
      };
      if (request.url?.startsWith("/v1/messages/count_tokens")) {
        countRequests.push(recorded);
        const [status, reply] =
          countMode === "on"
            ? [200, { input_tokens: fixtureTokens(body as Parameters<typeof fixtureTokens>[0]).total }]
            : countMode === "error"
              ? [500, { type: "error", error: { type: "api_error", message: "count failed" } }]
              : [404, { type: "error", error: { type: "not_found_error", message: "Not found" } }];
        const send = () => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(reply));
        };
        if (countDelayMs > 0) setTimeout(send, countDelayMs).unref();
        else send();
        return;
      }
      requests.push(recorded);
      const step = queue.shift() ?? { kind: "text", text: "(fixture script exhausted)" };
      if (step.kind === "error") {
        response.writeHead(step.status, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: step.message } }),
        );
        return;
      }
      if (body.stream !== true) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(messageFor(step, requests.length, inputUsage(step, body))));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const stream = streamFor(step, requests.length, inputUsage(step, body));
      if (step.delayMs) setTimeout(() => response.end(stream), step.delayMs).unref();
      else response.end(stream);
    });
  });

  return {
    requests,
    countRequests,
    countTokens(mode, options) {
      countMode = mode;
      countDelayMs = options?.delayMs ?? 0;
    },
    script(steps) {
      queue = [...steps];
    },
    remaining: () => queue.length,
    async start() {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      process.env.ANTHROPIC_AUTH_TOKEN = "fixture-token";
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
