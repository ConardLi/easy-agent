import {
  ReadResourceResultSchema,
  type ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { getMcpRegistry } from "../services/mcp/registry.js";
import type { ConnectedMcpServer } from "../types/mcp.js";

/**
 * ReadMcpResource — read a single resource (by URI) from a connected MCP server.
 *
 * Reference: claude-code-source-code/src/tools/ReadMcpResourceTool/.
 * Text resources are returned inline. Binary (blob) resources are noted but
 * not decoded for vision — multimodal persistence lands in a later stage, so
 * for now we stringify a placeholder (consistent with §16's MCP image handling).
 */
interface ReadMcpResourceInput {
  server: string;
  uri: string;
}

interface ReadContent {
  uri: string;
  mimeType?: string;
  text?: string;
  note?: string;
}

function findConnected(name: string): ConnectedMcpServer | undefined {
  return getMcpRegistry()
    .map((e) => e.connection)
    .find((c): c is ConnectedMcpServer => c.type === "connected" && c.name === name);
}

export const readMcpResourceTool: Tool = {
  name: "ReadMcpResource",
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

    let result: ReadResourceResult;
    try {
      result = (await server.client.request(
        { method: "resources/read", params: { uri: input.uri } },
        ReadResourceResultSchema,
      )) as ReadResourceResult;
    } catch (error) {
      return {
        content: `Error reading resource "${input.uri}" from "${input.server}": ${
          error instanceof Error ? error.message : String(error)
        }`,
        isError: true,
      };
    }

    const contents: ReadContent[] = result.contents.map((c) => {
      if (typeof (c as { text?: unknown }).text === "string") {
        return { uri: c.uri, mimeType: c.mimeType, text: (c as { text: string }).text };
      }
      if (typeof (c as { blob?: unknown }).blob === "string") {
        const blob = (c as { blob: string }).blob;
        return {
          uri: c.uri,
          mimeType: c.mimeType,
          note: `[binary resource: ${c.mimeType ?? "?"}, ${blob.length} base64 chars — not rendered as text]`,
        };
      }
      return { uri: c.uri, mimeType: c.mimeType, note: "[empty resource]" };
    });

    return { content: JSON.stringify({ contents }, null, 2) };
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
