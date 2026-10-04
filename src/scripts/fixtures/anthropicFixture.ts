/**
 * Scripted Anthropic Messages API for offline tests.
 *
 * Each request is answered with the next scripted step, streamed as SSE:
 * either a text reply or a single tool call. Requests are recorded so tests
 * can assert what reached the provider. `start()` points ANTHROPIC_BASE_URL
 * at the server; call it before importing modules that create API clients.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type ScriptStep = (
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: Record<string, unknown> }
) & {
  /** Hold the reply this long after the response starts, to leave room for a cancel. */
  delayMs?: number;
};

export interface RecordedRequest {
  messages: unknown[];
  system?: unknown;
}

export interface AnthropicFixture {
  readonly requests: RecordedRequest[];
  /** Replace the queue of upcoming replies. */
  script(steps: ScriptStep[]): void;
  /** Replies not consumed yet. */
  remaining(): number;
  start(): Promise<void>;
  close(): Promise<void>;
}

export const FIXTURE_MODEL = "fixture-model";

function sse(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createAnthropicFixture(): AnthropicFixture {
  let queue: ScriptStep[] = [];
  let toolSeq = 0;
  const requests: RecordedRequest[] = [];

  const streamFor = (step: ScriptStep, seq: number): string => {
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
            sse("content_block_delta", {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(step.input) },
            }),
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
          usage: { input_tokens: 10, output_tokens: 0 },
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

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: unknown[]; system?: unknown };
      requests.push({ messages: body.messages ?? [], system: body.system });
      const step = queue.shift() ?? { kind: "text", text: "(fixture script exhausted)" };
      response.writeHead(200, { "content-type": "text/event-stream" });
      const stream = streamFor(step, requests.length);
      if (step.delayMs) setTimeout(() => response.end(stream), step.delayMs).unref();
      else response.end(stream);
    });
  });

  return {
    requests,
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
