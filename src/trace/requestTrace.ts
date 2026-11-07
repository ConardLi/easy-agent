/**
 * Request records: what each model request carried, measured where it is sent.
 *
 * The provider layer opens a `RequestTrace` for every request (the main loop,
 * sub-agents, the Auto Mode classifier, WebFetch and WebSearch, compaction)
 * and hands it the request as it goes out: after prompt-cache markers and,
 * for Anthropic, exactly the body the SDK sends. The record lists each part
 * of the request — system prompt sections, tool schemas, messages by source —
 * with its component, size, estimated tokens, and hash, never the text. The
 * result adds the stop reason, the usage the provider reported, timing, and
 * retries.
 *
 * The latest record of each session stays in memory. A session that saves a
 * transcript also appends records to a file next to it (see traceStore.ts)
 * unless the Agent's `trace.level` is `off`.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { harnessSetting } from "../harness/active.js";
import { markedMessageSource, messageSourceOf, type MessageSource } from "../core/messageSources.js";
import { defineSessionState } from "../state/sessionScope.js";
import type { Usage } from "../types/message.js";
import { debugLog } from "../utils/log.js";
import { estimateJsonTokens, estimateMessageTokens, estimateTextTokens } from "../utils/tokens.js";
import { appendRequestRecord } from "./traceStore.js";

export type RequestPurpose = "main" | "subagent" | "classifier" | "webFetch" | "webSearch" | "compaction";

/** What the caller knows about a request: why it is made, and by which sub-agent. */
export interface RequestTraceContext {
  purpose: RequestPurpose;
  /** Set by callers that link later requests to this one; generated otherwise. */
  requestId?: string;
  agent?: { id: string; type: string };
  turnId?: string;
}

export interface TraceSegment {
  /** Component id, such as `prompt_section:environment`, `tool:Read`, or `message:tool_result`. */
  component: string;
  /** UTF-8 bytes: of the text for system prompt sections, of the JSON for tools and messages. */
  bytes: number;
  /** Estimated from the size. */
  tokens: number;
  /** First 16 hex digits of the SHA-256 of what `bytes` measures. */
  hash: string;
}

export interface MessageTraceSegment extends TraceSegment {
  index: number;
  role: MessageParam["role"];
  source: MessageSource;
}

export interface TracePart<S extends TraceSegment> {
  /** UTF-8 bytes of the part's JSON in the request. */
  bytes: number;
  /** Sum of the segments' estimates. */
  tokens: number;
  /** Of the part's JSON; for messages, of the message hashes in order. */
  hash: string;
  segments: S[];
}

export interface RequestParamsRecord {
  maxTokens: number;
  /** The thinking or reasoning setting the request carries, as sent. */
  thinking?: unknown;
  effort?: string;
  betas: string[];
  toolChoice?: string;
  toolSearch: boolean;
  promptCaching: boolean;
  /** `cache_control` markers in the request. */
  cacheMarkers: number;
  promptCacheKey: boolean;
}

export interface RequestRetry {
  attempt: number;
  category: string;
  delayMs: number;
}

export interface RequestResult {
  stopReason: string;
  usage: Usage;
  durationMs: number;
  /** From sending the request to the provider's first event; absent for single-shot requests. */
  firstEventMs?: number;
  attempts: number;
  retries: RequestRetry[];
  /** Set when the request failed; the category the error handling assigned. */
  error?: string;
}

export interface RequestRecord {
  requestId: string;
  purpose: RequestPurpose;
  parentRequestId?: string;
  sessionId?: string;
  turnId?: string;
  agent?: { id: string; type: string };
  startedAt: string;
  protocol: string;
  model: { requested?: string; sent: string };
  params: RequestParamsRecord;
  /** For protocols translated from the Anthropic shape: bytes of the body actually sent. The parts are measured before translation. */
  wireBytes?: number;
  /** Token figures of segments are estimates; the result's usage is the provider's. */
  estimated: true;
  system: TracePart<TraceSegment>;
  tools: TracePart<TraceSegment> & { count: number };
  messages: TracePart<MessageTraceSegment> & {
    count: number;
    bySource: Partial<Record<MessageSource, { count: number; bytes: number; tokens: number }>>;
  };
  result?: RequestResult;
}

