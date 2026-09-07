/**
 * Tool Search — policy + request shaping for deferred tools.
 *
 * Reference: claude-code-source-code/src/utils/toolSearch.ts,
 *            claude-code-source-code/src/tools/ToolSearchTool/prompt.ts,
 *            claude-code-source-code/src/services/api/claude.ts (L1132–1387),
 *            claude-code-source-code/src/utils/messages.ts (tool_reference rules).
 *
 * When enabled, "deferred" tools (MCP tools and any tool flagged
 * `shouldDefer`) are not expanded in the request's `tools[]`. The model only
 * sees their names in an `<available-deferred-tools>` list and must call
 * ToolSearch, which answers with `tool_reference` blocks. The next request
 * scans the history for those references and re-includes just the referenced
 * schemas. All "which tools are loaded" state therefore lives in the message
 * history — there is no separate registry to keep in sync.
 *
 * This module intentionally has no dependency on the tool registry
 * (`tools/index.ts`) — callers pass the `Tool[]` they hold — so it can be
 * imported from the tools layer, the agentic loop, and the API layer alike
 * without cycles.
 */

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { toolToApiParam, type ApiToolParam, type Tool } from "../tools/Tool.js";
import type { ContentBlock, ToolReferenceBlock } from "../types/message.js";
import { redactUrlForDisplay } from "../config/redaction.js";
import { debugLog } from "./log.js";
import { getContextWindowForModel } from "./tokens.js";
import { areExperimentalBetasDisabled } from "./experimentalBetas.js";
export { areExperimentalBetasDisabled } from "./experimentalBetas.js";

export const TOOL_SEARCH_TOOL_NAME = "ToolSearch";

/**
 * Beta header required for `defer_loading` on tool definitions and
 * `tool_reference` blocks in tool results. First-party Anthropic endpoint
 * header; Vertex/Bedrock use `tool-search-tool-2025-10-19` instead.
 */
export const TOOL_SEARCH_BETA_HEADER = "advanced-tool-use-2025-11-20";

/**
 * Sibling text block appended to any user message whose tool_result carries
 * `tool_reference`. The server renders the expansion as
 * `<functions>...</functions>` — the same tags as the system prompt's tool
 * block — and when that sits at the prompt tail the model samples the stop
 * sequence at ~10% (A/B: 21/200 vs 0/200). A trailing text block inserts a
 * clean human-turn boundary. Must be a SIBLING of the tool_result block, not
 * inside its content (mixing text with tool_reference there is a server
 * ValueError).
 */
export const TOOL_REFERENCE_TURN_BOUNDARY = "Tool loaded.";

/** Placeholder used when a tool_result's content was entirely tool_reference blocks. */
const TOOL_REFERENCES_REMOVED_DISABLED = "[Tool references removed - tool search not enabled]";
const TOOL_REFERENCES_REMOVED_UNAVAILABLE = "[Tool references removed - tools no longer available]";

/** Marker written into the compact boundary so discovered tools survive compaction. */
export const COMPACT_DISCOVERED_TOOLS_KEY = "discovered_tools";

// ─── Env helpers ─────────────────────────────────────────────────────────

function isEnvTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function isEnvDefinedFalsy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
}

function getToolSearchEnvValue(): string | undefined {
  // Project-prefixed name is canonical; the source's name is honored for parity.
  return process.env.EASY_AGENT_ENABLE_TOOL_SEARCH ?? process.env.ENABLE_TOOL_SEARCH;
}

// ─── Mode ────────────────────────────────────────────────────────────────

/**
 * Tool search mode. Determines how deferrable tools (MCP + shouldDefer) are
 * surfaced:
 *   - 'tst':      deferred tools discovered via ToolSearch (always on)
 *   - 'tst-auto': tools deferred only when their definitions exceed a
 *                 percentage of the context window
 *   - 'standard': tool search disabled — all tools exposed inline
 */
