/**
 * Request content comparison: `diffHarness(a, b, { prompt })`,
 * `eagent harness diff <a> <b> --prompt`, and RPC `runtime/diffHarness`.
 *
 * Golden: `default` against an Agent that leaves out four tools and a skill,
 * replaces the identity, and adds a prompt section, for one prompt; the text
 * view and the JSON. Normalized: the temp root, the part totals (the
 * environment section holds the temp path and the date), and the PowerShell
 * tool, which only Windows has (it is the same on both sides).
 *
 * Rendering sends nothing and runs nothing: the provider endpoint is a
 * tripwire that fails the test when it is reached, every `fetch` is counted,
 * and hooks that would write marker files for SessionStart,
 * UserPromptSubmit, PreToolUse, and Stop leave no file behind. The
 * runtime's open session keeps its Agent and tools while another Agent is
 * rendered. Without a prompt the result is the settings comparison as
 * before. A local command and an Agent that does not resolve are refused.
 *
 * That a rendering matches what a real session sends is checked against
 * real providers by scripts/verify-harness-diff-live.ts.
 *
 * Run:    node --import tsx src/scripts/test-harness-request-diff.ts
 * Update: node --import tsx src/scripts/test-harness-request-diff.ts --update
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const GOLDEN_PATH = path.join(import.meta.dirname, "__golden__", "harness-request-diff.golden.txt");
const PROMPT = "Review the change in src/app.ts";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "easy-agent-request-diff-")));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
const markers = path.join(root, "markers");
await Promise.all([
  mkdir(path.join(home, ".easy-agent", "skills", "release-notes"), { recursive: true }),
  mkdir(cwd, { recursive: true }),
  mkdir(markers, { recursive: true }),
]);
for (const key of Object.keys(process.env)) {
  if (
    /^(?:ANTHROPIC_|EASY_AGENT_|CLAUDE_CODE_|OPENAI_|GEMINI_)/.test(key) ||
    /TOOL_SEARCH|THINKING|WEB_SEARCH/.test(key)
  ) {
    delete process.env[key];
  }
}

// Any request reaching the endpoint fails the test.
let tripped = 0;
const tripwire = createServer((_request, response) => {
  tripped++;
  response.writeHead(500, { "content-type": "application/json" });
  response.end('{"type":"error","error":{"type":"api_error","message":"no request expected"}}');
});
await new Promise<void>((resolve) => tripwire.listen(0, "127.0.0.1", resolve));
const baseURL = `http://127.0.0.1:${(tripwire.address() as AddressInfo).port}`;

process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.ANTHROPIC_AUTH_TOKEN = "test-token";
process.env.ANTHROPIC_BASE_URL = baseURL;
process.env.ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
process.chdir(cwd);

let fetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...args: Parameters<typeof fetch>) => {
  fetches++;
  return realFetch(...args);
};

const marker = (name: string) => path.join(markers, name).replace(/\\/g, "/");
const hook = (name: string) => ({
  hooks: [{ type: "command", command: `node -e "require('fs').writeFileSync('${marker(name)}', 'ran')"` }],
});
const REVIEWER = {
  tools: { exclude: ["Write", "Edit", "MultiEdit", "WebFetch"] },
  skills: { exclude: ["release-notes"] },
  prompt: {
    identity: "You are a code reviewer. You read the change and report problems; you do not edit files.",
    sections: {
      "review-rules": { text: "Name the file and line of every problem.\nSay what to change.", after: "agent_md" },
    },
  },
};
await Promise.all([
  writeFile(
    path.join(home, ".easy-agent", "settings.json"),
    JSON.stringify({
      harnesses: { reviewer: REVIEWER },
      hooks: {
        SessionStart: [hook("session-start")],
        UserPromptSubmit: [hook("user-prompt-submit")],
        PreToolUse: [hook("pre-tool-use")],
        Stop: [hook("stop")],
      },
    }),
  ),
  writeFile(
    path.join(home, ".easy-agent", "skills", "release-notes", "SKILL.md"),
    "---\nname: release-notes\ndescription: Write release notes from the merged changes.\n---\nList the changes.\n",
  ),
  writeFile(path.join(cwd, "reviewer.json"), JSON.stringify(REVIEWER)),
]);

const { createAgentRuntime } = await import("../sdk/index.js");
const { isAgentSdkError } = await import("../sdk/errors.js");
const { formatHarnessDiff, formatRequestDiff } = await import("../harness/format.js");
const { runUserPromptSubmitHooks } = await import("../hooks/index.js");

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const runtime = await createAgentRuntime({ cwd, services: false, hardenPrivateData: false });
const session = await runtime.createSession({ persist: false, autoWake: false });
const toolsBefore = session.getToolNames();
const harnessBefore = (await runtime.getHarness()).hash;

console.log("Rendering");

const [diff, concurrentTools] = await Promise.all([
  runtime.diffHarness({}, { name: "reviewer" }, { prompt: PROMPT }),
  // The open session reads its tools while the other Agent renders.
  Promise.resolve().then(() => session.getToolNames()),
]);
const request = diff.request!;

await check("the provider was never reached and no fetch was made", () => {
  assert.equal(tripped, 0);
  assert.equal(fetches, 0);
});

await check("no hook ran while rendering, though the same hooks run outside it", async () => {
  for (const name of ["session-start", "user-prompt-submit", "pre-tool-use", "stop"]) {
    assert.equal(existsSync(path.join(markers, name)), false, `${name} hook ran`);
  }
  await runUserPromptSubmitHooks({ prompt: "x", cwd });
  assert.equal(existsSync(path.join(markers, "user-prompt-submit")), true, "the hook is configured and runs");
  await rm(path.join(markers, "user-prompt-submit"));
});

await check("the open session keeps the runtime's Agent and tools", async () => {
  assert.deepEqual(concurrentTools, toolsBefore);
  assert.deepEqual(session.getToolNames(), toolsBefore);
  assert.equal((await runtime.getHarness()).hash, harnessBefore);
  assert.ok(toolsBefore.includes("Write"), "the runtime's default Agent has Write");
});

await check("listed differences add up to the difference of the totals; same text, same figure", () => {
  const listed = request.components.reduce((sum, component) => sum + component.tokens, 0);
  assert.equal(listed, request.b.tokens.total - request.a.tokens.total);
  for (const side of [request.a, request.b]) {
    assert.equal(side.tokens.total, side.tokens.system + side.tokens.tools + side.tokens.messages);
  }
  const changes = (kind: string) => request.components.filter((component) => component.change === kind).length;
  assert.equal(request.a.components, request.unchanged + changes("changed") + changes("removed"));
  assert.equal(request.b.components, request.unchanged + changes("changed") + changes("added"));
});

await check("the comparison names what the reviewer Agent changes", () => {
  const byId = new Map(request.components.map((component) => [component.id, component]));
  assert.equal(byId.get("prompt_section:identity")?.change, "changed");
  assert.equal(byId.get("prompt_section:review-rules")?.change, "added");
  assert.equal(byId.get("skill:user:release-notes")?.change, "removed");
  for (const tool of ["Write", "Edit", "MultiEdit", "WebFetch"])
    assert.equal(byId.get(`tool:${tool}`)?.change, "removed");
  assert.ok(!byId.has("tool:Read") && !byId.has("prompt_section:environment"), "unchanged components are not listed");
});

await check("any request made while rendering stops where it would be sent, on every path", async () => {
  const { renderRequests, RequestNotSent } = await import("../trace/requestRender.js");
  const { createMessage, streamMessage } = await import("../services/api/streaming.js");
  const captured: string[] = [];
  await renderRequests(
    (rendered) => captured.push(rendered.purpose),
    async () => {
      const single = createMessage({
        messages: [{ role: "user", content: "summarize" }],
        trace: { purpose: "compaction" },
      });
      await assert.rejects(single, (error) => error instanceof RequestNotSent);
      const events = [];
      for await (const event of streamMessage({
        messages: [{ role: "user", content: "hi" }],
        trace: { purpose: "subagent" },
      })) {
        events.push(event);
      }
      assert.deepEqual(
        events.map((event) => event.type),
        ["error"],
      );
    },
  );
  assert.deepEqual(captured, ["compaction", "subagent"]);
  assert.equal(tripped + fetches, 0);
});

await check("the same Agent twice renders the same request", async () => {
  const same = await runtime.diffHarness({ name: "reviewer" }, { spec: REVIEWER }, { prompt: PROMPT });
  assert.deepEqual(same.request?.components, []);
  assert.deepEqual(same.request?.params, []);
  assert.match(formatRequestDiff(same.request!), /The two requests carry the same content/);
});

await check("without a prompt the result is the settings comparison only", async () => {
  const plain = await runtime.diffHarness({}, { name: "reviewer" });
  assert.equal("request" in plain, false);
  assert.deepEqual(plain.differences, diff.differences);
});

await check("a local command and an Agent that does not resolve are refused", async () => {
  await assert.rejects(runtime.diffHarness({}, { name: "reviewer" }, { prompt: "/help" }), (error) =>
    isAgentSdkError(error, "invalid_argument"),
  );
  await assert.rejects(runtime.diffHarness({}, { name: "ghost" }, { prompt: PROMPT }), (error) =>
    isAgentSdkError(error, "harness"),
  );
  await assert.rejects(runtime.diffHarness({}, { name: "reviewer" }, { prompt: "  " }), (error) =>
    isAgentSdkError(error, "invalid_argument"),
  );
  assert.equal(tripped + fetches, 0);
});

// ─── Golden ─────────────────────────────────────────────────────────────

const PLATFORM_TOOLS = process.platform === "win32" ? 1 : 0;

function normalize(text: string): string {
  const forward = root.replace(/\\/g, "/");
  return text.split(root).join("<root>").split(forward).join("<root>");
}

/** The part totals hold the environment section, so only their difference is kept. */
function normalizeText(text: string): string {
  return normalize(text)
    .replace(/^( {2}(?:system prompt|tools|messages|total))( +[\d,]+)( +[\d,]+)/gm, (_all, label, a, b) => {
      return `${label}${"<n>".padStart(a.length)}${"<n>".padStart(b.length)}`;
    })
    .replace(/(\d+) are the same\./, (_all, n) => `${Number(n) - PLATFORM_TOOLS} are the same.`);
}

