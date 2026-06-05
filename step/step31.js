/**
 * Step 31 - Core tool expansion
 *
 * Goal:
 * - add WebFetch and WebSearch as read-side web access
 * - add Edit replace_all and MultiEdit for batch edits
 * - add MCP resource listing/reading
 * - register PowerShell only on Windows
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// -----------------------------------------------------------------------------
// 1. Edit replace_all and MultiEdit
// -----------------------------------------------------------------------------

export class EditError extends Error {
  constructor(message, index) {
    super(message);
    this.name = "EditError";
    this.index = index;
  }
}

export function applyOneEdit(content, edit, index = 1) {
  const oldText = String(edit.old_string ?? "");
  const newText = String(edit.new_string ?? "");
  if (!oldText) throw new EditError(`edit #${index}: old_string is required`, index);

  const matches = content.split(oldText).length - 1;
  if (matches === 0) throw new EditError(`edit #${index}: old_string not found`, index);
  if (!edit.replace_all && matches !== 1) {
    throw new EditError(`edit #${index}: old_string appears ${matches} times; use replace_all`, index);
  }

  const next = edit.replace_all
    ? content.split(oldText).join(newText)
    : content.replace(oldText, newText);
  return { content: next, replacements: edit.replace_all ? matches : 1 };
}

export function applyEditsToContent(content, edits) {
  let next = String(content);
  let replacements = 0;
  edits.forEach((edit, i) => {
    const result = applyOneEdit(next, edit, i + 1);
    next = result.content;
    replacements += result.replacements;
  });
  return { content: next, replacements };
}

export async function multiEditFile(filePath, edits) {
  const before = await fs.readFile(filePath, "utf8");
  const result = applyEditsToContent(before, edits);
  await fs.writeFile(filePath, result.content, "utf8");
  return { ok: true, replacements: result.replacements };
}

// -----------------------------------------------------------------------------
// 2. WebFetch URL safety and domain permission
// -----------------------------------------------------------------------------

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^\[?::1\]?$/,
  /metadata/i,
];

const PREAPPROVED_HOSTS = [
  "docs.anthropic.com",
  "docs.github.com",
  "developer.mozilla.org",
  "nodejs.org",
  "react.dev",
  "modelcontextprotocol.io",
];

export function validateFetchUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }

  if (!["http:", "https:"].includes(url.protocol)) return { ok: false, reason: "only http/https URLs are allowed" };
  if (url.username || url.password) return { ok: false, reason: "embedded credentials are not allowed" };
  if (!url.hostname.includes(".") && !/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) {
    return { ok: false, reason: "host must be public" };
  }
  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(url.hostname))) {
    return { ok: false, reason: "private, local, or metadata addresses are blocked" };
  }
  return { ok: true, url };
}

export function hostMatchesDomain(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

export function isPreapprovedUrl(rawUrl) {
  const valid = validateFetchUrl(rawUrl);
  if (!valid.ok) return false;
  return PREAPPROVED_HOSTS.some((host) => hostMatchesDomain(valid.url.hostname, host));
}

export function webFetchRuleForUrl(rawUrl) {
  const valid = validateFetchUrl(rawUrl);
  if (!valid.ok) return null;
  return `WebFetch(domain:${valid.url.hostname})`;
}

export function matchesWebFetchRule(rule, rawUrl) {
  const match = String(rule).match(/^WebFetch\(domain:([^)]+)\)$/);
  const valid = validateFetchUrl(rawUrl);
  if (!match || !valid.ok) return false;
  return hostMatchesDomain(valid.url.hostname, match[1]);
}

export async function webFetch({ url, prompt }, fetcher, summarize) {
  const valid = validateFetchUrl(url);
  if (!valid.ok) return { isError: true, content: `WebFetch blocked: ${valid.reason}` };

  const fetched = await fetcher(valid.url.href);
  const markdown = htmlToMarkdown(fetched.body || "");
  const clipped = markdown.length > 20_000 ? `${markdown.slice(0, 20_000)}\n[truncated]` : markdown;
  const answer = summarize ? await summarize(prompt, clipped) : clipped;
  return { content: `WebFetch ${valid.url.href}\n\n${answer}` };
}

function htmlToMarkdown(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<h1[^>]*>(.*?)<\/h1>/gi, "# $1\n\n")
    .replace(/<h2[^>]*>(.*?)<\/h2>/gi, "## $1\n\n")
    .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, "[$2]($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function webSearch({ query, allowed_domains = [], blocked_domains = [] }, adapter) {
  if (!query || query.trim().length < 2) return { isError: true, content: "WebSearch query is too short." };
  if (!adapter) return { isError: true, content: "WebSearch is not configured. Set WEB_SEARCH_API_KEY." };

  const results = adapter.search(query).filter((result) => {
    const host = new URL(result.url).hostname;
    if (blocked_domains.some((domain) => hostMatchesDomain(host, domain))) return false;
    if (allowed_domains.length && !allowed_domains.some((domain) => hostMatchesDomain(host, domain))) return false;
    return true;
  });

  return {
    content: results.map((r, i) => `${i + 1}. [${r.title}](${r.url}) - ${r.snippet}`).join("\n") || "No results.",
  };
}

// -----------------------------------------------------------------------------
// 3. MCP resources
// -----------------------------------------------------------------------------

export async function listMcpResources(registry, server) {
  const clients = server ? [[server, registry.get(server)]] : [...registry.entries()];
  const resources = [];
  for (const [name, client] of clients) {
    if (!client) continue;
    const listed = await client.listResources();
    for (const resource of listed.resources || []) resources.push({ ...resource, server: name });
  }
  return resources;
}

export async function readMcpResource(registry, server, uri) {
  const client = registry.get(server);
  if (!client) return { isError: true, content: `MCP server "${server}" is not connected.` };
  const result = await client.readResource({ uri });
  const parts = result.contents || [];
  return {
    content: parts
      .map((part) => {
        if (part.text) return part.text;
        if (part.blob) return `[binary resource: ${part.mimeType || "application/octet-stream"}]`;
        return "";
      })
      .join("\n"),
  };
}

// -----------------------------------------------------------------------------
// 4. PowerShell registration
// -----------------------------------------------------------------------------

export const powerShellTool = {
  name: "PowerShell",
  isEnabled(platform = process.platform) {
    return platform === "win32";
  },
  async call(input, runner) {
    if (!this.isEnabled()) return { isError: true, content: "PowerShell is only available on Windows." };
    return runner(input.command, { shell: "powershell.exe" });
  },
};

export function getCoreTools(platform = process.platform) {
  const tools = [
    { name: "WebFetch", isReadOnly: true },
    { name: "WebSearch", isReadOnly: true },
    { name: "MultiEdit", isReadOnly: false },
    { name: "ListMcpResources", isReadOnly: true },
    { name: "ReadMcpResource", isReadOnly: true },
  ];
  if (powerShellTool.isEnabled(platform)) tools.push({ name: "PowerShell", isReadOnly: false });
  return tools;
}

// -----------------------------------------------------------------------------
// 5. Permission shape
// -----------------------------------------------------------------------------

export function checkWebFetchPermission(url, settings = { allow: [], deny: [] }) {
  if (settings.deny?.some((rule) => matchesWebFetchRule(rule, url))) return { behavior: "deny" };
  if (isPreapprovedUrl(url)) return { behavior: "allow" };
  if (settings.allow?.some((rule) => matchesWebFetchRule(rule, url))) return { behavior: "allow" };
  return { behavior: "ask", suggestedRule: webFetchRuleForUrl(url) };
}

export function isPlanModeAllowed(tool) {
  if (tool.name === "WebFetch") return false;
  return tool.isReadOnly === true;
}

// -----------------------------------------------------------------------------
// 6. Demo
// -----------------------------------------------------------------------------

export async function demoStep31() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "easy-agent-step31-"));
  const file = path.join(dir, "sample.txt");
  await fs.writeFile(file, "foo foo\nbar\n", "utf8");
  await multiEditFile(file, [
    { old_string: "foo", new_string: "baz", replace_all: true },
    { old_string: "bar", new_string: "done" },
  ]);

  const registry = new Map([
    [
      "docs",
      {
        async listResources() {
          return { resources: [{ uri: "schema://users", name: "Users schema", mimeType: "text/plain" }] };
        },
        async readResource() {
          return { contents: [{ text: "users(id, name)" }] };
        },
      },
    ],
  ]);

  const adapter = {
    search() {
      return [
        { title: "React docs", url: "https://react.dev/learn", snippet: "Learn React" },
        { title: "Other", url: "https://example.com/x", snippet: "Example" },
      ];
    },
  };

  return {
    edited: await fs.readFile(file, "utf8"),
    urlSafe: validateFetchUrl("https://react.dev/learn").ok,
    urlBlocked: validateFetchUrl("http://localhost:3000").ok,
    permission: checkWebFetchPermission("https://react.dev/learn"),
    search: webSearch({ query: "react", allowed_domains: ["react.dev"] }, adapter).content,
    resources: await listMcpResources(registry),
    resourceContent: await readMcpResource(registry, "docs", "schema://users"),
    toolsOnMac: getCoreTools("darwin").map((tool) => tool.name),
    toolsOnWindows: getCoreTools("win32").map((tool) => tool.name),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await demoStep31(), null, 2));
}
