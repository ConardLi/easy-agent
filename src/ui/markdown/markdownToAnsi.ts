/**
 * Markdown → ANSI string conversion for terminal rendering.
 *
 * The conversation used to render AI replies as raw `<Text>`, so headings,
 * lists, bold, links and code blocks all came through as plain characters.
 * Here we turn a Markdown string into an ANSI-styled string that Ink's
 * `<Text>` passes straight through to the terminal.
 *
 * Two performance designs:
 *
 *   1. `hasMarkdownSyntax()` — a cheap fast path. Most streamed chunks are
 *      plain prose; sampling the first ~500 chars for Markdown markers lets
 *      us skip the `marked` lexer entirely when there's nothing to format.
 *
 *   2. An LRU cache keyed by content — re-rendering the same finalized block
 *      (e.g. while scrolling back) reuses the previous ANSI string instead of
 *      re-lexing. Bounded at MAX_CACHE_ENTRIES with MRU promotion.
 *
 * We deliberately cover the common token set (headings, paragraphs, lists,
 * code, blockquote, hr, inline strong/em/code/link, tables) rather than the
 * full CommonMark surface — enough to make agent output readable.
 */

import chalk from "chalk";
import { marked, type Token, type Tokens } from "marked";
import { highlightCode } from "./highlight.js";
import { theme } from "../theme.js";

// Brand-aligned chalk helpers (hex → ANSI). Defined as functions that call
// chalk at RENDER time, not module-load time: chalk bakes its open/close codes
// against the color level when a styler is constructed, and at import the
// terminal's truecolor support may not be detected yet (it would freeze the
// orange hex down to 16-color red). Calling lazily reads the same live level
// Ink uses, so headings stay truecolor orange instead of clashing red.
const c = {
  heading: (s: string) => chalk.hex(theme.mdHeading).bold(s),
  headingSub: (s: string) => chalk.hex(theme.mdHeadingSub).bold(s),
  bold: (s: string) => chalk.bold(s),
  inlineCode: (s: string) => chalk.hex(theme.mdInlineCode)(s),
  link: (s: string) => chalk.hex(theme.mdLink).underline(s),
  marker: (s: string) => chalk.hex(theme.mdHeadingSub)(s),
  quote: (s: string) => chalk.hex(theme.mdQuote)(s),
  rule: (s: string) => chalk.hex(theme.border)(s),
};