export type ToolSearchMode = "tst" | "tst-auto" | "standard";

/** Default percentage of the context window at which tst-auto kicks in. */
const DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE = 10;

/** Chars-per-token approximation for tool definitions (name + description + schema). */
const CHARS_PER_TOKEN = 2.5;

/**
 * Parse `auto:N`. Returns N clamped to 0–100, or null when the value is not
 * in `auto:N` form or N is not a number.
 */
function parseAutoPercentage(value: string): number | null {
  if (!value.startsWith("auto:")) return null;
  const percent = parseInt(value.slice(5), 10);
  if (isNaN(percent)) {
    debugLog("toolsearch", `Invalid tool search value "${value}": expected auto:N where N is a number.`);
    return null;
  }
  return Math.max(0, Math.min(100, percent));
}

function isAutoToolSearchMode(value: string | undefined): boolean {
  if (!value) return false;
  return value === "auto" || value.startsWith("auto:");
}

function getAutoToolSearchPercentage(): number {
  const value = getToolSearchEnvValue();
  if (!value || value === "auto") return DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE;
  return parseAutoPercentage(value) ?? DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE;
}

/**
 * Determine the tool search mode from the environment.
 *
 *   value                 mode
 *   auto / auto:1-99      tst-auto
 *   true / auto:0         tst
 *   false / auto:100      standard
 *   (unset)               tst   (default: always defer MCP and shouldDefer tools)
 */
export function getToolSearchMode(): ToolSearchMode {
  if (areExperimentalBetasDisabled()) return "standard";

  const value = getToolSearchEnvValue();
  const autoPercent = value ? parseAutoPercentage(value) : null;
  if (autoPercent === 0) return "tst";
  if (autoPercent === 100) return "standard";
  if (isAutoToolSearchMode(value)) return "tst-auto";

  if (isEnvTruthy(value)) return "tst";
  if (isEnvDefinedFalsy(value)) return "standard";
  return "tst";
}

// ─── Deferral ────────────────────────────────────────────────────────────

/**
 * Whether a tool requires ToolSearch before it can be called. Order matters:
 *   1. alwaysLoad → never deferred (lets MCP tools opt out explicitly)
 *   2. isMcp      → deferred (workflow-specific by nature)
 *   3. ToolSearch → never deferred (the model needs it to load everything else)
 *   4. shouldDefer
 */
export function isDeferredTool(tool: Tool): boolean {
  if (tool.alwaysLoad === true) return false;
  if (tool.isMcp === true) return true;
  if (tool.name === TOOL_SEARCH_TOOL_NAME) return false;
  return tool.shouldDefer === true;
}

/** One line of the <available-deferred-tools> list. Names only. */
export function formatDeferredToolLine(tool: Tool): string {
  return tool.name;
}

// ─── Enablement (two tiers) ─────────────────────────────────────────────

/**
 * Models that do NOT support `tool_reference`. New models are assumed to
 * support it unless matched here (negative test — no code change per model).
 */
const UNSUPPORTED_TOOL_REFERENCE_MODEL_PATTERNS = ["haiku"];

export function modelSupportsToolReference(model: string): boolean {
  const normalized = model.toLowerCase();
  return !UNSUPPORTED_TOOL_REFERENCE_MODEL_PATTERNS.some((p) => normalized.includes(p));
}

/** Hosts that are known to accept the tool-search beta shapes verbatim. */
const FIRST_PARTY_ANTHROPIC_HOSTS = new Set(["api.anthropic.com"]);

export function isFirstPartyAnthropicBaseUrl(baseURL: string | undefined): boolean {
  if (!baseURL) return true;
  try {
    return FIRST_PARTY_ANTHROPIC_HOSTS.has(new URL(baseURL).hostname);
  } catch {
    return false;
  }
}

let loggedOptimistic = false;

