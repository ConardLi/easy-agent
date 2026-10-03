/**
 * In-memory registry of MCP server connections + their tools.
 *
 * The `/mcp` slash command reads this to render its status panel without
 * having to re-discover servers. Updated by bootstrapMcp() at startup and
 * by `/mcp reconnect` afterwards.
 *
 * A plain module-level store is enough because the data is pull-based —
 * `/mcp` runs synchronously inside QueryEngine.handleCommand — so it does
 * not live in React state.
 */

import type { McpServerConnection } from "../../types/mcp.js";
import type { Tool } from "../../tools/Tool.js";

interface Entry {
  connection: McpServerConnection;
  tools: Tool[];
}

const entries = new Map<string, Entry>();

export function setMcpRegistryEntry(name: string, connection: McpServerConnection, tools: Tool[]): void {
  entries.set(name, { connection, tools });
}

export function deleteMcpRegistryEntry(name: string): void {
  entries.delete(name);
}

export function getMcpRegistry(): Array<{ connection: McpServerConnection; tools: Tool[] }> {
  return Array.from(entries.values());
}

export function getMcpRegistryEntry(name: string): Entry | undefined {
  return entries.get(name);
}

export function clearMcpRegistry(): void {
  entries.clear();
}

/**
 * Any server still in its `pending` placeholder state? While true, ToolSearch
 * stays in the request even with an empty deferred pool so the model can
 * discover the server's tools once it connects.
 */
export function hasPendingMcpServers(): boolean {
  for (const entry of entries.values()) {
    if (entry.connection.type === "pending") return true;
  }
  return false;
}
