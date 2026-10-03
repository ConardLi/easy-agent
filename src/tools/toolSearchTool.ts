/**
 * ToolSearch — fetch full schema definitions for deferred tools.
 *
 * Deferred tools (MCP tools, `shouldDefer` tools) are announced to the model
 * by name only. This tool maps a query — `select:A,B`, keywords, or
 * `+required` keywords — onto that pool and returns `tool_reference` blocks.
 * The API expands each reference into the tool's definition; on the next
 * request the client re-includes the referenced schemas in `tools[]` (see
 * utils/toolSearch.ts `prepareToolSearchRequest`).
 */

import { getMcpRegistry } from "../services/mcp/registry.js";
import { isDeferredTool, TOOL_SEARCH_TOOL_NAME } from "../utils/toolSearch.js";
import { debugLog } from "../utils/log.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";

const DEFAULT_MAX_RESULTS = 5;

const PROMPT = `Fetches full schema definitions for deferred tools so they can be called.

Deferred tools appear by name in <available-deferred-tools> messages. Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and returns the matched tools' complete JSONSchema definitions inside a <functions> block. Once a tool's schema appears in that result, it is callable exactly like any tool defined at the top of the prompt.

Result format: each matched tool appears as one <function>{"description": "...", "name": "...", "parameters": {...}}</function> line inside the <functions> block — the same encoding as the tool list at the top of this prompt.

Query forms:
- "select:Read,Edit,Grep" — fetch these exact tools by name
- "notebook jupyter" — keyword search, up to max_results best matches
- "+slack send" — require "slack" in the name, rank by remaining terms`;

// ─── Name parsing ──────────────────────────────────────────────────

interface ParsedToolName {
  parts: string[];
  full: string;
  isMcp: boolean;
}

/**
 * Split a tool name into searchable parts. MCP names (`mcp__server__action`)
 * split on `__` then `_`; regular names split on CamelCase and `_`.
 */
