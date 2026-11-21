/** Runtime resource ownership and lifecycle contracts. No real model calls. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as os from "node:os";
import * as path from "node:path";
import type { RuntimeScope } from "../state/runtimeScope.js";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "eagent-runtime-registries-")));
const fixtureHome = path.join(root, "home");
const first = path.join(root, "first");
const second = path.join(root, "second");
await Promise.all([fixtureHome, first, second].map((dir) => mkdir(dir, { recursive: true })));
const originalEnv = { ...process.env };
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;

const { createAgentRuntime } = await import("../sdk/runtime.js");
const { runInScopeOf } = await import("../sdk/session.js");
const { createRuntimeScope, currentRuntimeScope, defineRuntimeState, disposeRuntimeScope, runInRuntimeScope } =
  await import("../state/runtimeScope.js");
const { createSessionScope, runInSessionScope } = await import("../state/sessionScope.js");
const { setActiveOutputStyle, getActiveOutputStyleName, isOutputStylesInitialized } = await import(
  "../styles/registry.js"
);
const { findSkill, getRegisteredSkills, isSkillsInitialized } = await import("../services/skills/registry.js");
const { findAgent, isAgentsInitialized } = await import("../agents/registry.js");
const { findUserCommand, isUserCommandsInitialized } = await import("../commands/userCommands/registry.js");
const { refreshActivePlugins, getActivePlugins, getActivePluginHooks } = await import("../plugins/runtime.js");
const { pluginMcpOffByAgent } = await import("../harness/resources.js");
const { resolveHarness } = await import("../harness/resolve.js");
const { installHarness } = await import("../harness/active.js");
const { loadHooksSettings, refreshHookDisableFromSettings, hooksGloballyDisabled } = await import(
  "../hooks/settings.js"
);
const { connectToServer, getActiveMcpConnections, setMcpConnectionListeners } = await import(
  "../services/mcp/client.js"
);
const { bootstrapMcp, disconnectMcpServer, connectAdditionalMcpServers } = await import("../services/mcp/bootstrap.js");
const { getMcpRegistry, setMcpRegistryEntry } = await import("../services/mcp/registry.js");
const { registerMcpTools, getRegisteredTools } = await import("../tools/index.js");
const { fetchToolsForConnection } = await import("../services/mcp/fetchTools.js");
const { applyLspServers, getLspStatus } = await import("../services/lsp/runtime.js");
const { LspServerSchema } = await import("../services/lsp/schema.js");
const { bootstrapSkills } = await import("../services/skills/bootstrap.js");
const { bootstrapAgents } = await import("../agents/bootstrap.js");
const { bootstrapUserCommands } = await import("../commands/userCommands/bootstrap.js");
const { bootstrapOutputStyles } = await import("../styles/bootstrap.js");
let runtime: Awaited<ReturnType<typeof createAgentRuntime>> | undefined;
const options = { services: false as const, hardenPrivateData: false, logger: { warn() {}, error() {} } };
const scopes: RuntimeScope[] = [];
const scope = () => {
  const result = createRuntimeScope();
  scopes.push(result);
  return result;
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function write(file: string, body: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
}
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  console.log(`✓ ${name}`);
}
async function seed(cwd: string, label: string): Promise<string> {
  await write(
    path.join(cwd, ".easy-agent", "skills", label, "SKILL.md"),
    `---\nname: ${label}\ndescription: ${label}\n---\n${label}`,
  );
  await write(
    path.join(cwd, ".easy-agent", "agents", `${label}.md`),
    `---\nname: ${label}\ndescription: ${label}\n---\n${label}`,
  );
  await write(path.join(cwd, ".easy-agent", "commands", `${label}.md`), `---\ndescription: ${label}\n---\n${label}`);
  const plugin = path.join(cwd, "fixture-plugin");
  await write(
    path.join(plugin, ".easy-agent-plugin", "plugin.json"),
    JSON.stringify({ name: label, version: "1.0.0" }),
  );
  await write(path.join(plugin, "skills", "extra", "SKILL.md"), "---\nname: extra\ndescription: extra\n---\nExtra");
  await write(
    path.join(plugin, "hooks", "hooks.json"),
    JSON.stringify({ SessionStart: [{ hooks: [{ type: "command", command: `echo ${label}` }] }] }),
  );
  await write(
    path.join(plugin, ".mcp.json"),
    JSON.stringify({ mcpServers: { owned: { command: process.execPath, args: ["--version"] } } }),
  );
  return plugin;
}

// Controlled real MCP transport. Gates hold a handshake or tools/list until
// the test releases it; assertions never depend on filesystem/network speed.
const gates = new Map<string, { arrived: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }>();
const remotes = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();
let connections = 0;
const http = createServer(async (request, response) => {
  try {
    if (request.method === "GET") {
      response.writeHead(405).end();
      return;
    }
    if (request.method === "DELETE") {
      response.writeHead(200).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    const gate = gates.get(`${request.url}:${message.method}`);
    if (gate) {
      gate.arrived.resolve();
      await gate.release.promise;
    }
    if (response.destroyed) return;
    const id = request.headers["mcp-session-id"] as string | undefined;
    let remote = id ? remotes.get(id) : undefined;
    if (!remote) {
      const index = ++connections;
      const server = new Server({ name: `runtime-${index}`, version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: "owner", inputSchema: { type: "object", properties: {} } }],
      }));
      server.setRequestHandler(CallToolRequestSchema, async () => ({
        content: [{ type: "text", text: String(index) }],
      }));
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        onsessioninitialized: (sessionId) => {
          remotes.set(sessionId, { server, transport });
        },
      });
      await server.connect(transport);
      remote = { server, transport };
    }
    await remote.transport.handleRequest(request, response, message);
  } catch (error) {
    if (!response.headersSent) response.writeHead(500);
    response.end(String(error));
  }
});
await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
const address = http.address();
assert.ok(address && typeof address !== "string");
const config = (route = "/mcp") => ({
  type: "http" as const,
  url: `http://127.0.0.1:${address.port}${route}`,
  scope: "user" as const,
});
function hold(route: string, method: string) {
  const gate = { arrived: deferred(), release: deferred() };
  gates.set(`${route}:${method}`, gate);
  return gate;
}

try {
  await check("sequential runtimes start with their own registries", async () => {
    runtime = await createAgentRuntime({ cwd: first, ...options });
    assert.equal(setActiveOutputStyle("Learning"), true);
    assert.equal(runtime.getCapabilities().outputStyle, "Learning");
    await runtime.dispose();
    runtime = await createAgentRuntime({ cwd: second, ...options });
    assert.equal(runtime.getCapabilities().outputStyle, "default", "a new workspace must not inherit the old style");
    await runtime.dispose();
  });

  const firstPlugin = await seed(first, "first");
  const secondPlugin = await seed(second, "second");
  await check("independent owners isolate registries, plugin queues, initialized flags and callbacks", async () => {
    const a = scope(),
      b = scope();
    const pause = deferred(),
      ready = deferred();
    const task = runInRuntimeScope(a, async () => {
      assert.equal(isSkillsInitialized(), false);
      assert.equal(isAgentsInitialized(), false);
      assert.equal(isOutputStylesInitialized(), false);
      assert.equal(isUserCommandsInitialized(), false);
      await refreshActivePlugins(first, { pluginDirs: [firstPlugin], applyMcp: false });
      setActiveOutputStyle("Learning");
      const session = createSessionScope();
      ready.resolve();
      await pause.promise;
      assert.ok(findSkill("first"));
      assert.ok(findAgent("first"));
      assert.ok(findUserCommand("first"));
      assert.equal(findSkill("second"), undefined);
      assert.equal(getActivePlugins()[0]?.name, "first");
      assert.equal(getActivePluginHooks().SessionStart?.[0]?.hooks[0]?.command, "echo first");
      assert.equal(getActiveOutputStyleName(), "Learning");
      return session;
    });
    await ready.promise;
    await runInRuntimeScope(b, async () => {
      assert.equal(isSkillsInitialized(), false);
      await refreshActivePlugins(second, { pluginDirs: [secondPlugin], applyMcp: false });
      assert.equal(findSkill("first"), undefined);
      assert.ok(findSkill("second:extra"));
      assert.equal(getActiveOutputStyleName(), "default");
      pause.resolve();
      const sessionA = await task;
      runInSessionScope(sessionA, () => {
        assert.equal(currentRuntimeScope(), a, "session carries its owner into foreign callbacks");
        assert.ok(findSkill("first:extra"));
      });
      assert.equal(currentRuntimeScope(), b);
    });
    await runInRuntimeScope(a, async () => {
      const harness = await resolveHarness({ cwd: first, spec: { plugins: { exclude: ["fixture-plugin@dev"] } } });
      installHarness(harness);
      const server = getActivePlugins()[0]!.mcpServers[0]!.namespacedName;
      assert.ok(pluginMcpOffByAgent(server), "plugin MCP ownership follows this owner");
      runInRuntimeScope(b, () => assert.equal(pluginMcpOffByAgent(server), undefined));
    });
  });

  await check("hook snapshots and disable fallback do not cross owners", async () => {
    const a = scope(),
      b = scope();
    const settings = path.join(fixtureHome, ".easy-agent", "settings.json");
    await write(
      settings,
      JSON.stringify({ disableAllHooks: true, hooks: { SessionStart: [{ hooks: [{ command: "echo hook-a" }] }] } }),
    );
    await runInRuntimeScope(a, async () => {
      assert.equal((await loadHooksSettings(first)).SessionStart?.[0]?.hooks[0]?.command, "echo hook-a");
      await refreshHookDisableFromSettings(first);
      assert.equal(hooksGloballyDisabled(first), true);
    });
    await write(settings, "{");
    await runInRuntimeScope(b, async () => {
      assert.deepEqual(await loadHooksSettings(first), {});
      await refreshHookDisableFromSettings(first);
      assert.equal(hooksGloballyDisabled(first), false);
    });
    await runInRuntimeScope(a, async () => {
      assert.equal((await loadHooksSettings(first)).SessionStart?.[0]?.hooks[0]?.command, "echo hook-a");
      await refreshHookDisableFromSettings(first);
      assert.equal(hooksGloballyDisabled(first), true);
    });
    await write(settings, "{}");
  });

  await check("MCP caches and tool callbacks keep their owner even when names and configs match", async () => {
    const a = scope(),
      b = scope();
    const remote = config();
    const connect = async () => {
      const [one, two] = await Promise.all([connectToServer("same", remote), connectToServer("same", remote)]);
      assert.equal(one, two, "same owner coalesces handshakes");
      assert.equal(one.type, "connected");
      if (one.type !== "connected") throw new Error("Fixture did not connect");
      const tools = await fetchToolsForConnection(one);
      setMcpRegistryEntry("same", one, tools);
      registerMcpTools(tools);
      return { one, tool: tools[0]! };
    };
    const left = await runInRuntimeScope(a, connect);
    const right = await runInRuntimeScope(b, connect);
    assert.notEqual(left.one.client, right.one.client);
    await runInRuntimeScope(b, async () => {
      const result = await left.tool.call({}, { cwd: first });
      assert.equal(result.content, left.one.serverInfo!.name.replace("runtime-", ""));
      assert.notEqual(result.content, right.one.serverInfo!.name.replace("runtime-", ""));
    });
    await disposeRuntimeScope(a);
    assert.equal(left.one.client.transport, undefined);
    await runInRuntimeScope(b, async () => {
      assert.equal((await left.tool.call({}, { cwd: first })).isError, true);
      assert.equal(getActiveMcpConnections().length, 1);
      assert.equal(getRegisteredTools().filter((tool) => tool.isMcp).length, 1);
    });
    runInRuntimeScope(a, () => assert.equal(getMcpRegistry().length, 0));
  });

  await check("sessions share their runtime resources, reload together, and keep separate private state", async () => {
    await rm(path.join(firstPlugin, ".mcp.json"));
    runtime = await createAgentRuntime({ cwd: first, ...options, pluginDirs: [firstPlugin] });
    const one = await runtime.createSession({ persist: false });
    const two = await runtime.createSession({ persist: false });
    const foreign = scope();
    runInRuntimeScope(foreign, () =>
      assert.ok(runtime!.getCapabilities().skills.some((skill) => skill.name === "first")),
    );
    await runtime.connectMcpServers({ shared: config() });
    assert.ok(one.getToolNames().includes("mcp__shared__owner"));
    assert.deepEqual(one.getToolNames(), two.getToolNames());
    assert.equal(runInScopeOf(one, currentRuntimeScope), runInScopeOf(two, currentRuntimeScope));
    one.setThinking("off");
    assert.notDeepEqual(one.getState().thinking, two.getState().thinking);
    await write(
      path.join(first, ".easy-agent", "skills", "first", "SKILL.md"),
      "---\nname: first\ndescription: reloaded\n---\nReload",
    );
    await runtime.reload();
    for (const session of [one, two])
      runInScopeOf(session, () => assert.equal(findSkill("first")?.description, "reloaded"));
    const owner = runInScopeOf(one, currentRuntimeScope);
    const disposing = runtime.dispose();
    assert.equal(runtime.dispose(), disposing, "dispose callers join the same promise");
    await disposing;
    assert.equal(one.closed, true);
    assert.equal(two.closed, true);
    assert.equal(owner.signal.aborted, true);
    runInRuntimeScope(owner, () => assert.equal(getActiveMcpConnections().length, 0));
  });

  await check("active close is quiet and pending reconnects cannot restart after disposal", async () => {
    const owner = scope();
    await runInRuntimeScope(owner, async () => {
      await bootstrapMcp(first);
      await connectAdditionalMcpServers({ quiet: config(), retry: config() });
      const quiet = getActiveMcpConnections().find((connection) => connection.name === "quiet")!;
      let unexpected = 0;
      setMcpConnectionListeners({
        onUnexpectedClose: () => {
          unexpected++;
        },
      });
      await disconnectMcpServer("quiet");
      assert.equal(quiet.client.transport, undefined);
      assert.equal(unexpected, 0);
      // Reinstall the normal retry handler and simulate a remote close.
      await bootstrapMcp(first);
      await connectAdditionalMcpServers({ retry: config() });
      await getActiveMcpConnections()
        .find((connection) => connection.name === "retry")!
        .client.close();
      assert.equal(getMcpRegistry().find((entry) => entry.connection.name === "retry")?.connection.type, "pending");
    });
    await disposeRuntimeScope(owner);
    const count = connections;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(connections, count, "cancelled reconnect timer never opens a transport");
  });

  await check("dispose cancels a delayed handshake and a later runtime gets a new connection", async () => {
    runtime = await createAgentRuntime({ cwd: first, ...options });
    const gate = hold("/slow", "initialize");
    const pending = runtime.connectMcpServers({ slow: config("/slow") });
    await gate.arrived.promise;
    await runtime.dispose();
    runtime = await createAgentRuntime({ cwd: second, ...options });
    gate.release.resolve();
    await pending;
    assert.equal(getActiveMcpConnections().length, 0);
    assert.equal(getMcpRegistry().length, 0);
    await runtime.connectMcpServers({ slow: config("/slow") });
    assert.equal(getActiveMcpConnections().length, 1);
    await runtime.dispose();
  });

  await check("direct asynchronous module calls retain the runtime active at invocation", async () => {
    const settings = path.join(first, ".easy-agent", "settings.json");
    await write(settings, JSON.stringify({ mcpServers: { legacy: config() } }));
    runtime = await createAgentRuntime({ cwd: first, ...options, trust: "session" });
    const pending = Promise.all([
      bootstrapMcp(first),
      bootstrapSkills(first),
      bootstrapAgents(first),
      bootstrapUserCommands(first),
      bootstrapOutputStyles(first),
      loadHooksSettings(first),
      refreshHookDisableFromSettings(first),
    ]);
    await runtime.dispose();
    await pending;
    assert.equal(getActiveMcpConnections().length, 0, "a late bootstrap must not publish into the process fallback");
    assert.equal(getMcpRegistry().length, 0);
    assert.deepEqual(getRegisteredSkills(), []);
    assert.equal(isAgentsInitialized(), false);
    assert.equal(isUserCommandsInitialized(), false);
    assert.equal(isOutputStylesInitialized(), false);
    await rm(settings);
  });

  await check("late plugin discovery and tools/list cannot repopulate a closed runtime", async () => {
    runtime = await createAgentRuntime({ cwd: first, ...options, pluginDirs: [firstPlugin] });
    const session = await runtime.createSession({ persist: false });
    const owner = runInScopeOf(session, currentRuntimeScope);
    await write(path.join(firstPlugin, ".mcp.json"), JSON.stringify({ mcpServers: { delayed: config("/plugin") } }));
    const gate = hold("/plugin", "tools/list");
    const refresh = runtime.reload().catch((error: unknown) => error);
    await gate.arrived.promise;
    const queued = runtime.reload().catch((error: unknown) => error);
    await runtime.dispose();
    runtime = await createAgentRuntime({ cwd: second, ...options });
    gate.release.resolve();
    await Promise.all([refresh, queued]);
    runInRuntimeScope(owner, () => {
      assert.deepEqual(getRegisteredSkills(), []);
      assert.deepEqual(getActivePlugins(), []);
      assert.deepEqual(getMcpRegistry(), []);
    });
    assert.equal(
      runtime.getCapabilities().skills.some((skill) => skill.name.startsWith("first")),
      false,
    );
    assert.equal(getActiveMcpConnections().length, 0);
    await runtime.dispose();
  });

  await check("failed creation cleans initialized resources and allows a subsequent runtime", async () => {
    let failedScope: RuntimeScope | undefined;
    let cleaned = 0;
    const resource = defineRuntimeState(
      "failureFixture",
      () => ({}),
      () => {
        cleaned++;
      },
    );
    await assert.rejects(
      createAgentRuntime({
        cwd: first,
        ...options,
        harness: { spec: { skills: { include: ["nonexistent-fixture"] } } },
        logger: {
          error() {},
          warn(message) {
            if (!message.includes("skills.include")) return;
            failedScope = currentRuntimeScope();
            resource();
            void connectToServer("failed-start", config());
            throw new Error("Injected bootstrap failure after registry load");
          },
        },
      }),
      /Injected bootstrap failure/,
    );
    assert.ok(failedScope);
    assert.equal(failedScope.signal.aborted, true);
    assert.equal(cleaned, 1);
    await disposeRuntimeScope(failedScope);
    assert.equal(cleaned, 1);
    runInRuntimeScope(failedScope, () => assert.deepEqual(getActiveMcpConnections(), []));
    runtime = await createAgentRuntime({ cwd: second, ...options });
    assert.equal(getActiveMcpConnections().length, 0);
    await runtime.dispose();
  });

  await check("runtime disposal terminates connected and initializing MCP stdio children", async () => {
    const script = path.join(root, "mcp-child.mjs");
    const pidFile = path.join(root, "mcp-child.pid");
    await write(
      script,
      `
import { writeFileSync } from "node:fs";
import { Server } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/index.js"))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
writeFileSync(process.argv[2], String(process.pid));
if (process.argv[3] === "delay") process.stdin.resume();
else await new Server({ name: "owned-child", version: "1.0.0" }, { capabilities: {} }).connect(new StdioServerTransport());
`,
    );
    for (const delayed of [false, true]) {
      runtime = await createAgentRuntime({ cwd: second, ...options });
      const connecting = runtime.connectMcpServers({
        child: { command: process.execPath, args: [script, pidFile, ...(delayed ? ["delay"] : [])] },
      });
      const pid = await waitForPid(pidFile);
      if (!delayed) {
        await connecting;
        assert.equal(getActiveMcpConnections().length, 1);
      }
      await runtime.dispose();
      await connecting;
      await waitForExit(pid);
      await rm(pidFile);
    }
  });

  await check("LSP startup and clients are owned and disposed without leaving child processes", async () => {
    const script = path.join(root, "lsp.cjs");
    const pidFile = path.join(root, "lsp.pid");
    await write(
      script,
      `
const fs = require("node:fs");
fs.writeFileSync(process.argv[2], String(process.pid));
let buffer = Buffer.alloc(0);
process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\\r\\n\\r\\n");
    if (end < 0) return;
    const size = Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + size) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + size));
    buffer = buffer.subarray(end + 4 + size);
    if (message.id === undefined) continue;
    if (process.argv[3] === "delay" && message.method === "initialize") continue;
    const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize" ? { capabilities: {} } : null });
    process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
  }
});
`,
    );
    const registration = (delay = false) => ({
      name: "language",
      cwd: first,
      config: LspServerSchema.parse({
        command: process.execPath,
        args: [script, pidFile, ...(delay ? ["delay"] : [])],
        extensionToLanguage: { ".ts": "typescript" },
      }),
    });
    const a = scope(),
      b = scope();
    await runInRuntimeScope(a, async () => {
      assert.deepEqual(await applyLspServers([registration()]), []);
      assert.equal(getLspStatus()[0]?.status, "ready");
    });
    runInRuntimeScope(b, () => assert.deepEqual(getLspStatus(), []));
    const firstPid = Number(await readFile(pidFile, "utf8"));
    await disposeRuntimeScope(a);
    await waitForExit(firstPid);
    await rm(pidFile);
    const starting = runInRuntimeScope(b, () => applyLspServers([registration(true)]));
    const pendingPid = await waitForPid(pidFile);
    await disposeRuntimeScope(b);
    await starting;
    await waitForExit(pendingPid);
    runInRuntimeScope(b, () => assert.deepEqual(getLspStatus(), []));
  });
} finally {
  for (const gate of gates.values()) gate.release.resolve();
  await runtime?.dispose();
  await Promise.all(scopes.map(disposeRuntimeScope));
  await Promise.all([...remotes.values()].map((remote) => remote.server.close()));
  http.closeAllConnections();
  await new Promise<void>((resolve) => http.close(() => resolve()));
  process.env = originalEnv;
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

async function waitForExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Child ${pid} survived disposal`);
}

async function waitForPid(file: string): Promise<number> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const pid = await readFile(file, "utf8")
      .then(Number)
      .catch(() => undefined);
    if (pid) return pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Child did not reach initialization");
}
