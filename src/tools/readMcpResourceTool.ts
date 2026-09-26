import {
  ResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { getMcpRegistry } from "../services/mcp/registry.js";
import type { ConnectedMcpServer } from "../types/mcp.js";
import { adaptMcpResourceResult } from "../services/mcp/resultContent.js";
import { withMcpReadRecovery } from "../services/mcp/readRecovery.js";

/** Read a resource from a connected MCP server. */
interface ReadMcpResourceInput {
  server: string;
  uri: string;
}

function findConnected(name: string): ConnectedMcpServer | undefined {
  return getMcpRegistry()
    .map((e) => e.connection)
    .find((c): c is ConnectedMcpServer => c.type === "connected" && c.name === name);
}

export const readMcpResourceTool: Tool = {
  name: "ReadMcpResource",
  searchHint: "read a resource from a connected MCP server",
  shouldDefer: true,
  description:
    "Read the contents of a specific MCP resource by server name and URI (discover URIs with ListMcpResources).",
  inputSchema: {
    type: "object" as const,
    properties: {
      server: { type: "string", description: "The MCP server name" },
      uri: { type: "string", description: "The resource URI to read" },
    },
    required: ["server", "uri"],
  },
  maxResultSizeChars: 100_000,
  async call(rawInput: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const input = rawInput as unknown as ReadMcpResourceInput;
    if (!input.server || !input.uri) {
      return { content: "Error: server and uri are required", isError: true };
    }

    const server = findConnected(input.server);
    if (!server) {
      const available = getMcpRegistry()
        .map((e) => e.connection)
        .filter((c) => c.type === "connected")
        .map((c) => c.name)
        .join(", ") || "(none)";
      return {
        content: `Error: MCP server "${input.server}" not connected. Available: ${available}`,
        isError: true,
      };
    }
    if (!server.capabilities?.resources) {
      return { content: `Error: server "${input.server}" does not support resources`, isError: true };
    }

    let result: Record<string, unknown>;
    try {
      result = await withMcpReadRecovery(server, async (current) => (await current.client.request(
        { method: "resources/read", params: { uri: input.uri } },
        ResultSchema,
      )) as Record<string, unknown>);
    } catch (error) {
      return {
        content: `Error reading resource "${input.uri}" from "${input.server}": ${
          error instanceof Error ? error.message : String(error)
        }`,
        isError: true,
      };
    }

    try {
      return await adaptMcpResourceResult(result);
    } catch (error) {
      return { content: `Error processing resource "${input.uri}": ${error instanceof Error ? error.message : String(error)}`, isError: true };
    }
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
