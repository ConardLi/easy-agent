/** MCP tool discovery and local tool adapters. */

import type {
  ListToolsResult,
  Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ListToolsResultSchema,
  ResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ConnectedMcpServer } from "../../types/mcp.js";
import type { Tool, ToolContext, ToolResult } from "../../tools/Tool.js";
import { debugLog, logWarn } from "../../utils/log.js";
import { buildMcpToolName } from "./mcpStringUtils.js";
import { adaptMcpToolResult } from "./resultContent.js";
import { getMcpRegistryEntry } from "./registry.js";
import { requestMcpReconnect } from "./client.js";
import { setMcpProgress, clearMcpProgress } from "../../state/mcpProgressStore.js";

/** Bound tool descriptions before they enter the model request. */
const MAX_MCP_DESCRIPTION_LENGTH = 2048;

function truncateDescription(desc: string | undefined): string {
  if (!desc) return "";
  if (desc.length <= MAX_MCP_DESCRIPTION_LENGTH) return desc;
  return desc.slice(0, MAX_MCP_DESCRIPTION_LENGTH) + "… [truncated]";
}

/** Adapt one server tool to the local execution interface. */
function buildToolAdapter(connection: ConnectedMcpServer, mcpTool: McpTool): Tool {
  const fullName = buildMcpToolName(connection.name, mcpTool.name);
  const description = truncateDescription(mcpTool.description);
  const isReadOnly = mcpTool.annotations?.readOnlyHint ?? false;

  const inputSchema = (mcpTool.inputSchema ?? {
    type: "object",
    properties: {},
  }) as Tool["inputSchema"];

  const meta = (mcpTool as { _meta?: Record<string, unknown> })._meta;
  const searchHint =
    typeof meta?.["anthropic/searchHint"] === "string" ? (meta["anthropic/searchHint"] as string) : undefined;
  const alwaysLoad = meta?.["anthropic/alwaysLoad"] === true;

  return {
    name: fullName,
    description,
    inputSchema,
    isMcp: true,
    ...(searchHint ? { searchHint } : {}),
    ...(alwaysLoad ? { alwaysLoad: true } : {}),
    isReadOnly: () => isReadOnly,
    isEnabled: () => true,
    async call(rawInput: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const current = getMcpRegistryEntry(connection.name)?.connection;
      const active = current?.type === "connected" ? current : connection;
      const invoke = async (server: ConnectedMcpServer): Promise<ToolResult> => {
        const result = await server.client.request(
          {
            method: "tools/call",
            params: { name: mcpTool.name, arguments: rawInput },
          },
          ResultSchema,
          {
            signal: context.abortSignal,
            onprogress: (progress) => {
              if (context.toolUseId) setMcpProgress(context.toolUseId, {
                progress: progress.progress,
                ...(progress.total !== undefined ? { total: progress.total } : {}),
                ...(progress.message ? { message: progress.message } : {}),
              });
            },
          },
        );
        return adaptMcpToolResult(result as Record<string, unknown>);
      };
      try {
        return await invoke(active);
      } catch (error) {
        if ((error as { code?: number }).code === 404 && active.sessionId?.() && connection.config.type === "http") {
          const rebuilt = await requestMcpReconnect(connection.name).catch(() => null);
          if (rebuilt?.type === "connected") {
            try { return await invoke(rebuilt); } catch (retryError) { error = retryError; }
          }
        }
        const message = error instanceof Error ? error.message : String(error);
        const authorizationUrl = active.authorizationUrl?.();
        return {
          content: `MCP tool '${fullName}' failed: ${authorizationUrl ? `Authorization required: ${authorizationUrl}` : message}`,
          isError: true,
        };
      } finally {
        if (context.toolUseId) clearMcpProgress(context.toolUseId);
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
