/**
 * WebSearch provider adapters.
 *
 * Reference: claude-code-source-code/src/tools/WebSearchTool/adapters/
 *   - adapters/index.ts   → createAdapter (api vs bing selection)
 *   - adapters/apiAdapter.ts → Anthropic server-side `web_search_20250305` tool
 *   - adapters/bingAdapter.ts → Bing HTML scrape (no API key)
 *
 * Both source adapters work WITHOUT any third-party key: the API adapter rides
 * on the Anthropic endpoint the agent already uses, and the Bing adapter
 * scrapes public search HTML. We port both faithfully.
 *
 * Selection (mirrors the source's intended logic):
 *   - env WEB_SEARCH_ADAPTER=api|bing forces a backend
 *   - first-party Anthropic endpoint → API server-side search
 *   - otherwise                      → Bing scrape fallback
 */

import Anthropic from "@anthropic-ai/sdk";
import he from "he";
import { getAnthropicClientForProfile } from "../../services/api/client.js";
import { resolveProfile } from "../../services/api/providers/profile.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface SearchOptions {
  allowedDomains?: string[];
  blockedDomains?: string[];
  signal?: AbortSignal;
  maxResults?: number;
}

export interface WebSearchAdapter {
  readonly name: string;
  search(query: string, options: SearchOptions): Promise<SearchResult[]>;
}

const DEFAULT_MAX_RESULTS = 10;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Apply allowed/blocked domain filters to a result list. */
export function filterByDomains(results: SearchResult[], options: SearchOptions): SearchResult[] {
  const allowed = options.allowedDomains?.map((d) => d.toLowerCase());
  const blocked = options.blockedDomains?.map((d) => d.toLowerCase());
  return results.filter((r) => {
    const host = hostOf(r.url);
    if (!host) return false;
    if (allowed && allowed.length > 0) {
      if (!allowed.some((d) => host === d || host.endsWith(`.${d}`))) return false;
    }
    if (blocked && blocked.length > 0) {
      if (blocked.some((d) => host === d || host.endsWith(`.${d}`))) return false;
    }
    return true;
  });
}

// ─── Anthropic server-side search (default) ──────────────────────────────
//
// Mirrors ApiSearchAdapter: a secondary message that attaches the
// `web_search_20250305` server tool. The model performs the search server-side
// and the response carries `web_search_tool_result` blocks we read back.

export class AnthropicApiSearchAdapter implements WebSearchAdapter {
  readonly name = "anthropic";
  constructor(private readonly modelHandle?: string) {}

  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const profile = await resolveProfile(this.modelHandle ?? "");
    const client = getAnthropicClientForProfile(profile);

    const webSearchTool = {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 5,
      ...(options.allowedDomains?.length ? { allowed_domains: options.allowedDomains } : {}),
      ...(options.blockedDomains?.length ? { blocked_domains: options.blockedDomains } : {}),
    };

    const response = await client.messages.create(
      {
        model: profile.model,
        max_tokens: 2048,
        system: "You are an assistant performing a web search. Use the web_search tool to answer the query.",
        messages: [{ role: "user", content: `Perform a web search for the query: ${query}` }],
        tools: [webSearchTool] as unknown as Anthropic.MessageCreateParamsNonStreaming["tools"],
      },
      options.signal ? { signal: options.signal } : undefined,
    );

    const results: SearchResult[] = [];
    for (const block of response.content as Array<{ type: string; content?: unknown }>) {
      if (block.type !== "web_search_tool_result" || !Array.isArray(block.content)) continue;
      for (const r of block.content as Array<{ type?: string; title?: string; url?: string }>) {
        if (r.type === "web_search_result" && r.url) {
          results.push({ title: r.title ?? r.url, url: r.url });
        }
      }
    }
    return filterByDomains(results, options);
  }
}

// ─── Bing scrape (fallback, no key) ──────────────────────────────────────
//
// Mirrors BingSearchAdapter: fetch the Bing results page with browser-like
// headers and extract organic results via regex on the `b_algo` blocks.

const BING_TIMEOUT_MS = 30_000;
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

export class BingSearchAdapter implements WebSearchAdapter {
  readonly name = "bing";

  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setmkt=en-US`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BING_TIMEOUT_MS);
    options.signal?.addEventListener("abort", () => controller.abort(), { once: true });

    let html: string;
    try {
      const response = await fetch(url, { headers: BROWSER_HEADERS, signal: controller.signal });
      if (!response.ok) throw new Error(`Bing returned ${response.status} ${response.statusText}`);
      html = await response.text();
    } finally {
      clearTimeout(timer);
    }

    return filterByDomains(extractBingResults(html), options);
  }
}

export function extractBingResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const algoBlockRegex = /<li\s+class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = algoBlockRegex.exec(html)) !== null) {
    const block = blockMatch[1];
    const linkMatch = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!linkMatch) continue;
    const url = resolveBingUrl(he.decode(linkMatch[1]));
    if (!url) continue;
    const title = he.decode(linkMatch[2].replace(/<[^>]+>/g, "").trim());
    const snippet = extractBingSnippet(block);
    results.push({ title, url, snippet });
  }
  return results;
}

function extractBingSnippet(block: string): string | undefined {
  const lineclamp = /<p[^>]*class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block);
  if (lineclamp) return he.decode(lineclamp[1].replace(/<[^>]+>/g, "").trim());
  const captionP = /<div[^>]*class="b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
  if (captionP) return he.decode(captionP[1].replace(/<[^>]+>/g, "").trim());
  return undefined;
}

/**
 * Resolve a Bing redirect URL (bing.com/ck/a?...&u=a1<base64>) to its target,
 * or return undefined for Bing-internal / relative links.
 */
export function resolveBingUrl(rawUrl: string): string | undefined {
  if (rawUrl.startsWith("/") || rawUrl.startsWith("#")) return undefined;
  const uMatch = rawUrl.match(/[?&]u=([a-zA-Z0-9+/_=-]+)/);
  if (uMatch && uMatch[1].length >= 3) {
    const b64 = uMatch[1].slice(2).replace(/-/g, "+").replace(/_/g, "/");
    try {
      const decoded = Buffer.from(b64, "base64").toString("utf-8");
      if (decoded.startsWith("http")) return decoded;
    } catch {
      // not a valid base64 redirect
    }
  }
  if (!rawUrl.includes("bing.com")) return rawUrl;
  return undefined;
}

// ─── Adapter selection ───────────────────────────────────────────────────

function isFirstPartyAnthropic(baseURL: string | undefined): boolean {
  const url = baseURL ?? process.env.ANTHROPIC_BASE_URL ?? "";
  if (!url) return true; // default endpoint is api.anthropic.com
  try {
    return new URL(url).hostname.endsWith("anthropic.com");
  } catch {
    return false;
  }
}

/**
 * Select a search adapter. `modelHandle` is the active model (so the API
 * adapter rides on the user's configured profile/endpoint). Always returns a
 * usable adapter — no external key required.
 */
export async function createAdapter(modelHandle?: string): Promise<WebSearchAdapter> {
  const override = process.env.WEB_SEARCH_ADAPTER;
  if (override === "bing") return new BingSearchAdapter();
  if (override === "api") return new AnthropicApiSearchAdapter(modelHandle);

  if (modelHandle) {
    try {
      const profile = await resolveProfile(modelHandle);
      if (profile.protocol === "anthropic" && isFirstPartyAnthropic(profile.baseURL)) {
        return new AnthropicApiSearchAdapter(modelHandle);
      }
    } catch {
      // fall through to Bing
    }
  }
  return new BingSearchAdapter();
}

export { DEFAULT_MAX_RESULTS };
