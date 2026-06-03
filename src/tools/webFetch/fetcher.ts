/**
 * WebFetch HTTP layer: controlled fetch + same-host redirect following +
 * HTML→markdown conversion.
 *
 * Reference: claude-code-source-code/src/tools/WebFetchTool/utils.ts
 * (`getWithPermittedRedirects`, `isPermittedRedirect`, `getURLMarkdownContent`).
 * We use the platform `fetch` (Node 18+) with manual redirect handling instead
 * of axios, and `turndown` for HTML→markdown (same library the reference uses).
 */

import TurndownService from "turndown";
import { validateFetchUrl } from "./urlValidation.js";

const FETCH_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 10;
const MAX_CONTENT_BYTES = 10 * 1024 * 1024; // 10MB
export const MAX_MARKDOWN_LENGTH = 100_000;

export interface FetchedContent {
  type: "content";
  content: string;
  contentType: string;
  status: number;
  statusText: string;
  bytes: number;
  /** True when the body was HTML that we converted to markdown. */
  converted: boolean;
}

export interface RedirectInfo {
  type: "redirect";
  originalUrl: string;
  redirectUrl: string;
  statusCode: number;
}

export type FetchResult = FetchedContent | RedirectInfo;

// Lazy singleton — Turndown construction builds ~15 rule objects; reuse it.
let turndown: TurndownService | undefined;
function getTurndown(): TurndownService {
  if (!turndown) {
    turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
    // Drop noise that bloats the markdown and wastes tokens.
    turndown.remove(["script", "style", "noscript"] as unknown as TurndownService.Filter);
  }
  return turndown;
}

/**
 * Whether a redirect is safe to auto-follow: same protocol/port, no embedded
 * credentials, and same host modulo a leading "www.".
 */
export function isPermittedRedirect(originalUrl: string, redirectUrl: string): boolean {
  try {
    const a = new URL(originalUrl);
    const b = new URL(redirectUrl);
    if (a.protocol !== b.protocol) return false;
    if (a.port !== b.port) return false;
    if (b.username || b.password) return false;
    const strip = (h: string) => h.replace(/^www\./, "");
    return strip(a.hostname) === strip(b.hostname);
  } catch {
    return false;
  }
}

function isBinaryContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.startsWith("text/")) return false;
  if (ct.includes("json") || ct.includes("xml") || ct.includes("markdown")) return false;
  if (ct.includes("html")) return false;
  return true;
}

/**
 * Fetch a URL, following only permitted (same-host) redirects. Cross-host
 * redirects are returned as `RedirectInfo` so the model can re-issue WebFetch
 * with the new URL (and re-clear the domain permission).
 */
export async function fetchUrlContent(
  url: string,
  signal?: AbortSignal,
  depth = 0,
): Promise<FetchResult> {
  if (depth > MAX_REDIRECTS) {
    throw new Error(`Too many redirects (exceeded ${MAX_REDIRECTS})`);
  }

  // Re-validate at every hop — a redirect target must also pass SSRF checks.
  const validation = validateFetchUrl(url);
  if (!validation.ok) {
    throw new Error(validation.reason ?? "Invalid URL");
  }

  // Upgrade http → https.
  let target = url;
  const parsed = new URL(url);
  if (parsed.protocol === "http:") {
    parsed.protocol = "https:";
    target = parsed.toString();
  }

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), FETCH_TIMEOUT_MS);
  const linkedAbort = () => timeout.abort();
  signal?.addEventListener("abort", linkedAbort, { once: true });

  let response: Response;
  try {
    response = await fetch(target, {
      method: "GET",
      redirect: "manual",
      signal: timeout.signal,
      headers: {
        Accept: "text/markdown, text/html, */*",
        "User-Agent": "easy-agent/0.1 (+https://github.com/easy-agent) WebFetch",
      },
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", linkedAbort);
  }

  // Manual redirect handling.
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    if (!location) {
      throw new Error("Redirect response missing Location header");
    }
    const redirectUrl = new URL(location, target).toString();
    if (isPermittedRedirect(target, redirectUrl)) {
      return fetchUrlContent(redirectUrl, signal, depth + 1);
    }
    return {
      type: "redirect",
      originalUrl: target,
      redirectUrl,
      statusCode: response.status,
    };
  }

  const contentType = response.headers.get("content-type") ?? "";

  const buffer = Buffer.from(await response.arrayBuffer());
  const bytes = buffer.length;
  if (bytes > MAX_CONTENT_BYTES) {
    throw new Error(`Response too large (${bytes} bytes, limit ${MAX_CONTENT_BYTES})`);
  }

  if (isBinaryContentType(contentType)) {
    // Multimodal/binary persistence lands in a later stage; for now report it.
    return {
      type: "content",
      content: `[Binary content: ${contentType || "unknown"}, ${bytes} bytes — not rendered as text]`,
      contentType,
      status: response.status,
      statusText: response.statusText,
      bytes,
      converted: false,
    };
  }

  const raw = buffer.toString("utf-8");
  let content = raw;
  let converted = false;
  if (contentType.includes("text/html")) {
    content = getTurndown().turndown(raw);
    converted = true;
  }

  return {
    type: "content",
    content,
    contentType,
    status: response.status,
    statusText: response.statusText,
    bytes,
    converted,
  };
}
