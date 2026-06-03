import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import {
  BingSearchAdapter,
  createAdapter,
  type SearchResult,
} from "./webSearch/adapters.js";

/**
 * WebSearch — search the web and return a list of result links.
 *
 * Reference: claude-code-source-code/src/tools/WebSearchTool/WebSearchTool.ts.
 * Like the source, this works WITHOUT any third-party key: it prefers
 * Anthropic's server-side `web_search` tool (on Anthropic endpoints) and falls
 * back to scraping Bing otherwise. See webSearch/adapters.ts for selection.
 */
interface WebSearchInput {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
}

function formatResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `Web search results for "${query}":\n\nNo results found.`;
  }
  const lines = results.map((r) => {
    const base = `  - [${r.title}](${r.url})`;
    return r.snippet ? `${base}: ${r.snippet}` : base;
  });
  return (
    `Web search results for "${query}":\n\nLinks:\n${lines.join("\n")}\n\n` +
    `REMINDER: cite the sources above as markdown links when you use them.`
  );
}

export const webSearchTool: Tool = {
  name: "WebSearch",
  description:
    "Search the web and return a list of relevant result links with snippets. Use it to find current information, then WebFetch a specific result for details.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "The search query (at least 2 characters)" },
      allowed_domains: {
        type: "array",
        items: { type: "string" },
        description: "Only include results from these domains",
      },
      blocked_domains: {
        type: "array",
        items: { type: "string" },
        description: "Never include results from these domains",
      },
    },
    required: ["query"],
  },
  maxResultSizeChars: 100_000,
  async call(rawInput: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const input = rawInput as unknown as WebSearchInput;
    if (!input.query || typeof input.query !== "string" || input.query.trim().length < 2) {
      return { content: "Error: query must be at least 2 characters", isError: true };
    }
    if (input.allowed_domains?.length && input.blocked_domains?.length) {
      return {
        content: "Error: cannot specify both allowed_domains and blocked_domains",
        isError: true,
      };
    }

    const searchOptions = {
      allowedDomains: input.allowed_domains,
      blockedDomains: input.blocked_domains,
      signal: context.abortSignal,
    };

    const adapter = await createAdapter(context.defaultModel);
    try {
      const results = await adapter.search(input.query, searchOptions);
      return { content: formatResults(input.query, results) };
    } catch (error) {
      // The primary backend (e.g. Anthropic server-side search on an endpoint
      // that doesn't support the tool) failed — fall back to the keyless Bing
      // scraper before giving up.
      if (adapter.name !== "bing") {
        try {
          const results = await new BingSearchAdapter().search(input.query, searchOptions);
          return { content: formatResults(input.query, results) };
        } catch {
          // fall through to the original error
        }
      }
      return {
        content: `WebSearch (${adapter.name}) failed: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
  isReadOnly(): boolean {
    return true;
  },
  isEnabled(): boolean {
    return true;
  },
  isConcurrencySafe(): boolean {
    return true;
  },
};
