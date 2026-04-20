/**
 * MCP tool/server name parsing helpers.
 *
 * Reference: claude-code-source-code/src/services/mcp/mcpStringUtils.ts
 *
 * Tool name format: `mcp__<normalizedServerName>__<normalizedToolName>`.
 * Double underscore is the delimiter; if a server name contains `__` the
 * parser will split incorrectly (the source warns about this too).
 */

import { normalizeNameForMCP } from "./normalization.js";

/** Build the fully qualified MCP tool name. */
export function buildMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${normalizeNameForMCP(serverName)}__${normalizeNameForMCP(toolName)}`;
}

/** Cheap predicate: does this look like an MCP-prefixed tool name? */
export function isMcpToolName(name: string): boolean {
  return name.startsWith("mcp__");
}

/**
 * Parse an MCP tool name back into server / tool components.
 * Returns null if the string isn't `mcp__server__tool`-shaped.
 */
export function parseMcpToolName(
  fullName: string,
): { serverName: string; toolName: string } | null {
  const parts = fullName.split("__");
  if (parts.length < 3 || parts[0] !== "mcp" || !parts[1]) return null;
  return {
    serverName: parts[1],
    toolName: parts.slice(2).join("__"),
  };
}