/**
 * Cheap, synchronous, optimistic check: could tool search possibly be on?
 * Ignores model support and the tst-auto threshold. Use for:
 *   - registering ToolSearch in the base tool list
 *   - ToolSearch's own `isEnabled()`
 *   - deciding whether to append the schema-not-sent hint
 * Returns false only when tool search is definitively off (standard mode).
 * For the per-request decision use `isToolSearchEnabled()`.
 */
export function isToolSearchEnabledOptimistic(): boolean {
  const mode = getToolSearchMode();
  const result = mode !== "standard";
  if (!loggedOptimistic) {
    loggedOptimistic = true;
    debugLog("toolsearch", "optimistic", { mode, value: getToolSearchEnvValue() ?? null, result });
  }
  return result;
}

export function isToolSearchToolAvailable(tools: readonly { name: string }[]): boolean {
  return tools.some((t) => t.name === TOOL_SEARCH_TOOL_NAME);
}

/** Per-request context needed by the definitive enablement check. */
export interface ToolSearchRequestEnv {
  /** Wire protocol of the target profile. Only `anthropic` needs server-side beta support. */
  protocol: "anthropic" | "openai-chat" | "openai-responses" | "gemini";
  /** Effective base URL for the Anthropic protocol (profile override or ANTHROPIC_BASE_URL). */
  baseURL?: string;
}

function calculateDeferredToolDefinitionChars(tools: readonly Tool[]): number {
  return tools
    .filter(isDeferredTool)
    .reduce(
      (total, t) => total + t.name.length + t.description.length + JSON.stringify(t.inputSchema).length,
      0,
    );
}

/**
 * tst-auto: are the deferred definitions big enough to be worth deferring?
 * Threshold = contextWindow × N%. Without a token-count API we use the
 * character heuristic (2.5 chars/token) directly.
 */
function checkAutoThreshold(model: string, tools: readonly Tool[]): {
  enabled: boolean;
  chars: number;
  charThreshold: number;
} {
  const tokenThreshold = Math.floor(getContextWindowForModel(model) * (getAutoToolSearchPercentage() / 100));
  const charThreshold = Math.floor(tokenThreshold * CHARS_PER_TOKEN);
  const chars = calculateDeferredToolDefinitionChars(tools);
  return { enabled: chars >= charThreshold, chars, charThreshold };
}

/**
 * Definitive, per-request check. Considers, in order:
 *   1. model support for tool_reference (Haiku family is excluded)
 *   2. ToolSearch present in the tool list (it may be disallowed)
 *   3. gateway heuristic — for the Anthropic protocol pointed at a non
 *      first-party host, tool search is off unless the user explicitly set
 *      the env var (any non-empty value asserts "my proxy forwards betas")
 *   4. mode: tst → on; standard → off; tst-auto → threshold
 *
 * `source` only decorates the debug log (query / compact / subagent).
 */
export function isToolSearchEnabled(
  model: string,
  tools: readonly Tool[],
  env: ToolSearchRequestEnv,
  source?: string,
): boolean {
  const log = (enabled: boolean, reason: string, extra?: Record<string, unknown>) =>
    debugLog("toolsearch", "mode_decision", { enabled, reason, model, source: source ?? null, ...extra });

  if (!modelSupportsToolReference(model)) {
    log(false, "model_unsupported");
    return false;
  }
  if (!isToolSearchToolAvailable(tools)) {
    log(false, "tool_search_unavailable");
    return false;
  }

  const mode = getToolSearchMode();
  if (mode === "standard") {
    log(false, "standard_mode");
    return false;
  }

  if (
    env.protocol === "anthropic" &&
    !getToolSearchEnvValue() &&
    !isFirstPartyAnthropicBaseUrl(env.baseURL)
  ) {
    log(false, "non_first_party_base_url", {
      baseURL: env.baseURL ? redactUrlForDisplay(env.baseURL) : undefined,
    });
    return false;
  }

  if (mode === "tst") {
    log(true, "tst_enabled");
    return true;
  }

  const { enabled, chars, charThreshold } = checkAutoThreshold(model, tools);
  log(enabled, enabled ? "auto_above_threshold" : "auto_below_threshold", {
    chars,
    charThreshold,
    percentage: getAutoToolSearchPercentage(),
  });
  return enabled;
}

