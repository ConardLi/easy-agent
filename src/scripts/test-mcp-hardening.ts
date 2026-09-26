import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ConnectedMcpServer } from "../types/mcp.js";
import { fetchToolsForConnection } from "../services/mcp/fetchTools.js";
import { readMcpResourceTool } from "../tools/readMcpResourceTool.js";
import { clearMcpRegistry, setMcpRegistryEntry } from "../services/mcp/registry.js";
import { applyPluginMcpDiff } from "../plugins/mcpApply.js";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { connectToServer, clearServerCache, _resetMcpClientForTesting, setMcpConnectionListeners } from "../services/mcp/client.js";
import { getMcpRegistryEntry } from "../services/mcp/registry.js";
import { createMcpFetch } from "../services/mcp/remoteHeaders.js";
import { resolveMcpHeaders } from "../services/mcp/remoteHeaders.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { createMcpAuthSession } from "../services/mcp/oauth.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { bootstrapMcp, reconnectMcpServer } from "../services/mcp/bootstrap.js";
import { trustProjectForSession } from "../config/globalState.js";
import { subscribeMcpProgress } from "../state/mcpProgressStore.js";
import { adaptMcpToolResult, storeMcpArtifact } from "../services/mcp/resultContent.js";
import { loadMcpConfigs } from "../services/mcp/config.js";

const home = await mkdtemp(path.join(os.tmpdir(), "easy-agent-mcp-hardening-"));
const originalHome = process.env.HOME;
const originalProfile = process.env.USERPROFILE;
process.env.HOME = home;
process.env.USERPROFILE = home;

const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
const binary = Buffer.from("\0binary\xff").toString("base64");
const result = {
  content: [
    { type: "text", text: "plain text" },
    { type: "image", data: png, mimeType: "image/png", _meta: { source: "fixture" } },
    { type: "resource", resource: { uri: "memo://one", text: "embedded text", mimeType: "text/plain" } },
    { type: "resource", resource: { uri: "memo://two", blob: binary, mimeType: "application/octet-stream" } },
    { type: "future_block", value: { keep: true } },
  ],
  structuredContent: { count: 2, nested: { active: true } },
  _meta: { traceId: "trace-123" },
};

const client = {
  request: async (request: { method: string }, _schema: unknown, options?: { onprogress?: (progress: { progress: number; total: number; message: string }) => void }) => {
    if (request.method === "tools/list") return { tools: [{ name: "mixed", description: "Mixed MCP result", inputSchema: { type: "object", properties: {} } }] };
    if (request.method === "tools/call") {
      options?.onprogress?.({ progress: 1, total: 2, message: "working" });
      return result;
    }
    if (request.method === "resources/read") return { contents: [{ uri: "memo://two", blob: binary, mimeType: "application/octet-stream" }] };
    throw new Error(`Unexpected method ${request.method}`);
  },
} as unknown as Client;

const connection: ConnectedMcpServer = {
  name: "fixture",
  type: "connected",
  client,
  capabilities: { tools: {}, resources: {} },
  config: { type: "stdio", command: "fixture", scope: "user" },
  cleanup: async () => {},
};