/** The request as it goes out; the shape is the Anthropic Messages body. */
export interface SentRequest {
  protocol: string;
  model: string;
  /** The system prompt text the caller passed, before cache markers split it into blocks. */
  systemText?: string;
  /** The `system` field sent. */
  system?: unknown;
  tools?: readonly object[];
  messages: readonly MessageParam[];
  /** The conversation the caller passed, to find each sent message's source. */
  sourceMessages: readonly MessageParam[];
  params: RequestParamsRecord;
  wireBytes?: number;
}

export type TraceLevel = "off" | "summary";

/** Where a session's records go. Set by the session when it opens. */
export interface TraceSink {
  cwd: string;
  sessionId: () => string;
  /** False when the session keeps no transcript; records then stay in memory. */
  persist: boolean;
  turnId: () => string | null;
}

interface TraceState {
  sink: TraceSink | null;
  latest: RequestRecord | null;
  latestByPurpose: Map<RequestPurpose, RequestRecord>;
}

const traceState = defineSessionState<TraceState>("requestTrace", () => ({
  sink: null,
  latest: null,
  latestByPurpose: new Map(),
}));

/** Bind the active session scope's records to a session; null unbinds. */
export function configureRequestTrace(sink: TraceSink | null): void {
  traceState().sink = sink;
}

/** The latest finished request of the active session, or of one purpose. */
export function getLatestRequestRecord(purpose?: RequestPurpose): RequestRecord | null {
  const state = traceState();
  return (purpose ? state.latestByPurpose.get(purpose) : state.latest) ?? null;
}

/** `trace.level` of the running Agent; `full` records as `summary` until it exists. */
export function traceLevel(): TraceLevel {
  return harnessSetting<string>("trace.level") === "off" ? "off" : "summary";
}

// ─── Request frames ─────────────────────────────────────────────────────

interface RequestFrame {
  requestId?: string;
  turnId?: string;
}

const frames = new AsyncLocalStorage<RequestFrame>();

/**
 * Run `fn` as work caused by request `requestId`: requests it makes (the
 * classifier judging a tool call, a sub-agent the tool starts) name that
 * request as their parent.
 */
export function runInRequestFrame<T>(frame: RequestFrame, fn: () => T): T {
  return frames.run(frame, fn);
}

// ─── System prompt layouts ─────────────────────────────────────────────

const MAX_LAYOUTS = 16;
const layouts = new Map<string, ReadonlyArray<{ component: string; text: string }>>();

/**
 * Say which component each part of a system prompt comes from. `parts` must
 * join to `text` with `separator`; the separator after a part counts toward
 * that part. A request whose system prompt was described gets one segment
 * per part, others one segment for the whole prompt.
 */
export function describeSystemPrompt(
  text: string,
  parts: ReadonlyArray<{ component: string; text: string }>,
  separator = "\n\n",
): void {
  if (parts.map((part) => part.text).join(separator) !== text) return;
  layouts.delete(text);
  layouts.set(
    text,
    parts.map((part, index) => ({
      component: part.component,
      text: index < parts.length - 1 ? part.text + separator : part.text,
    })),
  );
  if (layouts.size > MAX_LAYOUTS) layouts.delete(layouts.keys().next().value!);
}

/** Component of a system prompt nobody described: the feature that made the single-shot request. */
function undescribedSystem(purpose: RequestPurpose): string {
  return purpose === "main" || purpose === "subagent" ? "prompt:unattributed" : `prompt:${purpose}`;
}

// ─── Measuring ──────────────────────────────────────────────────────────

const digest = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

interface Measured {
  bytes: number;
  hash: string;
  tokens: number;
  marked: boolean;
}

/** Sent objects are not changed after they are sent, so each is measured once. */
const measured = new WeakMap<object, Measured>();

function measureJson(value: object, tokensOf: (json: string) => number): Measured {
  const cached = measured.get(value);
  if (cached) return cached;
  const json = JSON.stringify(value);
  const result = {
    bytes: Buffer.byteLength(json),
    hash: digest(json),
    tokens: tokensOf(json),
    marked: json.includes('"cache_control"'),
  };
  measured.set(value, result);
  return result;
}

