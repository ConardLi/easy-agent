/**
 * MCP tool discovery + adapter to the local Tool interface.
 *
 * Reference: claude-code-source-code/src/services/mcp/client.ts:1745-2000
 * (`fetchToolsForClient`).
 *
 * What this does, in three steps:
 *   1. Ask the server `tools/list` (skipped if it didn't declare the
 *      `tools` capability)
 *   2. For each MCP tool, build a local `Tool` whose `call()` forwards to
 *      `client.request({ method: 'tools/call' })`
 *   3. Stamp the local Tool with a `mcp__<server>__<tool>` name so the
 *      Anthropic API + permission system can route it back here unambiguously
 *
 * The source's adapter is ~250 lines because it juggles progress events,
 * URL elicitation retries, image persistence, structured content, and
 * session-expired retries. We keep just the data path.
 */

import type {
  CallToolResult,
  ListToolsResult,
  Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ConnectedMcpServer } from "../../types/mcp.js";
import type { Tool, ToolContext, ToolResult } from "../../tools/Tool.js";
import { debugLog, logWarn } from "../../utils/log.js";
import { buildMcpToolName } from "./mcpStringUtils.js";

/**
 * MCP tool descriptions can blow up to 60 KB on OpenAPI-derived servers.
 * Cap at 2048 chars to keep the system prompt sane (same value as source).
 */
const MAX_MCP_DESCRIPTION_LENGTH = 2048;

/** Map MCP `CallToolResult.content[]` blocks to a single string for our Tool result. */
function stringifyMcpContent(content: CallToolResult["content"]): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "image":
        // Source code resizes + persists the image to disk and returns a
        // path. For Stage 16 we just acknowledge it — image-aware tools
        // can be added later when we wire MCP into the model's vision input.
        parts.push(`[image: ${block.mimeType ?? "?"}, ${(block.data ?? "").length} base64 chars]`);
        break;
      case "resource": {
        const r = block.resource as { uri?: string; text?: string };
        parts.push(r?.text ?? `[resource: ${r?.uri ?? "<no uri>"}]`);
        break;
      }
      default:
        parts.push(`[${(block as { type?: string }).type ?? "unknown"} block]`);
    }
  }
  return parts.join("\n");
}

function truncateDescription(desc: string | undefined): string {
  if (!desc) return "";
  if (desc.length <= MAX_MCP_DESCRIPTION_LENGTH) return desc;
  return desc.slice(0, MAX_MCP_DESCRIPTION_LENGTH) + "… [truncated]";
}

/**
 * Build a local `Tool` from a single MCP tool descriptor.
 *
 * Key field mappings (mirroring the source code):
 *   tool.annotations.readOnlyHint  → isReadOnly()       (gates Plan-mode visibility)
 *   tool.annotations.destructiveHint → (used by source for risk labels — not yet here)
 *   tool.inputSchema               → inputSchema        (passed through to API)
 *   tool.description (≤2048 chars) → description
 */
function buildToolAdapter(connection: ConnectedMcpServer, mcpTool: McpTool): Tool {
  const fullName = buildMcpToolName(connection.name, mcpTool.name);
  const description = truncateDescription(mcpTool.description);
  const isReadOnly = mcpTool.annotations?.readOnlyHint ?? false;

  // The MCP SDK ships JSON Schema, which is the same shape Anthropic's API
  // expects. We `as` it to satisfy the local typedef but it's effectively
  // identical at runtime.
  const inputSchema = (mcpTool.inputSchema ?? {
    type: "object",
    properties: {},
  }) as Tool["inputSchema"];

  return {
    name: fullName,
    description,
    inputSchema,
    isReadOnly: () => isReadOnly,
    isEnabled: () => true,
    async call(rawInput: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
      try {
        const result = await connection.client.request(
          {
            method: "tools/call",
            params: {
              name: mcpTool.name, // server expects its OWN name, not the prefixed alias
              arguments: rawInput,
            },
          },
          CallToolResultSchema,
        );
        const content = stringifyMcpContent(result.content as CallToolResult["content"]);
        return {
          content,
          isError: result.isError === true,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: `MCP tool '${fullName}' failed: ${message}`,
          isError: true,
        };
      }
    },
  };
}

/**
 * Pull the tool list from a connected MCP server and adapt each entry into
 * our local Tool interface. Returns `[]` if the server doesn't declare the
 * `tools` capability or if the request fails (logged).
 */
export async function fetchToolsForConnection(
  connection: ConnectedMcpServer,
): Promise<Tool[]> {
  if (!connection.capabilities?.tools) {
    debugLog("mcp", `[${connection.name}] no 'tools' capability declared, skipping tools/list`);
    return [];
  }

  let result: ListToolsResult;
  try {
    result = (await connection.client.request(
      { method: "tools/list" },
      ListToolsResultSchema,
    )) as ListToolsResult;
  } catch (error) {
    logWarn(`MCP server '${connection.name}' tools/list failed: ${(error as Error).message}`);
    return [];
  }

  const tools: Tool[] = [];
  for (const mcpTool of result.tools) {
    try {
      tools.push(buildToolAdapter(connection, mcpTool));
    } catch (error) {
      logWarn(
        `MCP tool '${connection.name}.${mcpTool.name}' failed schema adaptation: ${(error as Error).message}`,
      );
    }
  }
  debugLog("mcp", `[${connection.name}] discovered ${tools.length} tool(s)`);
  return tools;
}
