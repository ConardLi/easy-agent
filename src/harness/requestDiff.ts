/**
 * Component-by-component comparison of the first request two Agents render
 * for the same input.
 *
 * Each rendering is a request record (sizes, estimated tokens, and hashes of
 * every component) with the text of each component. Components are matched
 * by id: system prompt sections (`prompt_section:*`, `prompt:*`), context
 * sources (`rule:*`, `skill:*`, `agent:*`), tools (`tool:*`), and messages by
 * source (`message:*`). A component is changed when its text differs; cache
 * markers are not part of the text. Each component's tokens are estimated
 * from its text, so the same text has the same figure on both sides, the
 * differences add up to the difference of the totals, and the result is the
 * same on every run with the same files.
 */

import { createHash } from "node:crypto";
import { diffLines } from "diff";
import type { RenderedContent, RenderedRequest } from "../trace/requestRender.js";
import type { RequestParamsRecord } from "../trace/requestTrace.js";
import { estimateJsonTokens, estimateTextTokens } from "../utils/tokens.js";

export type RequestComponentKind = "prompt_section" | "context_source" | "tool" | "message";

export interface RequestComponentSide {
  bytes: number;
  /** Estimated from the size. */
  tokens: number;
  /** First 16 hex digits of the SHA-256 of the text. */
  hash: string;
}

export interface RequestComponentDifference {
  /** Component id, such as `prompt_section:identity`, `skill:project:review`, or `tool:Write`. */
  id: string;
  kind: RequestComponentKind;
  change: "added" | "removed" | "changed";
  /** Absent when only `b` has the component. */
  a?: RequestComponentSide;
  /** Absent when only `a` has the component. */
  b?: RequestComponentSide;
  /** `b` tokens minus `a` tokens. */
  tokens: number;
  /** For a changed component: the lines only `a` has (`-`) and only `b` has (`+`), in order. */
  lines?: Array<{ op: "-" | "+"; text: string }>;
}

export interface RenderedRequestSummary {
  /** The Agent the request was rendered with. */
  harness: { name: string; hash: string };
  protocol: string;
  model: string;
  params: RequestParamsRecord;
  /** Estimated input tokens of the three parts (the sums of their components), and their sum. */
  tokens: { system: number; tools: number; messages: number; total: number };
  /** Components the request carries. */
  components: number;
}

export interface RequestDiff {
  /** The input both requests were rendered for. */
  prompt: string;
  /** Token figures are estimated from sizes; nothing was sent to a provider. */
  estimated: true;
  a: RenderedRequestSummary;
  b: RenderedRequestSummary;
  /** Model, protocol, and request parameters that differ. */
  params: Array<{ key: string; a: unknown; b: unknown }>;
  /** Components that differ, grouped by kind, each kind in request order. */
  components: RequestComponentDifference[];
  /** Components both requests carry with the same text. */
  unchanged: number;
}

const KIND_ORDER: readonly RequestComponentKind[] = ["prompt_section", "context_source", "tool", "message"];

export function componentKind(id: string): RequestComponentKind {
  if (id.startsWith("tool:")) return "tool";
  if (id.startsWith("message:")) return "message";
  if (id.startsWith("rule:") || id.startsWith("skill:") || id.startsWith("agent:")) return "context_source";
  return "prompt_section";
}

interface Folded extends RequestComponentSide {
  part: RenderedContent["part"];
  text: string;
}

/**
 * The components of a rendering by id, in request order. A component that
 * appears more than once (a section in two pieces, messages of one source) is
 * folded into one text, and its size and tokens are of that text.
 */
function foldComponents(rendered: RenderedRequest): Map<string, Folded> {
  const pieces = new Map<string, { part: RenderedContent["part"]; texts: string[] }>();
  for (const content of rendered.contents) {
    const entry = pieces.get(content.component) ?? { part: content.part, texts: [] };
    entry.texts.push(content.text);
    pieces.set(content.component, entry);
  }
  const folded = new Map<string, Folded>();
  for (const [id, { part, texts }] of pieces) {
    const text = texts.join(part === "messages" ? "\n\n" : "");
    folded.set(id, {
      part,
      text,
      bytes: Buffer.byteLength(text),
      tokens: part === "tools" ? estimateJsonTokens(text) : estimateTextTokens(text),
      hash: digest(text),
    });
  }
  return folded;
}

