import {
  ListResourcesResultSchema,
  type ListResourcesResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { getMcpRegistry } from "../services/mcp/registry.js";
import type { ConnectedMcpServer } from "../types/mcp.js";
import { logWarn } from "../utils/log.js";

/**
 * ListMcpResources — list resources exposed by connected MCP servers.
 *
 * Reference: claude-code-source-code/src/tools/ListMcpResourcesTool/.
 * MCP servers can expose `resources` (database schemas, docs, file URIs) in
 * addition to `tools`. Stage 16 only consumed tools; this completes the data
 * path by reading the `resources/list` capability.
 */
interface ListMcpResourcesInput {
  server?: string;
}

interface ResourceEntry {
  uri: string;
  name: string;
  mimeType?: string;
  description?: string;
  server: string;
}

function connectedServers(): ConnectedMcpServer[] {
  return getMcpRegistry()
    .map((e) => e.connection)
    .filter((c): c is ConnectedMcpServer => c.type === "connected");
}

export const listMcpResourcesTool: Tool = {
  name: "ListMcpResources",
  description:
    "List resources available from connected MCP servers. Optionally filter to a single server. Returns resource URIs you can read with ReadMcpResource.",
  inputSchema: {
    type: "object" as const,
    properties: {
      server: { type: "string", description: "Optional MCP server name to filter by" },
    },
    required: [],
  },
  maxResultSizeChars: 100_000,
  async call(rawInput: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const input = rawInput as unknown as ListMcpResourcesInput;
    const all = connectedServers();
    const targets = input.server ? all.filter((c) => c.name === input.server) : all;

    if (input.server && targets.length === 0) {
      const available = all.map((c) => c.name).join(", ") || "(none)";
      return {
        content: `Error: MCP server "${input.server}" not connected. Available: ${available}`,
        isError: true,
      };
    }

    const entries: ResourceEntry[] = [];
    for (const server of targets) {
      if (!server.capabilities?.resources) continue;
      try {
        const result = (await server.client.request(
          { method: "resources/list" },
          ListResourcesResultSchema,
        )) as ListResourcesResult;
        for (const r of result.resources) {
          entries.push({
            uri: r.uri,
            name: r.name ?? r.uri,
            mimeType: r.mimeType,
            description: r.description,
            server: server.name,
          });
        }
      } catch (error) {
        // One server failing shouldn't sink the whole list.
        logWarn(`MCP server '${server.name}' resources/list failed: ${(error as Error).message}`);
      }
    }

    if (entries.length === 0) {
      return {
        content:
          "No MCP resources found. Servers may still provide tools even with no resources.",
      };
    }

    return { content: JSON.stringify(entries, null, 2) };
  },
  isReadOnly(): boolean {
    return true;
  },
  isEnabled(): boolean {
    return true;
  },
  isConcurrencySafe(): boolean {
    return true;
  },
};
