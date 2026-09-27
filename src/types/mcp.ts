/** MCP server configuration and connection state. */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";

// ─── Configuration ───────────────────────────────────────────────────

/**
 * stdio MCP server configuration. The `type` field is optional for backwards
 * compatibility with the de-facto standard `mcpServers` shape used by the
 * MCP ecosystem (Claude Desktop, Cursor, etc.) — when missing, we treat the
 * config as stdio.
 */
export interface McpStdioServerConfig {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Streamable HTTP MCP server. */
export interface McpHTTPServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  headersEnv?: Record<string, string>;
  headersHelper?: { command: string; args?: string[] };
  oauth?: McpOAuthConfig;
}

/**
 * Legacy SSE MCP server. Many older MCP servers (and most of the public
 * `@modelcontextprotocol/server-*` packages from before Streamable HTTP
 * landed) speak this. The transport opens one long-lived GET that streams
 * server→client messages and POSTs each client→server JSON-RPC envelope.
 */
export interface McpSSEServerConfig {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  headersEnv?: Record<string, string>;
  headersHelper?: { command: string; args?: string[] };
  oauth?: McpOAuthConfig;
}

export type McpOAuthConfig =
  | { type: "authorization_code"; clientId?: string; clientSecretEnv?: string; scope?: string; redirectPort?: number }
  | { type: "client_credentials"; clientId: string; clientSecretEnv: string; scope?: string };

export type McpServerConfig =
  | McpStdioServerConfig
  | McpHTTPServerConfig
  | McpSSEServerConfig;

/** Top-level config shape inside settings.json. */
export interface McpJsonConfig {
  mcpServers: Record<string, McpServerConfig>;
}

/** A server config tagged with the scope it came from (later sources override earlier). */
export type ScopedMcpServerConfig = McpServerConfig & {
  scope: import("../config/sources.js").SettingSource;
};

// ─── Connection State ────────────────────────────────────────────────

export interface ConnectedMcpServer {
  name: string;
  type: "connected";
  client: Client;
  capabilities: ServerCapabilities | undefined;
  serverInfo?: { name: string; version: string };
  config: ScopedMcpServerConfig;
  cleanup: () => Promise<void>;
  sessionId?: () => string | undefined;
  authorizationUrl?: () => string | undefined;
}

export interface FailedMcpServer {
  name: string;
  type: "failed";
  config: ScopedMcpServerConfig;
  error: string;
}

export interface DisabledMcpServer {
  name: string;
  type: "disabled";
  config: ScopedMcpServerConfig;
}

/**
 * Placeholder used while a server is still being spawned / handshaking.
 * The registry seeds one of these per configured server BEFORE any IO
 * happens, so `/mcp` always reflects intended state — even during a slow
 * `npx -y …` cold start. Replaced atomically when the connection resolves.
 */
export interface PendingMcpServer {
  name: string;
  type: "pending";
  config: ScopedMcpServerConfig;
  startedAt: number;
}

export type McpServerConnection =
  | ConnectedMcpServer
  | FailedMcpServer
  | DisabledMcpServer
  | PendingMcpServer;
