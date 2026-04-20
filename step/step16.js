/**
 * Step 16 - MCP client integration
 *
 * Goal:
 * - load MCP server configs from settings.json
 * - connect to stdio / http / sse servers
 * - fetch tools/list from each server
 * - wrap MCP tools as local Tool objects
 * - keep a small in-memory registry for `/mcp`
 *
 * This file is a teaching version that condenses the core mechanics.
 */

// -----------------------------------------------------------------------------
// 1. Config types and validation
// -----------------------------------------------------------------------------

export function validateServerConfig(name, raw, scope) {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "mcpServers." + name + " must be an object" };
  }

  const type = raw.type;
  if (type !== undefined && type !== "stdio" && type !== "http" && type !== "sse") {
    return {
      ok: false,
      error:
        "mcpServers." +
        name +
        " (" +
        scope +
        "): unsupported transport '" +
        String(type) +
        "'. Use stdio, http, or sse.",
    };
  }

  if (type === "http" || type === "sse") {
    if (typeof raw.url !== "string" || raw.url.trim().length === 0) {
      return { ok: false, error: "mcpServers." + name + " (" + scope + "): url is required" };
    }
    return {
      ok: true,
      value: {
        type,
        url: raw.url,
        headers: raw.headers || undefined,
      },
    };
  }

  if (typeof raw.command !== "string" || raw.command.trim().length === 0) {
    return { ok: false, error: "mcpServers." + name + " (" + scope + "): command is required" };
  }

  return {
    ok: true,
    value: {
      type: "stdio",
      command: raw.command,
      args: Array.isArray(raw.args) ? raw.args : [],
      env: raw.env || undefined,
    },
  };
}

// -----------------------------------------------------------------------------
// 2. Name normalization
// -----------------------------------------------------------------------------

export function normalizeNameForMcp(name) {
  return String(name).replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function buildMcpToolName(serverName, toolName) {
  return "mcp__" + normalizeNameForMcp(serverName) + "__" + normalizeNameForMcp(toolName);
}

export function parseMcpToolName(fullName) {
  const parts = String(fullName).split("__");
  if (parts.length < 3 || parts[0] !== "mcp" || !parts[1]) {
    return null;
  }
  return {
    serverName: parts[1],
    toolName: parts.slice(2).join("__"),
  };
}

// -----------------------------------------------------------------------------
// 3. Small MCP registry
// -----------------------------------------------------------------------------

const registryEntries = new Map();

export function setMcpRegistryEntry(name, connection, tools) {
  registryEntries.set(name, { connection, tools });
}

export function getMcpRegistry() {
  return Array.from(registryEntries.values());
}

export function getMcpRegistryEntry(name) {
  return registryEntries.get(name);
}

export function clearMcpRegistry() {
  registryEntries.clear();
}

// -----------------------------------------------------------------------------
// 4. Transport factories (teaching stubs)
// -----------------------------------------------------------------------------

export function createStdioTransport(config) {
  return {
    kind: "stdio",
    describe: "stdio: " + config.command + " " + (config.args || []).join(" "),
    transport: {
      type: "stdio",
      command: config.command,
      args: config.args || [],
      env: config.env || {},
    },
    collectStderrTail() {
      return "";
    },
    async preCleanup() {},
  };
}

export function createHttpTransport(config) {
  return {
    kind: "http",
    describe: "http: " + config.url,
    transport: {
      type: "http",
      url: config.url,
      headers: {
        "User-Agent": "easy-agent/0.1.0",
        ...(config.headers || {}),
      },
    },
    collectStderrTail() {
      return "";
    },
    async preCleanup() {},
  };
}

export function createSseTransport(config) {
  const headers = {
    "User-Agent": "easy-agent/0.1.0",
    ...(config.headers || {}),
  };

  return {
    kind: "sse",
    describe: "sse: " + config.url,
    transport: {
      type: "sse",
      url: config.url,
      requestHeaders: headers,
      eventSourceHeaders: {
        ...headers,
        Accept: "text/event-stream",
      },
    },
    collectStderrTail() {
      return "";
    },
    async preCleanup() {},
  };
}

export function createTransportBundle(config) {
  if (config.type === "http") return createHttpTransport(config);
  if (config.type === "sse") return createSseTransport(config);
  return createStdioTransport(config);
}

// -----------------------------------------------------------------------------
// 5. Connection cache + connect flow
// -----------------------------------------------------------------------------

const connectionCache = new Map();

function getCacheKey(name, config) {
  return name + ":" + JSON.stringify(config);
}

export async function connectToServer(name, config) {
  const cacheKey = getCacheKey(name, config);
  if (connectionCache.has(cacheKey)) {
    return connectionCache.get(cacheKey);
  }

  const promise = doConnect(name, config);
  connectionCache.set(cacheKey, promise);
  return promise;
}

async function doConnect(name, config) {
  const bundle = createTransportBundle(config);

  // In the real implementation this is where the MCP SDK Client connects.
  return {
    name,
    type: "connected",
    config,
    capabilities: { tools: {} },
    serverInfo: { name, version: "0.0.0" },
    client: {
      async request(payload) {
        if (payload.method === "tools/list") {
          return {
            tools: [
              {
                name: "echo",
                description: "Echo back the provided message.",
                inputSchema: {
                  type: "object",
                  properties: { message: { type: "string" } },
                  required: ["message"],
                },
                annotations: { readOnlyHint: true },
              },
            ],
          };
        }

        if (payload.method === "tools/call") {
          return {
            content: [{ type: "text", text: String(payload.params.arguments.message || "") }],
            isError: false,
          };
        }

        throw new Error("Unsupported MCP request: " + payload.method);
      },
    },
    async cleanup() {
      await bundle.preCleanup();
    },
  };
}

// -----------------------------------------------------------------------------
// 6. MCP tool adapter
// -----------------------------------------------------------------------------

function stringifyMcpContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "image") return "[image block]";
      if (block.type === "resource") return block.resource?.text || "[resource block]";
      return "[unknown block]";
    })
    .join("\n");
}