function parseToolName(name: string): ParsedToolName {
  if (name.startsWith("mcp__")) {
    const withoutPrefix = name.replace(/^mcp__/, "").toLowerCase();
    return {
      parts: withoutPrefix
        .split("__")
        .flatMap((p) => p.split("_"))
        .filter(Boolean),
      full: withoutPrefix.replace(/__/g, " ").replace(/_/g, " "),
      isMcp: true,
    };
  }
  const parts = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return { parts, full: parts.join(" "), isMcp: false };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-boundary regex per term, compiled once per search instead of tools × terms times. */
function compileTermPatterns(terms: string[]): Map<string, RegExp> {
  const patterns = new Map<string, RegExp>();
  for (const term of terms) {
    if (!patterns.has(term)) patterns.set(term, new RegExp(`\\b${escapeRegExp(term)}\\b`));
  }
  return patterns;
}

// ─── Keyword search ────────────────────────────────────────────────

/**
 * Keyword search over deferred tool names, search hints and descriptions.
 *
 * Paths, first hit wins:
 *   1. exact name (deferred first, then the full set — selecting an
 *      already-loaded tool is a harmless no-op that avoids retry churn)
 *   2. `mcp__server` prefix → every deferred tool under that server
 *   3. weighted scoring; `+term` marks a required term that pre-filters
 *      candidates before scoring
 */
export function searchToolsWithKeywords(
  query: string,
  deferredTools: readonly Tool[],
  tools: readonly Tool[],
  maxResults: number,
): string[] {
  const queryLower = query.toLowerCase().trim();

  const exact =
    deferredTools.find((t) => t.name.toLowerCase() === queryLower) ??
    tools.find((t) => t.name.toLowerCase() === queryLower);
  if (exact) return [exact.name];

  if (queryLower.startsWith("mcp__") && queryLower.length > 5) {
    const prefixMatches = deferredTools
      .filter((t) => t.name.toLowerCase().startsWith(queryLower))
      .slice(0, maxResults)
      .map((t) => t.name);
    if (prefixMatches.length > 0) return prefixMatches;
  }

  const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 0);
  const requiredTerms: string[] = [];
  const optionalTerms: string[] = [];
  for (const term of queryTerms) {
    if (term.startsWith("+") && term.length > 1) requiredTerms.push(term.slice(1));
    else optionalTerms.push(term);
  }
  const allScoringTerms = requiredTerms.length > 0 ? [...requiredTerms, ...optionalTerms] : queryTerms;
  const termPatterns = compileTermPatterns(allScoringTerms);

  let candidates = deferredTools;
  if (requiredTerms.length > 0) {
    candidates = deferredTools.filter((tool) => {
      const parsed = parseToolName(tool.name);
      const desc = tool.description.toLowerCase();
      const hint = tool.searchHint?.toLowerCase() ?? "";
      return requiredTerms.every((term) => {
        const pattern = termPatterns.get(term)!;
        return (
          parsed.parts.includes(term) ||
          parsed.parts.some((p) => p.includes(term)) ||
          pattern.test(desc) ||
          (hint !== "" && pattern.test(hint))
        );
      });
    });
  }

  const scored = candidates.map((tool) => {
    const parsed = parseToolName(tool.name);
    const desc = tool.description.toLowerCase();
    const hint = tool.searchHint?.toLowerCase() ?? "";
    let score = 0;
    for (const term of allScoringTerms) {
      const pattern = termPatterns.get(term)!;
      if (parsed.parts.includes(term)) {
        score += parsed.isMcp ? 12 : 10;
      } else if (parsed.parts.some((p) => p.includes(term))) {
        score += parsed.isMcp ? 6 : 5;
      }
      if (parsed.full.includes(term) && score === 0) score += 3;
      if (hint !== "" && pattern.test(hint)) score += 4;
      if (pattern.test(desc)) score += 2;
    }
    return { name: tool.name, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((s) => s.name);
}

// ─── Result shaping ────────────────────────────────────────────────

export interface ToolSearchOutput {
  matches: string[];
  query: string;
  total_deferred_tools: number;
  pending_mcp_servers?: string[];
}

function getPendingMcpServerNames(): string[] | undefined {
  const pending = getMcpRegistry()
    .filter((e) => e.connection.type === "pending")
    .map((e) => e.connection.name);
  return pending.length > 0 ? pending : undefined;
}

/**
 * Turn the search output into a tool_result body: `tool_reference` blocks on
 * a hit, plain text (with a pending-server hint) on a miss. Text and
 * tool_reference never share one tool_result — the server rejects the mix.
 */
export function toolSearchOutputToResult(output: ToolSearchOutput): ToolResult {
  if (output.matches.length === 0) {
    let text = "No matching deferred tools found";
    if (output.pending_mcp_servers && output.pending_mcp_servers.length > 0) {
      text +=
        `. Some MCP servers are still connecting: ${output.pending_mcp_servers.join(", ")}. ` +
        `Their tools will become available shortly — try searching again.`;
    }
    return { content: text };
  }
  return {
    content: output.matches.map((name) => ({ type: "tool_reference" as const, tool_name: name })),
  };
}

/** Core lookup, independent of the registry so it can be unit-tested with any tool list. */
export function runToolSearch(
  query: string,
  maxResults: number,
  tools: readonly Tool[],
  pendingMcpServers?: string[],
): ToolSearchOutput {
  const deferredTools = tools.filter(isDeferredTool);
  const findByName = (pool: readonly Tool[], name: string) =>
    pool.find((t) => t.name === name) ?? pool.find((t) => t.name.toLowerCase() === name.toLowerCase());

  const selectMatch = query.match(/^select:(.+)$/i);
  if (selectMatch) {
    const requested = selectMatch[1]!
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const found: string[] = [];
    const missing: string[] = [];
    for (const name of requested) {
      const tool = findByName(deferredTools, name) ?? findByName(tools, name);
      if (tool) {
        if (!found.includes(tool.name)) found.push(tool.name);
      } else {
        missing.push(name);
      }
    }
    if (found.length === 0) {
      debugLog("toolsearch", `select failed — none found: ${missing.join(", ")}`);
      return {
        matches: [],
        query,
        total_deferred_tools: deferredTools.length,
        ...(pendingMcpServers ? { pending_mcp_servers: pendingMcpServers } : {}),
      };
    }
    debugLog(
      "toolsearch",
      missing.length > 0
        ? `partial select — found: ${found.join(", ")}, missing: ${missing.join(", ")}`
        : `selected ${found.join(", ")}`,
    );
    return { matches: found, query, total_deferred_tools: deferredTools.length };
  }

  const matches = searchToolsWithKeywords(query, deferredTools, tools, maxResults);
  debugLog("toolsearch", `keyword search for "${query}", found ${matches.length} matches`);
  return {
    matches,
    query,
    total_deferred_tools: deferredTools.length,
    ...(matches.length === 0 && pendingMcpServers ? { pending_mcp_servers: pendingMcpServers } : {}),
  };
}

// ─── Tool ──────────────────────────────────────────────────────────

export const toolSearchTool: Tool = {
  name: TOOL_SEARCH_TOOL_NAME,
  description: PROMPT,
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description:
          'Query to find deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search.',
      },
      max_results: {
        type: "number",
        description: "Maximum number of results to return (default: 5)",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  maxResultSizeChars: 100_000,

  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { loadFeatureSettings } = await import("../config/features.js");
    if ((await loadFeatureSettings(context.cwd)).toolSearch === "off") {
      return { content: "ToolSearch is disabled by the effective configuration.", isError: true };
    }
    const query = typeof input.query === "string" ? input.query : "";
    if (!query.trim()) return { content: "Error: `query` is required.", isError: true };
    const maxResults =
      typeof input.max_results === "number" && input.max_results > 0
        ? Math.floor(input.max_results)
        : DEFAULT_MAX_RESULTS;

    // Lazy import — tools/index.ts imports this file, so a static import
    // would be a cycle at module init. Resolved at call time instead.
    const tools =
      context.availableTools ??
      (await import("./index.js")).getToolsForMode(context.getPermissionMode?.() === "plan" ? "plan" : "default");
    const output = runToolSearch(query.trim(), maxResults, tools, getPendingMcpServerNames());
    return toolSearchOutputToResult(output);
  },

  isReadOnly() {
    return true;
  },

  isEnabled() {
    // Registration must survive off → on settings changes. Request shaping
    // removes the tool whenever the resolved request policy disables it.
    return true;
  },

  isConcurrencySafe() {
    return true;
  },
};
