/**
 * MCP startup orchestration.
 *
 * Called once from the CLI entrypoint before the React UI mounts. This is
 * the equivalent of the source's `prefetchAllMcpResources` /
 * `getMcpToolsCommandsAndResources` (client.ts:2228+) — minus the React
 * Hook lifecycle, since Easy Agent doesn't yet need live reconnection.
 *
 * Flow:
 *   1. Load + validate `mcpServers` from settings.json
 *   2. Spawn every server in parallel (Promise.allSettled)
 *   3. For each connected server, fetch its tools/list
 *   4. Register the flat tool array into the global registry
 *   5. Install a SIGINT/SIGTERM cleanup hook so child procs don't leak
 */

import type { McpServerConnection, PendingMcpServer } from "../../types/mcp.js";
import { registerMcpTools } from "../../tools/index.js";
import { loadMcpConfigs } from "./config.js";
import {
  connectToServer,
  registerMcpProcessCleanup,
  clearServerCache,
} from "./client.js";
import { fetchToolsForConnection } from "./fetchTools.js";
import {
  clearMcpRegistry,
  deleteMcpRegistryEntry,
  getMcpRegistry,
  getMcpRegistryEntry,
  setMcpRegistryEntry,
} from "./registry.js";
import { debugLog } from "../../utils/log.js";

export interface McpBootstrapResult {
  connections: McpServerConnection[];
  toolCount: number;
  configErrors: string[];
}

/**
 * Asynchronously bring up every configured MCP server WITHOUT blocking
 * the caller longer than necessary.
 *
 * Behavior contract:
 *   - On entry: every configured server is immediately registered as
 *     `{ type: 'pending' }` so `/mcp` shows accurate state from t=0.
 *   - Each server connects in parallel via `Promise.allSettled`, and the
 *     registry entry is REPLACED atomically when the connection resolves
 *     (or fails / times out via the per-server timeout in client.ts).
 *   - Whenever the registry changes, the global Tool registry is refreshed
 *     so `getAllTools()` includes any newly available MCP tools on the
 *     next call.
 *   - The returned promise only resolves after EVERY server has reached
 *     a terminal state; it's safe to ignore (`void bootstrapMcp(...)`)
 *     when you want non-blocking startup — just like Claude Code's
 *     `prefetchAllMcpResources` running inside a useEffect.
 */
export async function bootstrapMcp(cwd: string): Promise<McpBootstrapResult> {
  const { servers, errors: configErrors } = await loadMcpConfigs(cwd);
  registerMcpProcessCleanup();
  clearMcpRegistry();

  // Seed `pending` placeholders BEFORE any IO. This is the key change that
  // lets the UI render immediately and `/mcp` show "connecting" servers
  // instead of "0 configured" during a cold `npx -y` install.
  const startedAt = Date.now();
  for (const [name, config] of Object.entries(servers)) {
    const placeholder: PendingMcpServer = { name, type: "pending", config, startedAt };
    setMcpRegistryEntry(name, placeholder, []);
  }
  refreshGlobalToolRegistry();

  // Now connect each server in parallel. Each one independently updates
  // the registry as it resolves, so MCP tools become available
  // incrementally — slow servers don't block fast ones.
  const tasks = Object.entries(servers).map(([name, config]) =>
    connectAndRegister(name, config),
  );
  const settled = await Promise.allSettled(tasks);

  const connections: McpServerConnection[] = [];
  let toolCount = 0;
  for (let i = 0; i < settled.length; i++) {
    const res = settled[i];
    const name = Object.keys(servers)[i];
    if (res.status === "fulfilled") {
      connections.push(res.value.connection);
      toolCount += res.value.toolCount;
    } else {
      const failed = getMcpRegistryEntry(name)?.connection;
      if (failed) connections.push(failed);
    }
  }

  return { connections, toolCount, configErrors };
}

async function connectAndRegister(
  name: string,
  config: PendingMcpServer["config"],
): Promise<{ connection: McpServerConnection; toolCount: number }> {
  const connection = await connectToServer(name, config);
  let tools: Awaited<ReturnType<typeof fetchToolsForConnection>> = [];
  if (connection.type === "connected") {
    try {
      tools = await fetchToolsForConnection(connection);
    } catch (error) {
      debugLog("mcp", `[${name}] tools/list failed after connect: ${(error as Error).message}`);
    }
  }
  setMcpRegistryEntry(name, connection, tools);
  refreshGlobalToolRegistry();
  return { connection, toolCount: tools.length };
}

/** Flatten every registered MCP server's tools and push them to the global Tool registry. */
function refreshGlobalToolRegistry(): void {
  const allTools = getMcpRegistry().flatMap((entry) => entry.tools);
  registerMcpTools(allTools);
}

/**
 * Reconnect a single MCP server. Returns the new connection state. Used by
 * `/mcp reconnect <name>`.
 */
export async function reconnectMcpServer(name: string): Promise<McpServerConnection | null> {
  const entry = getMcpRegistryEntry(name);
  if (!entry) return null;

  await clearServerCache(name, entry.connection.config);
  deleteMcpRegistryEntry(name);
  refreshGlobalToolRegistry();

  const connection = await connectToServer(name, entry.connection.config);
  const tools = connection.type === "connected" ? await fetchToolsForConnection(connection) : [];
  setMcpRegistryEntry(name, connection, tools);
  refreshGlobalToolRegistry();

  return connection;
}