export function buildToolAdapter(connection, mcpTool) {
  const fullName = buildMcpToolName(connection.name, mcpTool.name);

  return {
    name: fullName,
    description: String(mcpTool.description || "").slice(0, 2048),
    inputSchema: mcpTool.inputSchema || { type: "object", properties: {} },
    isReadOnly() {
      return Boolean(mcpTool.annotations?.readOnlyHint);
    },
    isEnabled() {
      return true;
    },
    async call(rawInput) {
      const result = await connection.client.request({
        method: "tools/call",
        params: {
          name: mcpTool.name,
          arguments: rawInput,
        },
      });

      return {
        content: stringifyMcpContent(result.content),
        isError: result.isError === true,
      };
    },
  };
}

export async function fetchToolsForConnection(connection) {
  if (!connection.capabilities?.tools) {
    return [];
  }

  const result = await connection.client.request({ method: "tools/list" });
  return result.tools.map((tool) => buildToolAdapter(connection, tool));
}

// -----------------------------------------------------------------------------
// 7. Bootstrap flow
// -----------------------------------------------------------------------------

export async function bootstrapMcp(serverConfigs) {
  clearMcpRegistry();

  for (const [name, config] of Object.entries(serverConfigs)) {
    setMcpRegistryEntry(name, {
      name,
      type: "pending",
      config,
      startedAt: Date.now(),
    }, []);
  }

  const results = await Promise.all(
    Object.entries(serverConfigs).map(async ([name, config]) => {
      const connection = await connectToServer(name, config);
      const tools = connection.type === "connected" ? await fetchToolsForConnection(connection) : [];
      setMcpRegistryEntry(name, connection, tools);
      return { connection, tools };
    }),
  );

  return {
    connections: results.map((item) => item.connection),
    toolCount: results.reduce((sum, item) => sum + item.tools.length, 0),
  };
}