// ─── tool_reference scanning ────────────────────────────────────────────

export function isToolReferenceBlock(obj: unknown): obj is ToolReferenceBlock {
  return (
    typeof obj === "object" &&
    obj !== null &&
    (obj as { type?: unknown }).type === "tool_reference" &&
    typeof (obj as { tool_name?: unknown }).tool_name === "string"
  );
}

function isToolResultWithBlocks(
  obj: unknown,
): obj is { type: "tool_result"; tool_use_id: string; content: unknown[]; is_error?: boolean } {
  return (
    typeof obj === "object" &&
    obj !== null &&
    (obj as { type?: unknown }).type === "tool_result" &&
    Array.isArray((obj as { content?: unknown }).content)
  );
}

function contentHasToolReference(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((b) => isToolResultWithBlocks(b) && b.content.some(isToolReferenceBlock));
}

/** Is this the `[CompactBoundary] ...` marker written by context/compaction.ts? */
function isCompactBoundaryMessage(msg: MessageParam): msg is MessageParam & { content: string } {
  return typeof msg.content === "string" && msg.content.startsWith("[CompactBoundary]");
}

/**
 * Names of every deferred tool that has been loaded in this conversation.
 *
 * Sources, in scan order:
 *   - `[CompactBoundary] ... discovered_tools=A,B` markers (compaction
 *     replaces the tool_reference-bearing messages with a summary, so the
 *     pre-compact set is snapshotted onto the boundary)
 *   - `tool_reference` blocks inside user-message tool_results (the direct
 *     output of ToolSearch)
 */
export function extractDiscoveredToolNames(messages: readonly MessageParam[]): Set<string> {
  const discovered = new Set<string>();
  let carriedFromBoundary = 0;

  for (const msg of messages) {
    if (isCompactBoundaryMessage(msg)) {
      const match = msg.content.match(new RegExp(`${COMPACT_DISCOVERED_TOOLS_KEY}=(\\S+)`));
      if (match?.[1]) {
        for (const name of match[1].split(",").filter(Boolean)) {
          discovered.add(name);
          carriedFromBoundary++;
        }
      }
      continue;
    }
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!isToolResultWithBlocks(block)) continue;
      for (const item of block.content) {
        if (isToolReferenceBlock(item)) discovered.add(item.tool_name);
      }
    }
  }

  if (discovered.size > 0) {
    debugLog("toolsearch", "discovered_tools", {
      count: discovered.size,
      carriedFromBoundary,
      names: [...discovered],
    });
  }
  return discovered;
}

// ─── Request shaping ────────────────────────────────────────────────────

export interface PrepareToolSearchRequestParams {
  /** Every tool the caller would otherwise send (full Tool objects, for metadata). */
  tools: readonly Tool[];
  messages: readonly MessageParam[];
  model: string;
  env: ToolSearchRequestEnv;
  /** MCP servers still connecting — keep ToolSearch available so the model can retry later. */
  hasPendingMcpServers?: boolean;
  source?: string;
}

export interface PreparedToolSearchRequest {
  /** Whether tool search is active for this request. */
  enabled: boolean;
  /** Tools to send, with `defer_loading` set on deferred ones. */
  tools: ApiToolParam[];
  /** Messages to send (may carry the prepended deferred-tool list). */
  messages: MessageParam[];
  /** Beta headers to add (Anthropic protocol only; translators ignore them). */
  betaHeaders: string[];
  deferredToolNames: Set<string>;
  discoveredToolNames: Set<string>;
}

