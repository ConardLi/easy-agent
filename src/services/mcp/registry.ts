/**
 * In-memory registry of MCP server connections + their tools.
 *
 * The `/mcp` slash command reads this to render its status panel without
 * having to re-discover servers. Updated by bootstrapMcp() at startup and
 * by `/mcp reconnect` afterwards.
 *
 * (The source code stores this in React app state via `MCPConnectionManager`
 * + `useManageMCPConnections`. We don't need React because the data is
 * pull-based — `/mcp` runs synchronously inside QueryEngine.handleCommand.)
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
