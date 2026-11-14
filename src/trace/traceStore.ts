/**
 * The request record file of a session: `<sessionId>.trace.ndjson`, next to
 * its transcript, one JSON object per line.
 *
 * - `trace_meta`: first line of a new file (format version and session id).
 * - `segments`: the segments of a system prompt or tool list, once per
 *   `part` and `hash`. Requests name the hash; system prompts and tool
 *   schemas rarely change, so each layout is written once.
 * - `request`: one finished request (see `RequestRecord`). Its `messages`
 *   lists only the segments that differ from the previous request of the
 *   same chain (the main loop, or one sub-agent): `reused` names that
 *   request and how many leading messages are the same.
 * - `token_count`: the provider's count of a request (see
 *   `RequestTokenCount`) that settled after the request line was written.
 *   A request counted in time carries it as `tokenCount` instead.
 *
 * Writes are queued per file and never awaited by a request. The file name
 * does not end in `.jsonl`, so versions that read every `*.jsonl` in the
 * directory as a transcript leave it alone.
 */

import * as fs from "node:fs/promises";
import { getTracePath, isSessionPersistenceEnabled } from "../session/storage.js";
import { appendPrivateFile } from "../utils/privateData.js";
import { debugLog } from "../utils/log.js";
import type { MessageTraceSegment, RequestRecord, RequestTokenCount } from "./requestTrace.js";

export const TRACE_FORMAT_VERSION = 1;
const MAX_CHAINS = 64;

interface FileState {
  checked: boolean;
  written: Set<string>;
  chains: Map<string, { requestId: string; hashes: string[] }>;
}

const files = new Map<string, FileState>();
const queues = new Map<string, Promise<void>>();

function chainOf(record: RequestRecord): string {
  return record.agent ? `${record.purpose}:${record.agent.id}` : record.purpose;
}

function linesFor(state: FileState, record: RequestRecord, sessionId: string): string[] {
  const lines: string[] = [];
  if (!state.checked) {
    state.checked = true;
    lines.push(JSON.stringify({ type: "trace_meta", version: TRACE_FORMAT_VERSION, sessionId }));
  }
  const { system, tools, messages, ...rest } = record;
  for (const [part, value] of [
    ["system", system],
    ["tools", tools],
  ] as const) {
    const key = `${part}:${value.hash}`;
    if (!value.hash || state.written.has(key)) continue;
    state.written.add(key);
    lines.push(JSON.stringify({ type: "segments", part, hash: value.hash, segments: value.segments }));
  }

  const chain = chainOf(record);
  const hashes = messages.segments.map((segment) => segment.hash);
  const previous = state.chains.get(chain);
  let reused = 0;
  if (previous) {
    while (reused < hashes.length && reused < previous.hashes.length && hashes[reused] === previous.hashes[reused]) {
      reused++;
    }
  }
  state.chains.delete(chain);
  state.chains.set(chain, { requestId: record.requestId, hashes });
  if (state.chains.size > MAX_CHAINS) state.chains.delete(state.chains.keys().next().value!);

  const { segments: _systemSegments, ...systemSummary } = system;
  const { segments: _toolSegments, ...toolsSummary } = tools;
  const newSegments: MessageTraceSegment[] = messages.segments.slice(reused);
  lines.push(
    JSON.stringify({
      type: "request",
      ...rest,
      system: systemSummary,
      tools: toolsSummary,
      messages: {
        ...messages,
        ...(reused > 0 && previous ? { reused: { requestId: previous.requestId, count: reused } } : {}),
        segments: newSegments,
      },
    }),
  );
  return lines;
}

/** Queue `record` for the session's file. Does nothing while persistence is off. */
export function appendRequestRecord(target: { cwd: string; sessionId: string }, record: RequestRecord): void {
  enqueue(target, (state) => linesFor(state, record, target.sessionId));
}

/** Queue the token count of a request already written to the session's file. */
export function appendTokenCount(
  target: { cwd: string; sessionId: string },
  requestId: string,
  count: RequestTokenCount,
): void {
  enqueue(target, () => [JSON.stringify({ type: "token_count", requestId, ...count })]);
}

function enqueue(target: { cwd: string; sessionId: string }, lines: (state: FileState) => string[]): void {
  if (!isSessionPersistenceEnabled()) return;
  const key = `${target.cwd}\u0000${target.sessionId}`;
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous
    .then(async () => {
      const filePath = await getTracePath(target.cwd, target.sessionId);
      let state = files.get(filePath);
      if (!state) {
        state = { checked: false, written: new Set(), chains: new Map() };
        files.set(filePath, state);
        state.checked = await fs.stat(filePath).then(
          () => true,
          () => false,
        );
      }
      await appendPrivateFile(filePath, `${lines(state).join("\n")}\n`);
    })
    .catch((error: unknown) => {
      debugLog("requestTrace", "write_failed", { message: error instanceof Error ? error.message : String(error) });
    });
  queues.set(key, next);
  void next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
}

/** Wait for queued records to reach their files. */
export async function flushRequestTraces(): Promise<void> {
  await Promise.all([...queues.values()]);
}