/**
 * Shape one request's tools + messages for tool search. Mirrors the order in
 * the source's `claude.ts`:
 *   1. decide enablement (mode / model / availability / gateway / threshold)
 *   2. precompute the deferred set
 *   3. "empty pool" gate — no deferred tools and no pending MCP → off
 *   4. filter: non-deferred ∪ ToolSearch ∪ (deferred ∩ discovered)
 *   5. `defer_loading` on every deferred tool that is sent
 *   6. beta header
 *   7. prepend the <available-deferred-tools> list
 * When disabled: drop ToolSearch from the tools (its tool_reference output
 * can't be handled) and leave messages for the normalizer to strip.
 */
export function prepareToolSearchRequest(params: PrepareToolSearchRequestParams): PreparedToolSearchRequest {
  const { tools, messages, model, env } = params;
  const toApi = (tool: Tool, deferLoading: boolean): ApiToolParam =>
    toolToApiParam(tool, { deferLoading });

  let enabled = isToolSearchEnabled(model, tools, env, params.source);

  const deferredToolNames = new Set<string>();
  if (enabled) {
    for (const t of tools) if (isDeferredTool(t)) deferredToolNames.add(t.name);
  }

  if (enabled && deferredToolNames.size === 0 && !params.hasPendingMcpServers) {
    debugLog("toolsearch", "disabled: no deferred tools available to search");
    enabled = false;
  }

  if (!enabled) {
    return {
      enabled: false,
      tools: tools.filter((t) => t.name !== TOOL_SEARCH_TOOL_NAME).map((t) => toApi(t, false)),
      messages: [...messages],
      betaHeaders: [],
      deferredToolNames: new Set(),
      discoveredToolNames: new Set(),
    };
  }

  const discoveredToolNames = extractDiscoveredToolNames(messages);
  const filtered = tools.filter((tool) => {
    if (!deferredToolNames.has(tool.name)) return true;
    if (tool.name === TOOL_SEARCH_TOOL_NAME) return true;
    return discoveredToolNames.has(tool.name);
  });
  const apiTools = filtered.map((t) => toApi(t, deferredToolNames.has(t.name)));

  const included = filtered.filter((t) => deferredToolNames.has(t.name)).length;
  debugLog("toolsearch", `${included}/${deferredToolNames.size} deferred tools included`, {
    included,
    deferred: deferredToolNames.size,
    total: apiTools.length,
  });

  const deferredList = tools
    .filter((t) => deferredToolNames.has(t.name))
    .map(formatDeferredToolLine)
    .sort()
    .join("\n");

  return {
    enabled: true,
    tools: apiTools,
    messages: deferredList
      ? prependDeferredToolsAnnouncement(messages, deferredList)
      : [...messages],
    betaHeaders: env.protocol === "anthropic" ? [TOOL_SEARCH_BETA_HEADER] : [],
    deferredToolNames,
    discoveredToolNames,
  };
}

/**
 * Prepend the `<available-deferred-tools>` list as an ephemeral, per-request
 * announcement. It is merged into the first user message rather than added as
 * a separate turn so every provider (some reject consecutive user turns) sees
 * one well-formed opening message. Never persisted to the session — the
 * caller passes the shaped copy to the API only.
 */
function prependDeferredToolsAnnouncement(
  messages: readonly MessageParam[],
  deferredList: string,
): MessageParam[] {
  const announcement = `<available-deferred-tools>\n${deferredList}\n</available-deferred-tools>`;
  const first = messages[0];
  if (!first || first.role !== "user") {
    return [{ role: "user", content: announcement }, ...messages];
  }
  const existing: ContentBlock[] =
    typeof first.content === "string"
      ? [{ type: "text", text: first.content }]
      : (first.content as unknown as ContentBlock[]);
  const merged: MessageParam = {
    ...first,
    content: [{ type: "text", text: announcement }, ...existing] as unknown as MessageParam["content"],
  };
  return [merged, ...messages.slice(1)];
}