function normalizeJson(value: typeof diff): unknown {
  const copy = structuredClone(value);
  const summary = (side: NonNullable<typeof copy.request>["a"]) => {
    side.components -= PLATFORM_TOOLS;
    (side as { tokens: unknown }).tokens = { system: "<n>", tools: "<n>", messages: "<n>", total: "<n>" };
  };
  summary(copy.request!.a);
  summary(copy.request!.b);
  copy.request!.unchanged -= PLATFORM_TOOLS;
  return JSON.parse(normalize(JSON.stringify(copy)));
}

const cli = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
  execFile(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      path.join(import.meta.dirname, "..", "entrypoint", "cli.ts"),
      "harness",
      "diff",
      "default",
      "./reviewer.json",
      "--prompt",
      PROMPT,
    ],
    { cwd, env: { ...process.env, NO_COLOR: "1" }, timeout: 60_000 },
    (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
  );
});

console.log("Interfaces");

await check("the CLI prints the settings and the request comparison and sends nothing", async () => {
  assert.equal(cli.code, 0, cli.stderr);
  assert.equal(tripped, 0);
  // The CLI reads the spec from a file, so its side is named (inline).
  const inline = await runtime.diffHarness({}, { spec: REVIEWER }, { prompt: PROMPT });
  assert.equal(
    normalizeText(cli.stdout),
    normalizeText(`${formatHarnessDiff(inline)}\n\n${formatRequestDiff(inline.request!)}\n`),
  );
});