function partOf<S extends TraceSegment>(json: string | undefined, segments: S[]): TracePart<S> {
  return {
    bytes: json === undefined ? 0 : Buffer.byteLength(json),
    tokens: segments.reduce((sum, segment) => sum + segment.tokens, 0),
    hash: json === undefined ? "" : digest(json),
    segments,
  };
}

function measureSystem(sent: SentRequest, purpose: RequestPurpose): TracePart<TraceSegment> {
  if (sent.system === undefined) return partOf(undefined, []);
  const json = JSON.stringify(sent.system);
  const text = sent.systemText ?? (typeof sent.system === "string" ? sent.system : json);
  const parts = layouts.get(text) ?? [{ component: undescribedSystem(purpose), text }];
  return partOf(
    json,
    parts.map((part) => ({
      component: part.component,
      bytes: Buffer.byteLength(part.text),
      tokens: estimateTextTokens(part.text),
      hash: digest(part.text),
    })),
  );
}

function measureTools(tools: readonly object[] | undefined): RequestRecord["tools"] {
  if (!tools || tools.length === 0) return { ...partOf(undefined, []), count: 0 };
  const segments = tools.map((tool) => {
    const { bytes, hash, tokens } = measureJson(tool, estimateJsonTokens);
    const name = (tool as { name?: unknown }).name;
    // The `tool:` component ids of src/harness/components.ts, which this layer does not import.
    return { component: `tool:${typeof name === "string" ? name : "unnamed"}`, bytes, tokens, hash };
  });
  return { ...partOf(JSON.stringify(tools), segments), count: tools.length };
}

/**
 * Pair each sent message with the caller's message it was made from. Sending
 * drops thinking-only assistant messages and copies the ones it changes, so
 * walk both lists in order and match by role where the objects differ.
 */
function sourcesOf(sent: readonly MessageParam[], original: readonly MessageParam[]): MessageSource[] {
  let next = 0;
  return sent.map((message) => {
    let index = original.indexOf(message, next);
    if (index === -1) {
      // A message made for this request alone, such as the deferred tool list.
      const marked = markedMessageSource(message);
      if (marked) return marked;
      index = next;
      while (index < original.length && original[index]!.role !== message.role) index++;
    }
    const source = original[index];
    if (!source) return messageSourceOf(message);
    next = index + 1;
    return messageSourceOf(source);
  });
}

function measureMessages(sent: SentRequest): { part: RequestRecord["messages"]; markers: number } {
  const sources = sourcesOf(sent.messages, sent.sourceMessages);
  let markers = 0;
  const bySource: RequestRecord["messages"]["bySource"] = {};
  const segments = sent.messages.map((message, index): MessageTraceSegment => {
    const { bytes, hash, tokens, marked } = measureJson(message, () => estimateMessageTokens(message));
    if (marked) markers++;
    const source = sources[index]!;
    const total = (bySource[source] ??= { count: 0, bytes: 0, tokens: 0 });
    total.count++;
    total.bytes += bytes;
    total.tokens += tokens;
    return { index, role: message.role, source, component: `message:${source}`, bytes, tokens, hash };
  });
  const bytes = segments.reduce((sum, segment) => sum + segment.bytes, 0) + Math.max(0, segments.length - 1) + 2;
  return {
    part: {
      bytes,
      tokens: segments.reduce((sum, segment) => sum + segment.tokens, 0),
      hash: digest(segments.map((segment) => segment.hash).join("")),
      segments,
      count: segments.length,
      bySource,
    },
    markers,
  };
}

function countMarkers(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.filter((item) => item && typeof item === "object" && "cache_control" in item).length;
}

// ─── The handle ─────────────────────────────────────────────────────────

/**
 * One request's record. Never throws: a failure to measure drops the record
 * and leaves the request alone.
 */
export class RequestTrace {
  readonly requestId: string;
  readonly #context: RequestTraceContext;
  readonly #requestedModel: string | undefined;
  readonly #state: TraceState;
  readonly #sink: { cwd: string; sessionId: string } | null;
  readonly #parentRequestId: string | undefined;
  readonly #turnId: string | undefined;
  readonly #startedAt = new Date();
  readonly #started = performance.now();
  #sentAt: number | undefined;
  #firstEventMs: number | undefined;
  #attempts = 0;
  readonly #retries: RequestRetry[] = [];
  #record: Omit<RequestRecord, "result"> | null = null;
  #done = false;