// ─── Message normalization (tool_reference rules) ───────────────────────

function mapToolResultBlocks(
  msg: MessageParam,
  fn: (block: { type: "tool_result"; tool_use_id: string; content: unknown[]; is_error?: boolean }) => unknown,
): MessageParam {
  if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;
  const next = (msg.content as unknown[]).map((b) => (isToolResultWithBlocks(b) ? fn(b) : b));
  return { ...msg, content: next as unknown as MessageParam["content"] };
}

/**
 * Remove every tool_reference block from a user message's tool_results.
 * Used when tool search is off for this request (mode, model switch to an
 * unsupported family, gateway) so stale references don't 400. A tool_result
 * that becomes empty gets a placeholder text.
 */
export function stripToolReferenceBlocksFromUserMessage(msg: MessageParam): MessageParam {
  if (!contentHasToolReference(msg.content)) return msg;
  return mapToolResultBlocks(msg, (block) => {
    const kept = block.content.filter((c) => !isToolReferenceBlock(c));
    return {
      ...block,
      content: kept.length > 0 ? kept : [{ type: "text", text: TOOL_REFERENCES_REMOVED_DISABLED }],
    };
  });
}

/**
 * Remove tool_reference blocks that point at tools no longer in the request
 * (MCP server disconnected / renamed since the session was saved). Without
 * this the API rejects with "Tool reference not found in available tools".
 */
export function stripUnavailableToolReferencesFromUserMessage(
  msg: MessageParam,
  availableToolNames: ReadonlySet<string>,
): MessageParam {
  if (!contentHasToolReference(msg.content)) return msg;
  const hasUnavailable = (msg.content as unknown[]).some(
    (b) =>
      isToolResultWithBlocks(b) &&
      b.content.some((c) => isToolReferenceBlock(c) && !availableToolNames.has(c.tool_name)),
  );
  if (!hasUnavailable) return msg;
  return mapToolResultBlocks(msg, (block) => {
    const kept = block.content.filter((c) => {
      if (!isToolReferenceBlock(c)) return true;
      const available = availableToolNames.has(c.tool_name);
      if (!available) debugLog("toolsearch", `Filtering out tool_reference for unavailable tool: ${c.tool_name}`);
      return available;
    });
    return {
      ...block,
      content: kept.length > 0 ? kept : [{ type: "text", text: TOOL_REFERENCES_REMOVED_UNAVAILABLE }],
    };
  });
}

/**
 * Append the `Tool loaded.` sibling text block to a user message that still
 * carries tool_reference after stripping. Idempotent — matched by prefix so a
 * previously tagged block is recognised.
 */
export function appendToolReferenceTurnBoundary(msg: MessageParam): MessageParam {
  if (!contentHasToolReference(msg.content)) return msg;
  const blocks = msg.content as unknown as ContentBlock[];
  const alreadyHas = blocks.some(
    (b) => b.type === "text" && b.text.startsWith(TOOL_REFERENCE_TURN_BOUNDARY),
  );
  if (alreadyHas) return msg;
  return {
    ...msg,
    content: [...blocks, { type: "text", text: TOOL_REFERENCE_TURN_BOUNDARY }] as unknown as MessageParam["content"],
  };
}

/** Keep hook context outside reference-only tool_result bodies. */
function separateToolReferenceSiblings(msg: MessageParam): MessageParam {
  if (!contentHasToolReference(msg.content)) return msg;
  const siblings: unknown[] = [];
  const next = (msg.content as unknown[]).map((block) => {
    if (!isToolResultWithBlocks(block) || !block.content.some(isToolReferenceBlock)) return block;
    siblings.push(...block.content.filter((item) => !isToolReferenceBlock(item)));
    return { ...block, content: block.content.filter(isToolReferenceBlock) };
  });
  return { ...msg, content: [...next, ...siblings] as MessageParam["content"] };
}

