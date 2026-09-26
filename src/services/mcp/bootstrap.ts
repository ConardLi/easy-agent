/** Start configured MCP servers and keep the tool registry in sync. */

import type { McpServerConnection, PendingMcpServer } from "../../types/mcp.js";
import { registerMcpTools } from "../../tools/index.js";
import { loadMcpConfigs } from "./config.js";
import {
  connectToServer,
  registerMcpProcessCleanup,
  clearServerCache,
  setMcpConnectionListeners,
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

const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
const reconnectAttempts = new Map<string, number>();
const reconnecting = new Map<string, Promise<void>>();
const requestedReconnects = new Map<string, Promise<McpServerConnection | null>>();

function stopReconnect(name: string): void {
  const timer = reconnectTimers.get(name);
  if (timer) clearTimeout(timer);
  reconnectTimers.delete(name);
  reconnectAttempts.delete(name);
}

export function cancelMcpReconnect(name: string): void {
  stopReconnect(name);
}

function scheduleReconnect(name: string, config: PendingMcpServer["config"], immediate = false): void {
  if (reconnectTimers.has(name) || reconnecting.has(name)) return;
  const entry = getMcpRegistryEntry(name);
  if (!entry || entry.connection.config !== config) return;
  const attempt = reconnectAttempts.get(name) ?? 0;
  const delay = immediate ? 0 : Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
  reconnectAttempts.set(name, attempt + 1);
  const timer = setTimeout(() => {
    reconnectTimers.delete(name);
    if (getMcpRegistryEntry(name)?.connection.config !== config) {
      stopReconnect(name);
      return;
    }
    const task = (async () => {
      await clearServerCache(name, config);
      if (getMcpRegistryEntry(name)?.connection.config !== config) return;
      await connectAndRegister(name, config);
    })().catch((error) => {
      debugLog("mcp", `[${name}] reconnect failed: ${(error as Error).message}`);
      scheduleReconnect(name, config);
    }).finally(() => {
      reconnecting.delete(name);
      const current = getMcpRegistryEntry(name);
      if (current?.connection.config === config && current.connection.type === "failed" && !current.connection.error.startsWith("Authorization required:")) {
        scheduleReconnect(name, config);
      }
    });
    reconnecting.set(name, task);
  }, delay);
  timer.unref?.();
  reconnectTimers.set(name, timer);
}

/** Connect configured servers in parallel and publish each result as it arrives. */
export async function bootstrapMcp(cwd: string): Promise<McpBootstrapResult> {
  const { servers, errors: configErrors } = await loadMcpConfigs(cwd);
  registerMcpProcessCleanup();
  for (const name of reconnectTimers.keys()) stopReconnect(name);
  setMcpConnectionListeners({
    onUnexpectedClose: (name, config) => {
      const entry = getMcpRegistryEntry(name);
      if (!entry || entry.connection.config !== config) return;
      setMcpRegistryEntry(name, { name, type: "pending", config, startedAt: Date.now() }, []);
      refreshGlobalToolRegistry();
      scheduleReconnect(name, config);
    },
    onAuthorized: (name, config) => scheduleReconnect(name, config, true),
    onReconnectRequested: reconnectMcpServer,
  });
  clearMcpRegistry();

  const startedAt = Date.now();
  for (const [name, config] of Object.entries(servers)) {
    const placeholder: PendingMcpServer = { name, type: "pending", config, startedAt };
    setMcpRegistryEntry(name, placeholder, []);
  }
  refreshGlobalToolRegistry();

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
  if (getMcpRegistryEntry(name)?.connection.config !== config) {
    if (connection.type === "connected") await connection.cleanup();
    return { connection, toolCount: 0 };
  }
  setMcpRegistryEntry(name, connection, tools);
  refreshGlobalToolRegistry();
  if (connection.type === "connected") {
    stopReconnect(name);
  } else if (connection.type === "failed" && !connection.error.startsWith("Authorization required:")) {
    scheduleReconnect(name, config);
  }
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
export function reconnectMcpServer(name: string): Promise<McpServerConnection | null> {
  const ongoing = requestedReconnects.get(name);
  if (ongoing) return ongoing;
  const attempt = reconnectMcpServerOnce(name);
  requestedReconnects.set(name, attempt);
  void attempt.finally(() => {
    if (requestedReconnects.get(name) === attempt) requestedReconnects.delete(name);
  }).catch(() => {});
  return attempt;
}

async function reconnectMcpServerOnce(name: string): Promise<McpServerConnection | null> {
  const entry = getMcpRegistryEntry(name);
  if (!entry) return null;

  stopReconnect(name);

  await clearServerCache(name, entry.connection.config);
  deleteMcpRegistryEntry(name);
  setMcpRegistryEntry(name, {
    name,
    type: "pending",
    config: entry.connection.config,
    startedAt: Date.now(),
  }, []);
  refreshGlobalToolRegistry();

  return (await connectAndRegister(name, entry.connection.config)).connection;
}