const MARKDOWN_SAMPLE = 500;
// Markers that indicate the text is worth running through the lexer.
const MARKDOWN_SIGNAL = /[`*_#>~|]|^\s*[-+]\s|\]\(|\d+\.\s|^\s{4,}\S/m;

/** Cheap check: is there any Markdown worth formatting in the first chunk? */
export function hasMarkdownSyntax(text: string): boolean {
  if (!text) return false;
  const sample = text.length > MARKDOWN_SAMPLE ? text.slice(0, MARKDOWN_SAMPLE) : text;
  return MARKDOWN_SIGNAL.test(sample);
}

// ─── LRU cache ────────────────────────────────────────────────────────
const MAX_CACHE_ENTRIES = 500;
const cache = new Map<string, string>();

function cacheGet(key: string): string | undefined {
  const hit = cache.get(key);
  if (hit !== undefined) {
    // MRU promotion: delete + re-set moves it to the end of the Map.
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

function cacheSet(key: string, value: string): void {
  cache.set(key, value);
  if (cache.size > MAX_CACHE_ENTRIES) {
    // Evict the least-recently-used entry (first key in insertion order).
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

// ─── Inline rendering ─────────────────────────────────────────────────

function renderInline(tokens: Token[] | undefined): string {
  if (!tokens) return "";
  let out = "";
  for (const token of tokens) {
    switch (token.type) {
      case "strong":
        out += chalk.bold(renderInline((token as Tokens.Strong).tokens));
        break;
      case "em":
        out += chalk.italic(renderInline((token as Tokens.Em).tokens));
        break;
      case "codespan":
        out += c.inlineCode((token as Tokens.Codespan).text);
        break;
      case "del":
        out += chalk.strikethrough(renderInline((token as Tokens.Del).tokens));
        break;
      case "link": {
        const link = token as Tokens.Link;
        const label = renderInline(link.tokens) || link.href;
        out += hyperlink(label, link.href);
        break;
      }
      case "br":
        out += "\n";
        break;
      case "text": {
        const t = token as Tokens.Text;
        // A text token may itself carry nested inline tokens.
        out += t.tokens ? renderInline(t.tokens) : t.text;
        break;
      }
      default: {
        const raw = (token as { text?: string }).text;
        if (typeof raw === "string") out += raw;
      }
    }
  }
  return out;
}

/** OSC 8 hyperlink — clickable in supporting terminals, label-only elsewhere. */
function hyperlink(label: string, href: string): string {
  const styled = c.link(label);
  if (!href || href === label) return styled;
  return `\u001B]8;;${href}\u0007${styled}\u001B]8;;\u0007`;
}

const HEADING_COLORS = [c.heading, c.heading, c.headingSub, c.bold, c.bold, c.bold];

// ─── Block rendering ──────────────────────────────────────────────────

function renderTokens(tokens: Token[], indent = ""): string {
  const parts: string[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case "heading": {
        const h = token as Tokens.Heading;
        const colorize = HEADING_COLORS[h.depth - 1] ?? chalk.bold;
        parts.push(indent + colorize(renderInline(h.tokens)));
        break;
      }
      case "paragraph": {
        const p = token as Tokens.Paragraph;
        parts.push(indentLines(renderInline(p.tokens), indent));
        break;
      }
      case "text": {
        const t = token as Tokens.Text & { tokens?: Token[] };
        parts.push(indentLines(t.tokens ? renderInline(t.tokens) : t.text, indent));
        break;
      }
      case "code": {
        const c = token as Tokens.Code;
        const highlighted = highlightCode(c.text, c.lang);
        parts.push(indentLines(highlighted, indent + "  "));
        break;
      }
      case "blockquote": {
        const bq = token as Tokens.Blockquote;
        const inner = renderTokens(bq.tokens, "");
        parts.push(indentLines(inner, indent + c.quote("│ ")));
        break;
      }
      case "list": {
        const list = token as Tokens.List;
        let n = typeof list.start === "number" ? list.start : 1;
        for (const item of list.items) {
          const marker = list.ordered ? `${n}. ` : "• ";
          n++;
          const body = renderTokens(item.tokens, "").trimEnd();
          const lines = body.split("\n");
          const first = `${indent}${c.marker(marker)}${lines[0] ?? ""}`;
          const rest = lines.slice(1).map((l) => `${indent}${" ".repeat(marker.length)}${l}`);
          parts.push([first, ...rest].join("\n"));
        }
        break;
      }
      case "table":
        parts.push(renderTable(token as Tokens.Table, indent));
        break;
      case "hr":
        parts.push(indent + c.rule("─".repeat(40)));
        break;
      case "space":
        break;
      default: {
        const raw = (token as { text?: string }).text;
        if (typeof raw === "string" && raw.trim()) parts.push(indentLines(raw, indent));
      }
    }
  }

  return parts.join("\n\n");
}

function renderTable(table: Tokens.Table, indent: string): string {
  const headerCells = table.header.map((c) => renderInline(c.tokens));
  const rows = table.rows.map((row) => row.map((c) => renderInline(c.tokens)));
  const colCount = headerCells.length;
  const widths = new Array<number>(colCount).fill(0);
  const visibleWidth = (s: string): number => stripAnsi(s).length;
  for (let i = 0; i < colCount; i++) {
    widths[i] = visibleWidth(headerCells[i] ?? "");
    for (const row of rows) widths[i] = Math.max(widths[i], visibleWidth(row[i] ?? ""));
  }
  const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - visibleWidth(s)));
  const formatRow = (cells: string[]): string =>
    indent + cells.map((cell, i) => pad(cell, widths[i] ?? 0)).join(c.quote("  │  "));
  const headerLine = formatRow(headerCells.map((cell) => chalk.bold(cell)));
  const sep = indent + widths.map((w) => c.quote("─".repeat(w))).join(c.quote("──┼──"));
  return [headerLine, sep, ...rows.map(formatRow)].join("\n");
}

function indentLines(text: string, indent: string): string {
  if (!indent) return text;
  return text
    .split("\n")
    .map((line) => indent + line)
    .join("\n");
}

const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, "");
}

/**
 * Convert a Markdown string to an ANSI-styled string. Returns the input
 * unchanged when it contains no Markdown (fast path). Results are cached.
 */
export function markdownToAnsi(content: string): string {
  if (!content) return "";
  if (!hasMarkdownSyntax(content)) return content;

  const cached = cacheGet(content);
  if (cached !== undefined) return cached;

  let rendered: string;
  try {
    const tokens = marked.lexer(content);
    rendered = renderTokens(tokens, "").trimEnd();
  } catch {
    // Never let a malformed token break the UI — fall back to raw text.
    rendered = content;
  }

  cacheSet(content, rendered);
  return rendered;
}