  constructor(context: RequestTraceContext | undefined, requestedModel: string | undefined) {
    this.#context = context ?? { purpose: "main" };
    this.requestId = this.#context.requestId ?? randomUUID();
    this.#requestedModel = requestedModel;
    this.#state = traceState();
    const frame = frames.getStore();
    const sink = this.#state.sink;
    this.#parentRequestId = frame?.requestId;
    this.#turnId = this.#context.turnId ?? frame?.turnId ?? sink?.turnId() ?? undefined;
    let file: { cwd: string; sessionId: string } | null = null;
    try {
      if (sink?.persist && traceLevel() !== "off") file = { cwd: sink.cwd, sessionId: sink.sessionId() };
    } catch {
      file = null;
    }
    this.#sink = file;
  }

  /** The request went out. The first attempt is measured; later ones are counted. */
  sent(request: SentRequest): void {
    this.#attempts++;
    this.#sentAt = performance.now();
    if (this.#record) return;
    try {
      const purpose = this.#context.purpose;
      const { part: messages, markers } = measureMessages(request);
      const sinkSessionId = this.#sink?.sessionId ?? this.#state.sink?.sessionId();
      this.#record = {
        requestId: this.requestId,
        purpose,
        ...(this.#parentRequestId ? { parentRequestId: this.#parentRequestId } : {}),
        ...(sinkSessionId ? { sessionId: sinkSessionId } : {}),
        ...(this.#turnId ? { turnId: this.#turnId } : {}),
        ...(this.#context.agent ? { agent: this.#context.agent } : {}),
        startedAt: this.#startedAt.toISOString(),
        protocol: request.protocol,
        model: { ...(this.#requestedModel ? { requested: this.#requestedModel } : {}), sent: request.model },
        params: {
          ...request.params,
          cacheMarkers: countMarkers(request.system) + countMarkers(request.tools) + markers,
        },
        ...(request.wireBytes !== undefined ? { wireBytes: request.wireBytes } : {}),
        estimated: true,
        system: measureSystem(request, purpose),
        tools: measureTools(request.tools),
        messages,
      };
    } catch (error) {
      debugLog("requestTrace", "measure_failed", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  firstEvent(): void {
    if (this.#firstEventMs === undefined && this.#sentAt !== undefined) {
      this.#firstEventMs = Math.round(performance.now() - this.#sentAt);
    }
  }

  retry(retry: RequestRetry): void {
    this.#retries.push(retry);
  }

  complete(result: { stopReason: string; usage: Usage }): void {
    this.#finish({ stopReason: result.stopReason, usage: { ...result.usage } });
  }

  fail(category: string): void {
    this.#finish({ stopReason: "error", usage: { input_tokens: 0, output_tokens: 0 }, error: category });
  }

  #finish(outcome: Pick<RequestResult, "stopReason" | "usage" | "error">): void {
    if (this.#done || !this.#record) return;
    this.#done = true;
    const record: RequestRecord = {
      ...this.#record,
      result: {
        stopReason: outcome.stopReason,
        usage: outcome.usage,
        durationMs: Math.round(performance.now() - this.#started),
        ...(this.#firstEventMs !== undefined ? { firstEventMs: this.#firstEventMs } : {}),
        attempts: this.#attempts,
        retries: this.#retries,
        ...(outcome.error ? { error: outcome.error } : {}),
      },
    };
    this.#state.latest = record;
    this.#state.latestByPurpose.set(record.purpose, record);
    if (this.#sink) appendRequestRecord(this.#sink, record);
  }
}

/** `tool_choice` as a record shows it: the type, with the tool's name for a forced tool. */
export function toolChoiceName(choice: { type: string; name?: string }): string {
  return choice.type === "tool" && choice.name ? `tool:${choice.name}` : choice.type;
}

export function startRequestTrace(context: RequestTraceContext | undefined, requestedModel?: string): RequestTrace {
  return new RequestTrace(context, requestedModel);
}