await check("--prompt needs a value and belongs to diff", async () => {
  const { runHarnessCommand } = await import("../entrypoint/harnessCommand.js");
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    assert.equal(await runHarnessCommand(["diff", "default", "reviewer", "--prompt"], cwd), 1);
    assert.equal(await runHarnessCommand(["show", "--prompt", "x"], cwd), 1);
  } finally {
    process.stderr.write = write;
  }
});

const recording = [
  `### text: default → reviewer, prompt ${JSON.stringify(PROMPT)}`,
  normalizeText(`${formatHarnessDiff(diff)}\n\n${formatRequestDiff(request)}`),
  "",
  "### json",
  JSON.stringify(normalizeJson(diff), null, 2),
  "",
].join("\n");

await check("the comparison matches the golden", async () => {
  if (process.argv.includes("--update")) {
    await writeFile(GOLDEN_PATH, recording, "utf8");
    console.log(`    [updated] ${GOLDEN_PATH}`);
    return;
  }
  const golden = (await readFile(GOLDEN_PATH, "utf8")).replace(/\r\n?/g, "\n");
  assert.equal(recording, golden, "request diff golden mismatch; use --update only for intentional changes");
});

console.log("MCP");

const echoServer = path.join(root, "echo-server.mjs");
const sdkModule = (specifier: string) => JSON.stringify(import.meta.resolve(`@modelcontextprotocol/sdk/${specifier}`));
await writeFile(
  echoServer,
  `import { Server } from ${sdkModule("server/index.js")};
import { StdioServerTransport } from ${sdkModule("server/stdio.js")};
import { ListToolsRequestSchema } from ${sdkModule("types.js")};
const server = new Server({ name: "echo", version: "0.0.1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "echo", description: "Echo the message.", inputSchema: { type: "object", properties: { message: { type: "string" } } } }],
}));
await server.connect(new StdioServerTransport());
`,
);

await check("a server the other Agent leaves out drops out of its rendering, not out of the open session", async () => {
  const { added } = await runtime.connectMcpServers({
    echo: { type: "stdio", command: process.execPath, args: [echoServer] },
  });
  assert.deepEqual(added, ["echo"]);
  assert.ok(session.getToolNames().includes("mcp__echo__echo"));
  const same = await runtime.diffHarness({}, {}, { prompt: PROMPT });
  assert.deepEqual(same.request?.components, []);
  const without = await runtime.diffHarness({}, { spec: { mcpServers: { exclude: ["echo"] } } }, { prompt: PROMPT });
  assert.deepEqual(
    without.request?.components.map(({ id, change }) => `${change} ${id}`),
    ["removed tool:mcp__echo__echo"],
  );
  assert.ok(session.getToolNames().includes("mcp__echo__echo"), "the open session keeps the server's tool");
  assert.equal(tripped + fetches, 0);
});

await session.close();
await runtime.dispose();
globalThis.fetch = realFetch;
tripwire.close();
// Windows cannot remove the directory the process works in.
process.chdir(os.tmpdir());
await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(`\n${passed} checks passed.`);
process.exit(0);
