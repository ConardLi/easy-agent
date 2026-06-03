#!/usr/bin/env tsx
/**
 * Stage 31 verification — core tool补全 (Web + MultiEdit + MCP resources +
 * PowerShell). Exercises the mechanical logic WITHOUT hitting the network or
 * the LLM (those are interactive / manual checks):
 *
 *   - Edit replace_all + unique-match safety
 *   - MultiEdit atomicity / chaining / rollback-on-failure
 *   - WebFetch URL validation (SSRF: localhost / metadata / private IPs)
 *   - WebFetch preapproved hosts
 *   - WebFetch domain permission (preapproved/allow/deny/ask, subdomains)
 *   - Plan-mode read-only allowance for WebSearch / MCP-resource tools
 *   - WebSearch graceful degradation when no provider key is set
 *   - MCP resource tools with no connected servers
 *   - PowerShell Windows-gating
 *   - Tool registry wiring
 *
 * Optional live fetch: run with `LIVE=1` to additionally fetch a real page.
 *
 * Usage:  cd easy-agent && npx tsx src/scripts/test-stage31.ts
 * Exits non-zero on any assertion failure.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { fileEditTool } from "../tools/fileEditTool.js";
import { multiEditTool } from "../tools/multiEditTool.js";
import { applyEditsToContent, EditError } from "../tools/editCore.js";
import { webFetchTool } from "../tools/webFetchTool.js";
import { webSearchTool } from "../tools/webSearchTool.js";
import { listMcpResourcesTool } from "../tools/listMcpResourcesTool.js";
import { readMcpResourceTool } from "../tools/readMcpResourceTool.js";
import { powerShellTool } from "../tools/powerShellTool.js";
import { validateFetchUrl } from "../tools/webFetch/urlValidation.js";
import { isPreapprovedUrl } from "../tools/webFetch/preapproved.js";
import {
  createAdapter,
  extractBingResults,
  filterByDomains,
  resolveBingUrl,
} from "../tools/webSearch/adapters.js";
import { getAllTools } from "../tools/index.js";
import {
  checkPermission,
  matchesPermissionRule,
  buildPermissionRuleHint,
  type PermissionSettings,
} from "../permissions/permissions.js";

const failures: string[] = [];
function assert(condition: unknown, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`);
    failures.push(label);
  }
}

const ctx = { cwd: process.cwd() };
const settings = (over: Partial<PermissionSettings> = {}): PermissionSettings => ({
  allow: [],
  deny: [],
  mode: "default",
  ...over,
});

// The file tools restrict writes to within cwd, so the temp dir IS the cwd.
async function withTempFile(
  contents: string,
  fn: (file: string, cwd: string) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "easy-agent-stage31-"));
  const file = path.join(dir, "sample.txt");
  await fs.writeFile(file, contents, "utf-8");
  try {
    await fn(file, dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log("\n[1] Edit replace_all + unique-match safety");
  await withTempFile("foo foo foo", async (file, cwd) => {
    const dup = await fileEditTool.call({ file_path: file, old_string: "foo", new_string: "bar" }, { cwd });
    assert(dup.isError === true, "Edit without replace_all rejects a non-unique match");

    const all = await fileEditTool.call(
      { file_path: file, old_string: "foo", new_string: "bar", replace_all: true },
      { cwd },
    );
    assert(!all.isError && (await fs.readFile(file, "utf-8")) === "bar bar bar", "Edit replace_all replaces every occurrence");
    assert(all.content.includes("3 occurrences"), "Edit replace_all reports the count");
  });
  await withTempFile("alpha beta", async (file, cwd) => {
    const one = await fileEditTool.call({ file_path: file, old_string: "alpha", new_string: "ALPHA" }, { cwd });
    assert(!one.isError && (await fs.readFile(file, "utf-8")) === "ALPHA beta", "Edit unique match still works");
  });

  console.log("\n[2] MultiEdit atomicity / chaining / rollback");
  await withTempFile("let a = 1;\nlet b = 2;\n", async (file, cwd) => {
    const ok = await multiEditTool.call(
      {
        file_path: file,
        edits: [
          { old_string: "let a = 1;", new_string: "const a = 10;" },
          { old_string: "let b = 2;", new_string: "const b = 20;" },
        ],
      },
      { cwd },
    );
    const after = await fs.readFile(file, "utf-8");
    assert(!ok.isError && after === "const a = 10;\nconst b = 20;\n", "MultiEdit applies all edits in order");
  });
  // chaining: edit #2 matches the result of edit #1
  {
    const chained = applyEditsToContent("x", [
      { old_string: "x", new_string: "xy" },
      { old_string: "xy", new_string: "xyz" },
    ]);
    assert(chained.content === "xyz", "MultiEdit edits chain (later edit sees earlier result)");
  }
  // rollback: a failing edit leaves the file untouched
  await withTempFile("keep me\n", async (file, cwd) => {
    const fail = await multiEditTool.call(
      {
        file_path: file,
        edits: [
          { old_string: "keep me", new_string: "changed" },
          { old_string: "DOES NOT EXIST", new_string: "nope" },
        ],
      },
      { cwd },
    );
    const after = await fs.readFile(file, "utf-8");
    assert(fail.isError === true && after === "keep me\n", "MultiEdit is atomic: a failing edit writes nothing");
    assert(fail.content.includes("edit #2"), "MultiEdit names the failing edit index");
  });
  {
    let threw = false;
    try {
      applyEditsToContent("a", [{ old_string: "zzz", new_string: "x" }]);
    } catch (e) {
      threw = e instanceof EditError;
    }
    assert(threw, "applyEditsToContent throws EditError on no-match");
  }

  console.log("\n[3] WebFetch URL validation (SSRF guard)");
  const blocked = [
    "http://localhost/x",
    "http://127.0.0.1/x",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://[::1]/",
    "http://metadata.internal/",
    "ftp://example.com/x",
    "https://user:pass@example.com/x",
    "http://notld/",
  ];
  for (const u of blocked) {
    assert(validateFetchUrl(u).ok === false, `blocks unsafe URL: ${u}`);
  }
  const allowed = ["https://example.com/docs", "http://react.dev/learn", "https://8.8.8.8/"];
  for (const u of allowed) {
    assert(validateFetchUrl(u).ok === true, `allows public URL: ${u}`);
  }

  console.log("\n[4] WebFetch preapproved hosts");
  assert(isPreapprovedUrl("https://react.dev/learn") === true, "react.dev is preapproved");
  assert(isPreapprovedUrl("https://docs.python.org/3/") === true, "docs.python.org is preapproved");
  assert(isPreapprovedUrl("https://github.com/anthropics/x") === true, "github.com/anthropics path is preapproved");
  assert(isPreapprovedUrl("https://github.com/someoneelse") === false, "other github paths are NOT preapproved");
  assert(isPreapprovedUrl("https://random-blog.example/") === false, "random host is not preapproved");

  console.log("\n[5] WebFetch domain permission rules");
  assert(
    matchesPermissionRule("WebFetch(domain:example.com)", "WebFetch", { url: "https://example.com/x" }),
    "WebFetch(domain:example.com) matches example.com",
  );
  assert(
    matchesPermissionRule("WebFetch(domain:example.com)", "WebFetch", { url: "https://docs.example.com/x" }),
    "WebFetch domain rule matches subdomains",
  );
  assert(
    !matchesPermissionRule("WebFetch(domain:example.com)", "WebFetch", { url: "https://evil.com/x" }),
    "WebFetch domain rule does not match a different host",
  );
  assert(
    buildPermissionRuleHint("WebFetch", { url: "https://docs.example.com/a" }) === "WebFetch(domain:docs.example.com)",
    "buildPermissionRuleHint produces WebFetch(domain:host)",
  );

  console.log("\n[6] WebFetch checkPermission pipeline");
  const ask = await checkPermission({
    tool: webFetchTool,
    input: { url: "https://random-blog.example/", prompt: "x" },
    cwd: ctx.cwd,
    settings: settings(),
  });
  assert(ask.behavior === "ask", "unknown domain → ask");

  const pre = await checkPermission({
    tool: webFetchTool,
    input: { url: "https://react.dev/learn", prompt: "x" },
    cwd: ctx.cwd,
    settings: settings(),
  });
  assert(pre.behavior === "allow", "preapproved host → allow (no prompt)");

  const allowRule = await checkPermission({
    tool: webFetchTool,
    input: { url: "https://example.com/x", prompt: "x" },
    cwd: ctx.cwd,
    settings: settings({ allow: ["WebFetch(domain:example.com)"] }),
  });
  assert(allowRule.behavior === "allow", "domain allow rule → allow (second visit after 'always')");

  const denyRule = await checkPermission({
    tool: webFetchTool,
    input: { url: "https://evil.com/x", prompt: "x" },
    cwd: ctx.cwd,
    settings: settings({ deny: ["WebFetch(domain:evil.com)"] }),
  });
  assert(denyRule.behavior === "deny", "domain deny rule → deny");

  console.log("\n[7] Plan-mode read-only allowance");
  const planSearch = await checkPermission({
    tool: webSearchTool,
    input: { query: "typescript" },
    cwd: ctx.cwd,
    mode: "plan",
    settings: settings({ mode: "plan" }),
  });
  assert(planSearch.behavior === "allow", "WebSearch (read-only) allowed in plan mode");
  const planList = await checkPermission({
    tool: listMcpResourcesTool,
    input: {},
    cwd: ctx.cwd,
    mode: "plan",
    settings: settings({ mode: "plan" }),
  });
  assert(planList.behavior === "allow", "ListMcpResources (read-only) allowed in plan mode");
  const planFetch = await checkPermission({
    tool: webFetchTool,
    input: { url: "https://random-blog.example/", prompt: "x" },
    cwd: ctx.cwd,
    mode: "plan",
    settings: settings({ mode: "plan" }),
  });
  assert(planFetch.behavior === "ask", "WebFetch still gates by domain in plan mode (unknown → ask)");
  const planEdit = await checkPermission({
    tool: multiEditTool,
    input: { file_path: "x", edits: [] },
    cwd: ctx.cwd,
    mode: "plan",
    settings: settings({ mode: "plan" }),
  });
  assert(planEdit.behavior === "deny", "MultiEdit (writes) denied in plan mode");

  console.log("\n[8] WebSearch adapters (keyless: Anthropic API + Bing) + filtering");
  const shortQuery = await webSearchTool.call({ query: "x" }, ctx);
  assert(shortQuery.isError === true, "WebSearch rejects <2 char query");

  const filtered = filterByDomains(
    [
      { title: "a", url: "https://docs.example.com/a" },
      { title: "b", url: "https://other.com/b" },
    ],
    { allowedDomains: ["example.com"] },
  );
  assert(filtered.length === 1 && filtered[0].url.includes("example.com"), "filterByDomains honors allowedDomains (with subdomain)");

  // Bing HTML parsing (offline — the source's keyless fallback path).
  const sampleHtml =
    '<ol id="b_results"><li class="b_algo"><h2><a href="https://docs.python.org/3/">Python &amp; Docs</a></h2>' +
    '<div class="b_caption"><p class="b_lineclamp2">The official <b>Python</b> documentation.</p></div></li></ol>';
  const bing = extractBingResults(sampleHtml);
  assert(bing.length === 1 && bing[0].url === "https://docs.python.org/3/", "extractBingResults parses organic result URL");
  assert(bing[0].title === "Python & Docs", "extractBingResults decodes HTML entities in title");
  assert(bing[0].snippet?.includes("official Python documentation"), "extractBingResults extracts the snippet");

  const directUrl = resolveBingUrl("https://example.com/page");
  assert(directUrl === "https://example.com/page", "resolveBingUrl passes through a direct external URL");
  const redirect = resolveBingUrl(
    "https://www.bing.com/ck/a?u=a1" + Buffer.from("https://example.org/x").toString("base64"),
  );
  assert(redirect === "https://example.org/x", "resolveBingUrl decodes a Bing base64 redirect");

  // Adapter selection (no network — just which class is chosen).
  const savedOverride = process.env.WEB_SEARCH_ADAPTER;
  process.env.WEB_SEARCH_ADAPTER = "bing";
  assert((await createAdapter("anything")).name === "bing", "WEB_SEARCH_ADAPTER=bing forces Bing");
  process.env.WEB_SEARCH_ADAPTER = "api";
  assert((await createAdapter("claude-x")).name === "anthropic", "WEB_SEARCH_ADAPTER=api forces Anthropic server-side search");
  delete process.env.WEB_SEARCH_ADAPTER;
  if (savedOverride) process.env.WEB_SEARCH_ADAPTER = savedOverride;

  console.log("\n[9] MCP resource tools with no connected servers");
  const list = await listMcpResourcesTool.call({}, ctx);
  assert(!list.isError && list.content.includes("No MCP resources"), "ListMcpResources: friendly message when no servers");
  const read = await readMcpResourceTool.call({ server: "nope", uri: "x://y" }, ctx);
  assert(read.isError === true && read.content.includes("not connected"), "ReadMcpResource: errors clearly when server missing");

  console.log("\n[10] PowerShell Windows-gating + tool registry");
  assert(powerShellTool.isEnabled() === (process.platform === "win32"), "PowerShell only enabled on Windows");
  // WebFetch must serialize: its per-domain "ask" prompt would deadlock the
  // single-flight permission UI if two ran concurrently.
  assert(webFetchTool.isConcurrencySafe?.() === false, "WebFetch is NOT concurrency-safe (serializes permission prompts)");
  const names = new Set(getAllTools().map((t) => t.name));
  for (const n of ["MultiEdit", "WebFetch", "WebSearch", "ListMcpResources", "ReadMcpResource"]) {
    assert(names.has(n), `tool registry includes ${n}`);
  }
  assert(names.has("PowerShell") === (process.platform === "win32"), "PowerShell registered iff Windows");

  console.log("\n[11] Optional live fetch (set LIVE=1)");
  if (process.env.LIVE === "1") {
    const live = await webFetchTool.call(
      { url: "https://example.com/", prompt: "What is the title of this page?" },
      { cwd: ctx.cwd, defaultModel: process.env.ANTHROPIC_MODEL },
    );
    assert(!live.isError && live.content.length > 0, "live WebFetch returns content");
    console.log("    live result preview:", live.content.slice(0, 160).replace(/\n/g, " "));
  } else {
    console.log("  · skipped (set LIVE=1 to fetch a real page)");
  }

  console.log("");
  if (failures.length > 0) {
    console.error(`FAILED: ${failures.length} assertion(s)`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("All Stage 31 checks passed ✅");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