const digest = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

const side = ({ bytes, tokens, hash }: Folded): RequestComponentSide => ({ bytes, tokens, hash });

/** Tokens of each part: the sum of its components. */
function partTokens(components: Map<string, Folded>): RenderedRequestSummary["tokens"] {
  const tokens = { system: 0, tools: 0, messages: 0, total: 0 };
  for (const component of components.values()) {
    tokens[component.part] += component.tokens;
    tokens.total += component.tokens;
  }
  return tokens;
}

/** A tool's JSON one key per line, so a changed description or parameter is one line of the diff. */
const readable = (component: Folded) =>
  component.part === "tools" ? JSON.stringify(JSON.parse(component.text), null, 2) : component.text;

function changedLines(a: string, b: string): Array<{ op: "-" | "+"; text: string }> {
  const lines: Array<{ op: "-" | "+"; text: string }> = [];
  for (const part of diffLines(a, b)) {
    if (!part.added && !part.removed) continue;
    const text = part.value.endsWith("\n") ? part.value.slice(0, -1) : part.value;
    for (const line of text.split("\n")) lines.push({ op: part.added ? "+" : "-", text: line });
  }
  return lines;
}

function summary(
  rendered: RenderedRequest,
  harness: { name: string; hash: string },
  components: Map<string, Folded>,
): RenderedRequestSummary {
  const { record } = rendered;
  return {
    harness,
    protocol: record.protocol,
    model: record.model.sent,
    params: record.params,
    tokens: partTokens(components),
    components: components.size,
  };
}

const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

export interface RenderedSide {
  harness: { name: string; hash: string };
  request: RenderedRequest;
}

/** Compare the first request of two Agents for the same input. */
export function diffRenderedRequests(prompt: string, a: RenderedSide, b: RenderedSide): RequestDiff {
  const left = foldComponents(a.request);
  const right = foldComponents(b.request);

  const params: RequestDiff["params"] = [];
  const compare = (key: string, x: unknown, y: unknown) => {
    if (!same(x, y)) params.push({ key, a: x, b: y });
  };
  compare("protocol", a.request.record.protocol, b.request.record.protocol);
  compare("model", a.request.record.model.sent, b.request.record.model.sent);
  const keys = new Set([...Object.keys(a.request.record.params), ...Object.keys(b.request.record.params)]);
  for (const key of [...keys].sort()) {
    compare(
      key,
      (a.request.record.params as unknown as Record<string, unknown>)[key],
      (b.request.record.params as unknown as Record<string, unknown>)[key],
    );
  }

  const components: RequestComponentDifference[] = [];
  let unchanged = 0;
  const ids = [...left.keys(), ...[...right.keys()].filter((id) => !left.has(id))];
  for (const kind of KIND_ORDER) {
    for (const id of ids.filter((candidate) => componentKind(candidate) === kind)) {
      const x = left.get(id);
      const y = right.get(id);
      if (x && y) {
        if (x.text === y.text) {
          unchanged++;
          continue;
        }
        components.push({
          id,
          kind,
          change: "changed",
          a: side(x),
          b: side(y),
          tokens: y.tokens - x.tokens,
          lines: changedLines(readable(x), readable(y)),
        });
      } else if (x) {
        components.push({ id, kind, change: "removed", a: side(x), tokens: -x.tokens });
      } else if (y) {
        components.push({ id, kind, change: "added", b: side(y), tokens: y.tokens });
      }
    }
  }

  return {
    prompt,
    estimated: true,
    a: summary(a.request, a.harness, left),
    b: summary(b.request, b.harness, right),
    params,
    components,
    unchanged,
  };
}
