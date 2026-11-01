/**
 * Tool and MCP server selection by an Agent (`tools.include`/`exclude`,
 * `mcpServers.include`/`exclude`) and settings of single tools
 * (`tools.config`).
 *
 * Rules: exact names and `*` patterns, `exclude` winning over `include`, an
 * empty `include`, reasons naming the Agent, and nothing filtered without a
 * selection or without a runtime; `tools.config` lookup and its startup
 * warnings.
 *
 * Tool settings: the shell tool's stated default timeout, the timeout and
 * output limit it runs with, and a tool's result limit in the loop; without
 * settings, the built-in values.
 *
 * Runtime, against the fixture model: a left-out tool is missing from the
 * request's tools and from the deferred-tool list, a call the model makes
 * anyway is refused without running it, the other tools stay; sub-agents get
 * no more than the Agent keeps, and neither a project sub-agent definition
 * nor a project allow rule adds a left-out tool back; an edit to the Agent
 * applies from the next request; the inventory and `/harness` show left-out
 * tools with the reason; unknown names are reported at startup. MCP: a
 * left-out server is not started and is listed as disabled, servers added
 * while running are skipped, and `tools.exclude` can turn off one server's
 * tools while it stays connected.
 *
 * Run: node --import tsx src/scripts/test-harness-tools.ts
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "easy-agent-harness-tools-")));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
await Promise.all([
  mkdir(path.join(home, ".easy-agent"), { recursive: true }),
  mkdir(path.join(cwd, ".easy-agent", "agents"), { recursive: true }),
]);
for (const key of Object.keys(process.env)) {
  if (/^(?:ANTHROPIC_|EASY_AGENT_|CLAUDE_CODE_)/.test(key) || /TOOL_SEARCH|THINKING|WEB_SEARCH/.test(key)) {
    delete process.env[key];
  }
}
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.ANTHROPIC_AUTH_TOKEN = "test-token";
process.env.EASY_AGENT_DISABLE_HOOKS = "1";
process.chdir(cwd);

const { createAnthropicFixture, FIXTURE_MODEL } = await import("./fixtures/anthropicFixture.js");
const fixture = createAnthropicFixture();
await fixture.start();
process.env.ANTHROPIC_MODEL = FIXTURE_MODEL;

const { resolveHarnessFromInputs } = await import("../harness/resolve.js");
const { selectionMatches, selectionOffReason, unmatchedSelectionEntries, toolConfigOf, toolConfigProblems } =
  await import("../harness/selection.js");
const { bashTool } = await import("../tools/bashTool.js");
const { powerShellTool } = await import("../tools/powerShellTool.js");
const { getAllTools, getRegisteredTools, findToolByName } = await import("../tools/index.js");
const { resetSettingsCache } = await import("../config/sources.js");
const { getMcpRegistryEntry } = await import("../services/mcp/registry.js");
const { createAgentRuntime } = await import("../sdk/index.js");
type AgentRuntime = Awaited<ReturnType<typeof createAgentRuntime>>;

const userSettings = path.join(home, ".easy-agent", "settings.json");
const projectSettings = path.join(cwd, ".easy-agent", "settings.json");
const writeJson = (file: string, value: unknown) => writeFile(file, JSON.stringify(value, null, 2));

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const resolveSpec = (harnesses: Record<string, unknown>, name: string) =>
  resolveHarnessFromInputs({
    layers: [{ source: "user", path: null, raw: { harnesses } }],
    workspaceTrusted: true,
    env: {},
    name,
  });

// ─── Rules ─────────────────────────────────────────────────────────────

console.log("Selection rules");

await check("entries match a name exactly or by a * pattern", () => {
  assert.ok(selectionMatches("Write", "Write"));
  assert.ok(!selectionMatches("Write", "WriteX"));
  assert.ok(!selectionMatches("write", "Write"), "names are case-sensitive");
  assert.ok(selectionMatches("mcp__github__*", "mcp__github__create_issue"));
  assert.ok(!selectionMatches("mcp__github__*", "mcp__gitlab__create_issue"));
  assert.ok(selectionMatches("Task*", "TaskCreate"));
  assert.ok(selectionMatches("*", "anything"));
  assert.ok(!selectionMatches("a.b", "aXb"), "other characters are literal");
  assert.ok(selectionMatches("plugin:docs:*", "plugin:docs:search"));
});

await check("include keeps only matching names, exclude wins, an empty include keeps nothing", () => {
  const resolved = resolveSpec(
    {
      reader: { tools: { include: ["Read", "Grep", "Task*"], exclude: ["TaskCreate"] } },
      nothing: { tools: { include: [] } },
      noWrite: { tools: { exclude: ["Write"] }, mcpServers: { include: ["docs"] } },
    },
    "reader",
  );
  assert.equal(selectionOffReason(resolved, "tools", "Read"), undefined);
  assert.equal(selectionOffReason(resolved, "tools", "TaskList"), undefined);
  assert.equal(selectionOffReason(resolved, "tools", "Write"), 'Not in tools.include (Agent "reader").');
  assert.equal(selectionOffReason(resolved, "tools", "TaskCreate"), 'Left out by tools.exclude (Agent "reader").');
  assert.equal(selectionOffReason(resolved, "mcpServers", "docs"), undefined, "each kind has its own lists");

  const nothing = resolveSpec({ nothing: { tools: { include: [] } } }, "nothing");
  assert.match(selectionOffReason(nothing, "tools", "Read") ?? "", /Not in tools\.include/);

  const noWrite = resolveSpec(
    { noWrite: { tools: { exclude: ["Write"] }, mcpServers: { include: ["docs"] } } },
    "noWrite",
  );
  assert.equal(selectionOffReason(noWrite, "tools", "Bash"), undefined, "without include everything else stays");
  assert.match(selectionOffReason(noWrite, "mcpServers", "github") ?? "", /Not in mcpServers\.include/);
});

await check("a child Agent's list replaces its parent's along extends", () => {
  const resolved = resolveSpec(
    { base: { tools: { exclude: ["Write"] } }, child: { extends: "base", tools: { exclude: ["Bash"] } } },
    "child",
  );
  assert.equal(selectionOffReason(resolved, "tools", "Write"), undefined);
  assert.match(selectionOffReason(resolved, "tools", "Bash") ?? "", /Agent "child"/);
});

await check("unmatched entries are the ones that name nothing", () => {
  const resolved = resolveSpec({ a: { tools: { include: ["Read", "Wirte"], exclude: ["mcp__x__*", "Read"] } } }, "a");
  assert.deepEqual(unmatchedSelectionEntries(resolved, "tools", ["Read", "Write"]), ["Wirte", "mcp__x__*"]);
});

await check("tools.config gives one tool's settings and reports names and keys that do not fit", () => {
  const resolved = resolveSpec(
    {
      tuned: {
        tools: {
          config: {
            Bash: { timeoutMs: 300_000, maxOutputBytes: 50_000 },
            Read: { maxResultChars: 2_000, timeoutMs: 5 },
            Bsh: { timeoutMs: 1 },
            mcp__docs__search: { maxResultChars: 500 },
          },
        },
      },
    },
    "tuned",
  );
  assert.deepEqual(toolConfigOf(resolved, "Bash"), { timeoutMs: 300_000, maxOutputBytes: 50_000 });
  assert.deepEqual(toolConfigOf(resolved, "Grep"), {});
  assert.deepEqual(toolConfigOf(resolveSpec({}, "default"), "Bash"), {}, "nothing without the key");
  assert.deepEqual(toolConfigProblems(resolved, ["Bash", "Read", "Grep"]), [
    "tools.config.Read: timeoutMs apply only to Bash and PowerShell",
    "tools.config.Bsh names no built-in tool",
  ]);
  const invalid = resolveSpec({ bad: { tools: { config: { Bash: { timeoutMs: -1, retries: 2 } } } } }, "bad");
  assert.ok(
    invalid.issues.some((issue) => issue.level === "error" && issue.path?.startsWith("tools.config.Bash")),
    "invalid settings are spec errors",
  );
});

await check("without a selection or a runtime every enabled tool stays", () => {
  const expected = getRegisteredTools()
    .filter((tool) => tool.isEnabled())
    .map((tool) => tool.name);
  assert.deepEqual(
    getAllTools().map((tool) => tool.name),
    expected,
  );
  assert.equal(findToolByName("Write")?.name, "Write");
  const plain = resolveSpec({}, "default");
  for (const name of expected) assert.equal(selectionOffReason(plain, "tools", name), undefined);
});

// ─── Runtime ───────────────────────────────────────────────────────────

const toolNames = (request: { body: Record<string, unknown> } | undefined) =>
  ((request?.body.tools as { name: string }[] | undefined) ?? []).map((tool) => tool.name);
const deferredList = (request: { body: Record<string, unknown> } | undefined) =>
  /<available-deferred-tools>([\s\S]*?)<\/available-deferred-tools>/.exec(
    JSON.stringify(request?.body.messages),
  )?.[1] ?? "";
const toolResultText = (request: { body: Record<string, unknown> } | undefined) =>
  JSON.stringify((request?.body.messages as unknown[] | undefined)?.at(-1) ?? "");

async function start(name: string | undefined, warnings: string[] = [], services = false): Promise<AgentRuntime> {
  resetSettingsCache();
  return createAgentRuntime({
    cwd,
    trust: "session",
    services: services ? {} : false,
    logger: { warn: (message) => warnings.push(message), error() {} },
    ...(name ? { harness: { name } } : {}),
  });
}

async function send(runtime: AgentRuntime, prompt: string): Promise<void> {
  const session = await runtime.createSession({
    persist: false,
    handlers: { permission: () => ({ decision: "allow_once" }) },
  });
  await session.send(prompt);
  await session.close();
}

const harnesses: Record<string, unknown> = {
  noWrite: { tools: { exclude: ["Write", "Wirte"] } },
  reader: { tools: { include: ["Read", "Grep", "Glob"] } },
};

console.log("Runtime");

try {
  await writeJson(userSettings, { harnesses });
  await writeJson(projectSettings, { allow: ["Write"] });
  await writeFile(
    path.join(cwd, ".easy-agent", "agents", "writer.md"),
    ["---", "name: writer", "description: Writes files", "tools: Write, Read", "---", "Write what you are asked."].join(
      "\n",
    ),
  );
  const target = path.join(cwd, "written.txt");

  await check("a tool the Agent leaves out is not offered and a call to it is refused", async () => {
    const warnings: string[] = [];
    const runtime = await start("noWrite", warnings);
    try {
      assert.ok(
        warnings.some((message) => /tools\.include and tools\.exclude name no built-in tool: Wirte$/.test(message)),
        "a misspelled name is reported at startup",
      );
      fixture.requests.length = 0;
      fixture.script([
        { kind: "tool", name: "Write", input: { file_path: target, content: "x" } },
        { kind: "text", text: "done" },
      ]);
      await send(runtime, "please write");
      const [first, second] = fixture.requests;
      assert.ok(!toolNames(first).includes("Write"), "Write is not in the request's tools");
      assert.ok(!/\bWrite\b/.test(deferredList(first)), "nor in the deferred-tool list");
      for (const name of ["Read", "Edit", "Bash", "Grep"]) {
        assert.ok(toolNames(first).includes(name) || deferredList(first).includes(name), `${name} stays`);
      }
      assert.match(
        toolResultText(second),
        /Tool \\"Write\\" is turned off for this Agent\. Left out by tools\.exclude/,
      );
      assert.equal(existsSync(target), false, "the refused call did not run, even with a project allow rule");
    } finally {
      await runtime.dispose();
    }
  });

  await check("sub-agents get no more than the Agent keeps, whatever a project sub-agent lists", async () => {
    const runtime = await start("noWrite");
    try {
      fixture.requests.length = 0;
      fixture.script([
        { kind: "tool", name: "Agent", input: { description: "write", prompt: "write it", subagent_type: "writer" } },
        { kind: "tool", name: "Write", input: { file_path: target, content: "x" } },
        { kind: "text", text: "sub done" },
        { kind: "text", text: "done" },
      ]);
      await send(runtime, "delegate");
      const child = fixture.requests[1];
      assert.deepEqual(toolNames(child), ["Read"], "the writer sub-agent keeps only Read");
      assert.match(toolResultText(fixture.requests[2]), /turned off for this Agent/);
      assert.equal(existsSync(target), false);
    } finally {
      await runtime.dispose();
    }
  });

  await check("include offers exactly the listed tools; ToolSearch is off when it is not listed", async () => {
    const runtime = await start("reader");
    try {
      fixture.requests.length = 0;
      fixture.script([{ kind: "text", text: "ok" }]);
      await send(runtime, "hello");
      assert.deepEqual(toolNames(fixture.requests[0]).sort(), ["Glob", "Grep", "Read"]);
      assert.equal(deferredList(fixture.requests[0]), "", "nothing is deferred");
    } finally {
      await runtime.dispose();
    }
  });

  await check("an edit to the Agent applies from the next request", async () => {
    const runtime = await start("noWrite");
    try {
      fixture.requests.length = 0;
      fixture.script([{ kind: "text", text: "one" }]);
      await send(runtime, "first");
      const before = [...toolNames(fixture.requests[0]), deferredList(fixture.requests[0])].join(" ");
      assert.match(before, /\bBash\b/);
      await writeJson(userSettings, {
        harnesses: { ...harnesses, noWrite: { tools: { exclude: ["Write", "Bash"] } } },
      });
      fixture.script([{ kind: "text", text: "two" }]);
      await send(runtime, "second");
      const after = [...toolNames(fixture.requests[1]), deferredList(fixture.requests[1])].join(" ");
      assert.doesNotMatch(after, /\bBash\b/);
    } finally {
      await writeJson(userSettings, { harnesses });
      await runtime.dispose();
    }
  });

  await check("the inventory and /harness show left-out tools with the reason", async () => {
    const runtime = await start("noWrite");
    try {
      const inventory = await runtime.getInventory();
      const write = inventory.tools.find((tool) => tool.name === "Write");
      assert.equal(write?.enabled, false);
      assert.equal(write?.reason, 'Left out by tools.exclude (Agent "noWrite").');
      assert.equal(inventory.tools.find((tool) => tool.name === "Read")?.enabled, true);

      const session = await runtime.createSession({ persist: false });
      const outputs: string[] = [];
      session.subscribe((event) => {
        if (event.type === "command_output") outputs.push(event.message);
      });
      await session.runCommand("harness");
      await session.runCommand("harness", ["reader"]);
      await session.close();
      assert.match(outputs[0] ?? "", /off: .*tool:Write \(Left out by tools\.exclude \(Agent "noWrite"\)\.\)/);
      assert.match(outputs[1] ?? "", /off: .*tool:Bash \(Not in tools\.include \(Agent "reader"\)\.\)/);
    } finally {
      await runtime.dispose();
    }
  });

  await check("without a selection the requests offer every tool, as before", async () => {
    const runtime = await start(undefined);
    try {
      fixture.requests.length = 0;
      fixture.script([{ kind: "text", text: "ok" }]);
      await send(runtime, "hello");
      assert.ok(toolNames(fixture.requests[0]).includes("Write"));
      assert.ok(
        (await runtime.getInventory()).tools.every((tool) => tool.reason === undefined || !/tools\./.test(tool.reason)),
      );
    } finally {
      await runtime.dispose();
    }
  });

  await check("tools.config sets the shell timeout and output limit and a tool's result limit", async () => {
    const shellLimits = { timeoutMs: 1500, maxOutputBytes: 40 };
    await writeJson(userSettings, {
      harnesses: {
        ...harnesses,
        tuned: {
          tools: {
            config: {
              Bash: shellLimits,
              PowerShell: shellLimits,
              Read: { maxResultChars: 50 },
              Grep: { timeoutMs: 1 },
            },
          },
        },
      },
    });
    const shell = process.platform === "win32" ? powerShellTool : bashTool;
    const statedDefault = () => JSON.stringify(shell.inputSchema.properties);
    const warnings: string[] = [];
    const runtime = await start("tuned", warnings);
    try {
      assert.ok(
        warnings.some((message) => /tools\.config\.Grep: timeoutMs apply only to Bash and PowerShell/.test(message)),
        "a shell setting on another tool is reported at startup",
      );
      assert.match(statedDefault(), /Timeout in milliseconds \(default 1500\)/, "the model is told the default");

      const file = path.join(cwd, "long.txt");
      await writeFile(file, "z".repeat(400));
      fixture.requests.length = 0;
      fixture.script([
        { kind: "tool", name: "Read", input: { file_path: file } },
        { kind: "text", text: "ok" },
      ]);
      await send(runtime, "read it");
      assert.match(
        toolResultText(fixture.requests[1]),
        /showing first 50\]/,
        "the Read result is cut at 50 characters",
      );

      const slow = await shell.call({ command: `node -e "setTimeout(() => {}, 20000)"` }, { cwd });
      assert.equal(slow.content, "Command timed out after 1500ms");
      const loud = await shell.call({ command: `node -e "process.stdout.write('y'.repeat(500))"` }, { cwd });
      // PowerShell may add a line break to a native command's output, so the counts are bounds.
      const kept = String(loud.content);
      assert.match(kept, /\n\.\.\.\[truncated 4[56]\d bytes\]\r?\n/, `output is cut to 40 bytes: ${kept}`);
      assert.ok(/y{30}/.test(kept) && !/y{41}/.test(kept), `the last 40 bytes are kept: ${kept}`);
      const explicit = await shell.call({ command: `node -e "setTimeout(() => {}, 300)"`, timeout: 10_000 }, { cwd });
      assert.notEqual(explicit.isError, true, `a timeout the call sets still wins: ${String(explicit.content)}`);
    } finally {
      await rm(path.join(cwd, "long.txt"), { force: true });
      await writeJson(userSettings, { harnesses });
      await runtime.dispose();
    }
    const plain = await start(undefined);
    try {
      assert.match(statedDefault(), /\(default 120000\)/, "without settings the built-in default");
      fixture.requests.length = 0;
      fixture.script([{ kind: "text", text: "ok" }]);
      await send(plain, "hello");
    } finally {
      await plain.dispose();
    }
  });

  // ─── MCP servers ────────────────────────────────────────────────────

  const serverModule = (specifier: string) => import.meta.resolve(`@modelcontextprotocol/sdk/${specifier}`);
  const serverPath = path.join(root, "echo-server.mjs");
  await writeFile(
    serverPath,
    `
import { Server } from ${JSON.stringify(serverModule("server/index.js"))};
import { StdioServerTransport } from ${JSON.stringify(serverModule("server/stdio.js"))};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(serverModule("types.js"))};
const server = new Server({ name: "echo", version: "0.0.1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "echo", description: "Echo.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "echo" }] }));
await server.connect(new StdioServerTransport());
`,
  );
  const echo = { command: process.execPath, args: [serverPath] };
  const mcpHarnesses = {
    ...harnesses,
    noEcho: { mcpServers: { exclude: ["echo*"] } },
    onlyDocs: { mcpServers: { include: ["docs"] } },
    noEchoTools: { tools: { exclude: ["mcp__echo__*"] } },
  };

  await check("a server the Agent leaves out is not started and is listed as disabled", async () => {
    await writeJson(userSettings, { harnesses: mcpHarnesses, mcpServers: { echo } });
    for (const name of ["noEcho", "onlyDocs"]) {
      const runtime = await start(name, [], true);
      try {
        assert.equal(getMcpRegistryEntry("echo"), undefined, `${name}: echo is not started`);
        const inventory = await runtime.getInventory();
        const server = inventory.mcpServers.find((item) => item.name === "echo");
        assert.equal(server?.status, "disabled");
        assert.equal(server?.enabled, false);
        assert.equal(server?.source, "user");
        assert.match(server?.reason ?? "", new RegExp(`mcpServers\\.(exclude|include) \\(Agent "${name}"\\)`));
        assert.ok(!inventory.tools.some((tool) => tool.name === "mcp__echo__echo"));

        const added = await runtime.connectMcpServers({ echo2: echo });
        assert.deepEqual(added, { added: [], skipped: ["echo2"] }, `${name}: a server added later is skipped too`);
        assert.equal(getMcpRegistryEntry("echo2"), undefined);
      } finally {
        await runtime.dispose();
      }
    }
  });

  await check("tools.exclude turns off a connected server's tools; without a selection it runs", async () => {
    for (const [name, offered] of [
      [undefined, true],
      ["noEchoTools", false],
    ] as const) {
      const runtime = await start(name, [], true);
      try {
        assert.equal(getMcpRegistryEntry("echo")?.connection.type, "connected", `${name ?? "default"}: echo runs`);
        const tool = (await runtime.getInventory()).tools.find((item) => item.name === "mcp__echo__echo");
        assert.equal(tool?.enabled, offered);
        fixture.requests.length = 0;
        fixture.script([
          { kind: "tool", name: "mcp__echo__echo", input: {} },
          { kind: "text", text: "ok" },
        ]);
        await send(runtime, "echo");
        const request = fixture.requests[0];
        assert.equal(
          [...toolNames(request), deferredList(request)].join(" ").includes("mcp__echo__echo"),
          offered,
          "offered to the model only when kept",
        );
        assert.equal(/turned off for this Agent/.test(toolResultText(fixture.requests[1])), !offered);
      } finally {
        await runtime.dispose();
      }
    }
  });

  await check("a plugin's server the Agent leaves out is not started either", async () => {
    const pluginDir = path.join(root, "docs-plugin");
    await mkdir(path.join(pluginDir, ".easy-agent-plugin"), { recursive: true });
    await writeJson(path.join(pluginDir, ".easy-agent-plugin", "plugin.json"), { name: "docs" });
    await writeJson(path.join(pluginDir, ".mcp.json"), { mcpServers: { echo } });
    await writeJson(userSettings, {
      harnesses: { ...mcpHarnesses, noPluginEcho: { mcpServers: { exclude: ["plugin:docs:*"] } } },
    });
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const startWithPlugin = (name?: string) => {
      resetSettingsCache();
      return createAgentRuntime({
        cwd,
        trust: "session",
        pluginDirs: [pluginDir],
        logger: { warn() {}, error() {} },
        ...(name ? { harness: { name } } : {}),
      });
    };

    const excluded = await startWithPlugin("noPluginEcho");
    try {
      await sleep(1500);
      assert.equal(getMcpRegistryEntry("plugin:docs:echo"), undefined, "the plugin's server is not started");
      const server = (await excluded.getInventory()).mcpServers.find((item) => item.name === "plugin:docs:echo");
      assert.equal(server?.status, "disabled");
      assert.equal(server?.source, "plugin");
      assert.match(server?.reason ?? "", /mcpServers\.exclude \(Agent "noPluginEcho"\)/);
    } finally {
      await excluded.dispose();
    }

    const plain = await startWithPlugin();
    try {
      const deadline = Date.now() + 10_000;
      while (getMcpRegistryEntry("plugin:docs:echo")?.connection.type !== "connected") {
        if (Date.now() > deadline) throw new Error("the plugin's server did not start without a selection");
        await sleep(20);
      }
    } finally {
      await plain.dispose();
    }
  });

  assert.deepEqual(JSON.parse(await readFile(projectSettings, "utf8")), { allow: ["Write"] }, "nothing was written");
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  await fixture.close();
  // Leave the directory first: Windows cannot remove a process's working
  // directory, and MCP servers started in it run until this process exits.
  process.chdir(os.tmpdir());
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}

console.log(`\nHarness tool selection: ${passed} passed, 0 failed.`);
// `dispose()` leaves MCP servers running until the process exits.
process.exit(0);