/**
 * Apply the tool_reference rules to a whole history right before it goes on
 * the wire (Anthropic protocol):
 *   - tool search off  → strip every tool_reference
 *   - tool search on   → strip references to tools not in this request, then
 *                        add the turn-boundary sibling
 */
export function normalizeToolReferencesForAPI(
  messages: MessageParam[],
  options: { toolSearchEnabled: boolean; availableToolNames: ReadonlySet<string> },
): MessageParam[] {
  return messages.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;
    if (!options.toolSearchEnabled) return stripToolReferenceBlocksFromUserMessage(msg);
    const stripped = stripUnavailableToolReferencesFromUserMessage(msg, options.availableToolNames);
    return appendToolReferenceTurnBoundary(separateToolReferenceSiblings(stripped));
  });
}

/**
 * Non-Anthropic fallback: the provider has no server-side tool_reference
 * expansion, so render each reference as the same `<functions>` block the
 * model sees at the top of the prompt. The referenced schemas come from the
 * request's own tool list (discovered tools are re-included by
 * `prepareToolSearchRequest`, so they are always present).
 */
export function renderToolReferencesAsText(
  messages: MessageParam[],
  tools: readonly ApiToolParam[],
): MessageParam[] {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return messages.map((msg) =>
    mapToolResultBlocks(msg, (block) => {
      if (!block.content.some(isToolReferenceBlock)) return block;
      const lines: string[] = [];
      const kept: unknown[] = [];
      for (const c of block.content) {
        if (!isToolReferenceBlock(c)) {
          kept.push(c);
          continue;
        }
        const tool = byName.get(c.tool_name);
        lines.push(
          tool
            ? `<function>${JSON.stringify({ description: tool.description, name: tool.name, parameters: tool.input_schema })}</function>`
            : `<function>${JSON.stringify({ name: c.tool_name, error: "tool no longer available" })}</function>`,
        );
      }
      const text = `<functions>\n${lines.join("\n")}\n</functions>`;
      return { ...block, content: [...kept, { type: "text", text }] };
    }),
  );
}

/** Strip the beta-only `defer_loading` field for providers that reject unknown keys. */
export function stripDeferLoading(tools: readonly ApiToolParam[]): ApiToolParam[] {
  return tools.map(({ defer_loading: _d, ...rest }) => rest);
}

// ─── Dispatch-time hint ─────────────────────────────────────────────────

/**
 * Appended to a failed tool call when the tool is deferred and was never
 * discovered in this conversation. The raw error ("expected string, got
 * undefined") doesn't tell the model to load the schema; this does. Returns
 * null when the schema was (or would have been) sent.
 *
 * Optimistic gating — reconstructing the full per-request decision here is
 * fragile; an occasional misfire (Haiku, tst-auto below threshold) costs one
 * extra round-trip on an already-failing path.
 */
export function buildSchemaNotSentHint(
  tool: Tool,
  messages: readonly MessageParam[],
  tools: readonly { name: string }[],
): string | null {
  if (!isToolSearchEnabledOptimistic()) return null;
  if (!isToolSearchToolAvailable(tools)) return null;
  if (!isDeferredTool(tool)) return null;
  if (extractDiscoveredToolNames(messages).has(tool.name)) return null;

  return (
    `\n\nTool "${tool.name}" is deferred-loading and needs to be discovered before use.\n` +
    `1. First load its schema with ToolSearch: ${TOOL_SEARCH_TOOL_NAME}("select:${tool.name}")\n` +
    `2. Then call ${tool.name} with the parameters shown in the returned schema\n` +
    `\nExample:\n` +
    `${TOOL_SEARCH_TOOL_NAME}("select:${tool.name}") → ${tool.name}({ ... })\n` +
    `\nYou can load several tools at once: ${TOOL_SEARCH_TOOL_NAME}("select:TaskGet,TaskCreate,TaskUpdate,TaskList").`
  );
}