try {
  setMcpRegistryEntry("fixture", connection, []);
  const [tool] = await fetchToolsForConnection(connection);
  assert.ok(tool);
  const progressEvents: Array<{ progress: number; total?: number; message?: string } | null> = [];
  const unsubscribe = subscribeMcpProgress((id, progress) => { if (id === "mixed-call") progressEvents.push(progress); });
  const adapted = await tool.call({}, { cwd: home, toolUseId: "mixed-call" });
  unsubscribe();
  assert.deepEqual(progressEvents[0], { progress: 1, total: 2, message: "working" });
  assert.equal(progressEvents.at(-1), null);
  assert.equal(adapted.isError, false);
  assert.ok(Array.isArray(adapted.content), "image and text are delivered as content blocks");
  const blocks = adapted.content as unknown as Array<Record<string, unknown>>;
  assert.ok(blocks.some((block) => block.type === "image" && (block.source as { data?: string }).data === png));
  assert.ok(blocks.some((block) => block.type === "text" && String(block.text).includes("embedded text")));
  assert.ok(blocks.some((block) => block.type === "text" && String(block.text).includes('"count": 2')));
  assert.ok(blocks.some((block) => block.type === "text" && String(block.text).includes("future_block")));
  const raw = (adapted as typeof adapted & { mcpResult?: typeof result }).mcpResult;
  assert.deepEqual(raw?.structuredContent, result.structuredContent);
  assert.deepEqual(raw?._meta, result._meta);
  const plainError = await adaptMcpToolResult({ content: [{ type: "text", text: "failure" }], isError: true, _meta: { traceId: "error" } });
  assert.equal(plainError.content, "failure");
  assert.equal(plainError.isError, true);
  assert.deepEqual(plainError.mcpResult?._meta, { traceId: "error" });
  const plainSuccess = await adaptMcpToolResult({ content: [
    { type: "text", text: "first" },
    { type: "resource", resource: { uri: "memo://text", text: "embedded" } },
    { type: "text", text: "last" },
  ] });
  assert.equal(plainSuccess.content, "first\nembedded\nlast");
  await assert.rejects(storeMcpArtifact("not base64!", "application/octet-stream"), /base64/);
  await assert.rejects(adaptMcpToolResult({ content: [{ type: "image", mimeType: "image/png", data: "not base64!" }] }), /base64/);

  const validationProject = path.join(home, "validation");
  await mkdir(path.join(validationProject, ".easy-agent"), { recursive: true });
  await writeFile(path.join(validationProject, ".easy-agent", "settings.json"), JSON.stringify({
    mcpServers: {
      valid: { type: "http", url: "https://mcp.example.test/api", headersEnv: { Authorization: "MCP_HARDENING_TOKEN" }, headersHelper: { command: process.execPath, args: [] } },
      oauth: { type: "http", url: "https://mcp.example.test/api", oauth: true },
      conflicting: { type: "http", url: "https://mcp.example.test/api", oauth: true, headers: { Authorization: "Bearer secret" } },
      badHeader: { type: "http", url: "https://mcp.example.test/api", headersEnv: { "Bad Header": "MCP_HARDENING_TOKEN" } },
    },
  }));
  await trustProjectForSession(validationProject);
  const validated = await loadMcpConfigs(validationProject);
  assert.equal(validated.servers.valid?.type, "http");
  assert.equal(validated.servers.oauth?.type, "http");
  assert.equal(validated.servers.conflicting, undefined);
  assert.equal(validated.servers.badHeader, undefined);

  const resource = await readMcpResourceTool.call({ server: "fixture", uri: "memo://two" }, { cwd: home });
  assert.equal(resource.isError, undefined);
  const parsed = JSON.parse(String(resource.content)) as { contents: Array<{ filePath?: string }> };
  assert.ok(parsed.contents[0]?.filePath);
  assert.deepEqual(await readFile(parsed.contents[0]!.filePath!), Buffer.from(binary, "base64"));

  let bearer = "one";
  process.env.MCP_HARDENING_TOKEN = bearer;
  const headersConfig = { type: "http" as const, url: "http://127.0.0.1:1/mcp", headersEnv: { Authorization: "MCP_HARDENING_TOKEN" } };
  const observed: string[] = [];
  const dynamicFetch = createMcpFetch(headersConfig);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    observed.push(new Headers(init?.headers).get("Authorization") ?? "");
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    await dynamicFetch(headersConfig.url);
    bearer = "two";
    process.env.MCP_HARDENING_TOKEN = bearer;
    await dynamicFetch(headersConfig.url);
    assert.deepEqual(observed, ["one", "two"]);
  } finally { globalThis.fetch = originalFetch; }
  const helperHeaders = await resolveMcpHeaders({
    type: "http",
    url: headersConfig.url,
    headersHelper: { command: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify({Authorization: 'Bearer helper-token'}))"] },
  });
  assert.equal(helperHeaders.get("Authorization"), "Bearer helper-token");

  const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();
  let serverInstances = 0;
  let executed = 0;
  let expireOnce = true;
  let listSeen = false;
  let sawRootsCapability = false;
  const httpServer = createServer(async (request, response) => {
    try {
      if (request.method === "GET") { response.writeHead(405).end(); return; }
      const sessionId = request.headers["mcp-session-id"];
      const sessionKey = typeof sessionId === "string" ? sessionId : undefined;
      if (sessionKey && !sessions.has(sessionKey)) { response.writeHead(404).end(); return; }
      if (sessionKey && listSeen && expireOnce && request.method === "POST") {
        expireOnce = false;
        sessions.delete(sessionKey);
        response.writeHead(404).end();
        return;
      }
      if (request.method === "DELETE") {
        if (sessionKey) sessions.delete(sessionKey);
        response.writeHead(200).end();
        return;
      }
      let current = sessionKey ? sessions.get(sessionKey) : undefined;
      if (!current) {
        serverInstances += 1;
        const server = new Server({ name: "hardening-fixture", version: "1.0" }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => {
          listSeen = true;
          sawRootsCapability = Boolean(server.getClientCapabilities()?.roots);
          return { tools: [{ name: "change", inputSchema: { type: "object", properties: {} } }] };
        });
        server.setRequestHandler(CallToolRequestSchema, async () => {
          executed += 1;
          return { content: [{ type: "text", text: `executed:${executed}` }] };
        });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: true,
          onsessioninitialized: (id) => { sessions.set(id, { server, transport }); },
        });
        await server.connect(transport);
        current = { server, transport };
      }
      await current.transport.handleRequest(request, response);
    } catch (error) {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  try {
    const address = httpServer.address();
    assert.ok(address && typeof address !== "string");
    const remoteConfig = { type: "http" as const, url: `http://127.0.0.1:${address.port}/mcp`, scope: "user" as const };
    const connected = await connectToServer("remote-hardening", remoteConfig);
    assert.equal(connected.type, "connected", connected.type === "failed" ? connected.error : "");
    if (connected.type !== "connected") throw new Error("MCP HTTP fixture failed to connect");
    assert.ok(connected.sessionId?.());
    const remoteTools = await fetchToolsForConnection(connected);
    assert.equal(sawRootsCapability, false, "unsupported Roots capability is not advertised");
    setMcpRegistryEntry("remote-hardening", connected, remoteTools);
    setMcpConnectionListeners({ onReconnectRequested: reconnectMcpServer });
    const call = await remoteTools[0]!.call({}, { cwd: home });
    assert.equal(call.content, "executed:1", JSON.stringify(call));
    assert.equal(executed, 1, "expired session was rejected before execution");
    assert.equal(getMcpRegistryEntry("remote-hardening")?.connection.type, "connected");

    let attempted = 0;
    const uncertainClient = {
      request: async () => { attempted += 1; throw new Error("Connection closed after request"); },
    } as unknown as Client;
    const uncertainConnection: ConnectedMcpServer = { ...connected, name: "uncertain", client: uncertainClient };
    const [uncertainTool] = await fetchToolsForConnection({ ...uncertainConnection, client: {
      request: async (request: { method: string }) => request.method === "tools/list"
        ? { tools: [{ name: "change", inputSchema: { type: "object", properties: {} } }] }
        : uncertainClient.request(request as never, {} as never),
    } as unknown as Client });
    assert.equal((await uncertainTool!.call({}, { cwd: home })).isError, true);
    assert.equal(attempted, 1, "ambiguous failure does not replay side-effecting calls");
    await clearServerCache("remote-hardening", remoteConfig);

    const project = path.join(home, "project");
    await mkdir(path.join(project, ".easy-agent"), { recursive: true });
    await writeFile(path.join(project, ".easy-agent", "settings.json"), JSON.stringify({
      mcpServers: { recoverable: { type: "http", url: remoteConfig.url } },
    }));
    await trustProjectForSession(project);
    const bootstrapped = await bootstrapMcp(project);
    const first = bootstrapped.connections[0];
    assert.equal(first?.type, "connected");
    if (first?.type !== "connected") throw new Error("Recovery fixture failed to connect");
    await first.client.close();
    assert.equal(getMcpRegistryEntry("recoverable")?.connection.type, "pending");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && getMcpRegistryEntry("recoverable")?.connection.type !== "connected") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const recovered = getMcpRegistryEntry("recoverable")?.connection;
    assert.equal(recovered?.type, "connected", "closed connection recovered automatically");
    if (recovered?.type === "connected") await clearServerCache("recoverable", recovered.config);

    const pluginName = "plugin__recoverable";
    const enabled = new Map([[pluginName, remoteConfig]]);
    await applyPluginMcpDiff(new Map(), enabled);
    const pluginConnection = getMcpRegistryEntry(pluginName)?.connection;
    assert.equal(pluginConnection?.type, "connected");
    if (pluginConnection?.type !== "connected") throw new Error("Plugin MCP fixture failed to connect");
    await pluginConnection.client.close();
    assert.equal(getMcpRegistryEntry(pluginName)?.connection.type, "pending");
    await applyPluginMcpDiff(enabled, new Map());
    assert.equal(getMcpRegistryEntry(pluginName), undefined);
    const instancesAfterDisable = serverInstances;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(serverInstances, instancesAfterDisable, "disabled plugin server must not be restarted by a queued retry");
  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }

  let tokenNumber = 0;
  let acceptedToken = "token-1";
  let oauthCalls = 0;
  const oauthServer = createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${(oauthServer.address() as { port: number }).port}`;
    if (request.url === "/.well-known/oauth-protected-resource/mcp") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        resource: `${origin}/mcp`, authorization_servers: [origin],
      }));
      return;
    }
    if (request.url === "/.well-known/oauth-authorization-server") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["client_credentials"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
      }));
      return;
    }
    if (request.url === "/token") {
      assert.equal(request.headers.authorization, `Basic ${Buffer.from("client:secret").toString("base64")}`);
      tokenNumber += 1;
      acceptedToken = `token-${tokenNumber}`;
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        access_token: acceptedToken, token_type: "Bearer", expires_in: 3600,
      }));
      return;
    }
    if (request.url !== "/mcp") { response.writeHead(404).end(); return; }
    if (request.headers.authorization !== `Bearer ${acceptedToken}` || tokenNumber === 0) {
      response.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }).end();
      return;
    }
    if (request.method === "GET") { response.writeHead(405).end(); return; }
    const server = new Server({ name: "oauth-fixture", version: "1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => {
      oauthCalls += 1;
      return { content: [{ type: "text", text: `oauth:${oauthCalls}` }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(request, response);
  });
  await new Promise<void>((resolve) => oauthServer.listen(0, "127.0.0.1", resolve));
  try {
    const address = oauthServer.address();
    assert.ok(address && typeof address !== "string");
    const oauthConfig = {
      type: "http" as const,
      url: `http://127.0.0.1:${address.port}/mcp`,
      oauth: { type: "client_credentials" as const, clientId: "client", clientSecretEnv: "MCP_HARDENING_SECRET" },
      scope: "user" as const,
    };
    process.env.MCP_HARDENING_SECRET = "secret";
    const oauthConnection = await connectToServer("oauth-hardening", oauthConfig);
    assert.equal(oauthConnection.type, "connected", oauthConnection.type === "failed" ? oauthConnection.error : "");
    if (oauthConnection.type !== "connected") throw new Error("OAuth fixture failed to connect");
    const oauthTools = await fetchToolsForConnection(oauthConnection);
    setMcpRegistryEntry("oauth-hardening", oauthConnection, oauthTools);
    const tokensBeforeRotation = tokenNumber;
    acceptedToken = "expired";
    const authorized = await oauthTools[0]!.call({}, { cwd: home });
    assert.equal(authorized.content, "oauth:1", JSON.stringify(authorized));
    assert.ok(tokenNumber > tokensBeforeRotation, "OAuth credentials refreshed after a 401");
    assert.equal(oauthCalls, 1, "401 request was rejected before tool execution");
    await clearServerCache("oauth-hardening", oauthConfig);
  } finally {
    delete process.env.MCP_HARDENING_SECRET;
    await new Promise<void>((resolve) => oauthServer.close(() => resolve()));
  }

  const sseSessions = new Map<string, { server: Server; transport: SSEServerTransport }>();
  const seenSseHeaders: string[] = [];
  const sseServer = createServer(async (request, response) => {
    seenSseHeaders.push(request.headers.authorization ?? "");
    if (request.headers.authorization !== "Bearer sse-token") { response.writeHead(401).end(); return; }
    if (request.url === "/sse" && request.method === "GET") {
      const server = new Server({ name: "sse-fixture", version: "1.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }] }));
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "sse-ok" }] }));
      const transport = new SSEServerTransport("/messages", response);
      sseSessions.set(transport.sessionId, { server, transport });
      response.on("close", () => { sseSessions.delete(transport.sessionId); void server.close(); });
      await server.connect(transport);
      return;
    }
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const session = sseSessions.get(requestUrl.searchParams.get("sessionId") ?? "");
    if (requestUrl.pathname !== "/messages" || !session) { response.writeHead(404).end(); return; }
    await session.transport.handlePostMessage(request, response);
  });
  await new Promise<void>((resolve) => sseServer.listen(0, "127.0.0.1", resolve));
  try {
    const address = sseServer.address();
    assert.ok(address && typeof address !== "string");
    process.env.MCP_HARDENING_SSE_TOKEN = "Bearer sse-token";
    const sseConfig = {
      type: "sse" as const,
      url: `http://127.0.0.1:${address.port}/sse`,
      headersEnv: { Authorization: "MCP_HARDENING_SSE_TOKEN" },
      scope: "user" as const,
    };
    const sseConnection = await connectToServer("sse-hardening", sseConfig);
    assert.equal(sseConnection.type, "connected", sseConnection.type === "failed" ? sseConnection.error : "");
    if (sseConnection.type !== "connected") throw new Error("SSE fixture failed to connect");
    const sseTools = await fetchToolsForConnection(sseConnection);
    setMcpRegistryEntry("sse-hardening", sseConnection, sseTools);
    assert.equal((await sseTools[0]!.call({}, { cwd: home })).content, "sse-ok");
    assert.ok(seenSseHeaders.length >= 2 && seenSseHeaders.every((value) => value === "Bearer sse-token"));
    await clearServerCache("sse-hardening", sseConfig);

    const staticSseConfig = {
      type: "sse" as const,
      url: sseConfig.url,
      headers: { Authorization: "Bearer sse-token" },
      scope: "user" as const,
    };
    const staticSseConnection = await connectToServer("sse-static-headers", staticSseConfig);
    assert.equal(staticSseConnection.type, "connected", staticSseConnection.type === "failed" ? staticSseConnection.error : "");
    if (staticSseConnection.type !== "connected") throw new Error("Static SSE headers fixture failed to connect");
    const staticSseTools = await fetchToolsForConnection(staticSseConnection);
    assert.equal((await staticSseTools[0]!.call({}, { cwd: home })).content, "sse-ok");
    assert.ok(seenSseHeaders.length >= 4 && seenSseHeaders.every((value) => value === "Bearer sse-token"));
    await clearServerCache("sse-static-headers", staticSseConfig);
  } finally {
    delete process.env.MCP_HARDENING_SSE_TOKEN;
    await new Promise<void>((resolve) => sseServer.close(() => resolve()));
  }

  let registeredRedirect = "";
  let issuedCode = "";
  const authCodeServer = createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${(authCodeServer.address() as { port: number }).port}`;
    if (request.url === "/.well-known/oauth-protected-resource/mcp" || request.url === "/.well-known/oauth-protected-resource/mcp-live") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ resource: `${origin}/${request.url.endsWith("mcp-live") ? "mcp-live" : "mcp"}`, authorization_servers: [origin] }));
      return;
    }
    if (request.url === "/.well-known/oauth-authorization-server") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`, response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
      }));
      return;
    }
    if (request.url === "/register") {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      registeredRedirect = (JSON.parse(body) as { redirect_uris: string[] }).redirect_uris[0]!;
      response.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ client_id: "registered-client", redirect_uris: [registeredRedirect] }));
      return;
    }
    if (request.url?.startsWith("/authorize?")) {
      const url = new URL(request.url, origin);
      assert.equal(url.searchParams.get("redirect_uri"), registeredRedirect);
      issuedCode = "auth-code";
      const redirect = new URL(registeredRedirect);
      redirect.searchParams.set("code", issuedCode);
      redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
      response.writeHead(302, { Location: redirect.toString() }).end();
      return;
    }
    if (request.url === "/token") {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      assert.equal(new URLSearchParams(body).get("code"), issuedCode);
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ access_token: "code-token", token_type: "Bearer", refresh_token: "refresh-token" }));
      return;
    }
    if (request.url === "/mcp-live") {
      if (request.headers.authorization !== "Bearer code-token") {
        response.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp-live"` }).end();
        return;
      }
      if (request.method === "GET") { response.writeHead(405).end(); return; }
      const server = new Server({ name: "auth-code-fixture", version: "1.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }] }));
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "authorized" }] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      response.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(request, response);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => authCodeServer.listen(0, "127.0.0.1", resolve));
  try {
    const address = authCodeServer.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/mcp`;
    const session = await createMcpAuthSession("direct-auth", url, { type: "authorization_code" });
    assert.ok(session?.interactive);
    assert.equal(await auth(session.provider, { serverUrl: url }), "REDIRECT");
    const authorizationUrl = session.interactive.pendingAuthorizationUrl;
    assert.ok(authorizationUrl);
    assert.equal((await fetch(authorizationUrl)).status, 200);
    const code = await session.interactive.waitForCode();
    assert.equal(code, issuedCode);
    assert.equal(await auth(session.provider, { serverUrl: url, authorizationCode: code }), "AUTHORIZED");
    assert.equal((await session.provider.tokens())?.access_token, "code-token");
    session.close();
    const restored = await createMcpAuthSession("direct-auth", url, { type: "authorization_code" });
    assert.equal((await restored?.provider.tokens())?.access_token, "code-token");
    restored?.close();

    const project = path.join(home, "oauth-project");
    const liveUrl = `http://127.0.0.1:${address.port}/mcp-live`;
    await mkdir(path.join(project, ".easy-agent"), { recursive: true });
    await writeFile(path.join(project, ".easy-agent", "settings.json"), JSON.stringify({
      mcpServers: { interactive: { type: "http", url: liveUrl, oauth: true } },
    }));
    await trustProjectForSession(project);
    const started = await bootstrapMcp(project);
    const initial = started.connections[0];
    assert.equal(initial?.type, "failed");
    if (initial?.type !== "failed") throw new Error("OAuth code flow did not request authorization");
    assert.match(initial.error, /^Authorization required: http/);
    const restarted = await reconnectMcpServer("interactive");
    assert.equal(restarted?.type, "failed", "manual reconnect restarts pending authorization");
    if (restarted?.type !== "failed") throw new Error("OAuth reconnect did not request authorization");
    assert.equal((await fetch(restarted.error.slice("Authorization required: ".length))).status, 200);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && getMcpRegistryEntry("interactive")?.connection.type !== "connected") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const authorizedConnection = getMcpRegistryEntry("interactive")?.connection;
    assert.equal(authorizedConnection?.type, "connected", "OAuth callback reconnects automatically");
    if (authorizedConnection?.type === "connected") {
      const tools = await fetchToolsForConnection(authorizedConnection);
      assert.equal((await tools[0]!.call({}, { cwd: home })).content, "authorized");
      await clearServerCache("interactive", authorizedConnection.config);
    }
  } finally {
    await new Promise<void>((resolve) => authCodeServer.close(() => resolve()));
  }

  console.log("MCP content fidelity checks passed.");
} finally {
  delete process.env.MCP_HARDENING_TOKEN;
  _resetMcpClientForTesting();
  clearMcpRegistry();
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalProfile;
  await rm(home, { recursive: true, force: true });
}
