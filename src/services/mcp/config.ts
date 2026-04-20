/**
 * MCP configuration loading.
 *
 * Reference: claude-code-source-code/src/services/mcp/config.ts (1500+ lines).
 *
 * The source supports user/project/local/enterprise/managed/dynamic/claudeai
 * scopes plus per-server policy filtering. Easy Agent only needs two scopes:
 *   1. user:    ~/.easy-agent/settings.json
 *   2. project: <cwd>/.easy-agent/settings.json
 * with project overriding user (same as existing permission settings).
 *
 * The `mcpServers` field lives inside the existing settings.json so users
 * don't have to learn a second config file.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
  McpHTTPServerConfig,
  McpSSEServerConfig,
  McpServerConfig,
  McpStdioServerConfig,
  ScopedMcpServerConfig,
} from "../../types/mcp.js";
import { logWarn } from "../../utils/log.js";

interface RawSettings {
  mcpServers?: unknown;
}

export interface McpConfigLoadResult {
  servers: Record<string, ScopedMcpServerConfig>;
  errors: string[];
}

/**
 * Validate a single server config object. Returns the validated config or
 * `null` plus an error string. Mirrors the source's per-server validation
 * loop (config.ts:1327-1373); we accept three transport types: stdio (default
 * if `type` omitted), `http`, and `sse`.
 */
function validateServerConfig(
  name: string,
  raw: unknown,
  scope: string,
): { ok: true; value: McpServerConfig } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: `mcpServers.${name} must be an object` };
  }
  const obj = raw as Record<string, unknown>;
  const type = obj.type;
  if (type !== undefined && type !== "stdio" && type !== "http" && type !== "sse") {
    return {
      ok: false,
      error: `mcpServers.${name} (${scope}): unsupported transport '${String(type)}'. Use 'stdio', 'http', or 'sse'.`,
    };
  }

  if (type === "http" || type === "sse") {
    return validateRemoteConfig(name, obj, scope, type);
  }
  return validateStdioConfig(name, obj, scope);
}

function validateStdioConfig(
  name: string,
  obj: Record<string, unknown>,
  scope: string,
): { ok: true; value: McpStdioServerConfig } | { ok: false; error: string } {
  if (typeof obj.command !== "string" || obj.command.trim().length === 0) {
    return { ok: false, error: `mcpServers.${name} (${scope}): 'command' is required and must be a non-empty string` };
  }
  if (obj.args !== undefined && !Array.isArray(obj.args)) {
    return { ok: false, error: `mcpServers.${name} (${scope}): 'args' must be an array of strings` };
  }
  if (Array.isArray(obj.args) && obj.args.some((a) => typeof a !== "string")) {
    return { ok: false, error: `mcpServers.${name} (${scope}): 'args' must contain only strings` };
  }
  if (obj.env !== undefined) {
    if (typeof obj.env !== "object" || obj.env === null || Array.isArray(obj.env)) {
      return { ok: false, error: `mcpServers.${name} (${scope}): 'env' must be a string→string map` };
    }
    for (const [k, v] of Object.entries(obj.env)) {
      if (typeof v !== "string") {
        return { ok: false, error: `mcpServers.${name} (${scope}): env.${k} must be a string` };
      }
    }
  }
  const validated: McpStdioServerConfig = {
    type: "stdio",
    command: obj.command,
    args: (obj.args as string[] | undefined) ?? [],
    ...(obj.env ? { env: obj.env as Record<string, string> } : {}),
  };
  return { ok: true, value: validated };
}

function validateRemoteConfig(
  name: string,
  obj: Record<string, unknown>,
  scope: string,
  type: "http" | "sse",
): { ok: true; value: McpHTTPServerConfig | McpSSEServerConfig } | { ok: false; error: string } {
  if (typeof obj.url !== "string" || obj.url.trim().length === 0) {
    return { ok: false, error: `mcpServers.${name} (${scope}): '${type}' transport requires 'url'` };
  }
  // We accept any URL the SDK can parse. Source only mandates `https://` for
  // OAuth metadata URLs, not for the server URL itself, so localhost http://
  // works for local testing.
  try {
    new URL(obj.url);
  } catch {
    return { ok: false, error: `mcpServers.${name} (${scope}): 'url' is not a valid URL: ${obj.url}` };
  }
  if (obj.headers !== undefined) {
    if (typeof obj.headers !== "object" || obj.headers === null || Array.isArray(obj.headers)) {
      return { ok: false, error: `mcpServers.${name} (${scope}): 'headers' must be a string→string map` };
    }
    for (const [k, v] of Object.entries(obj.headers)) {
      if (typeof v !== "string") {
        return { ok: false, error: `mcpServers.${name} (${scope}): headers.${k} must be a string` };
      }
    }
  }
  const headers = obj.headers as Record<string, string> | undefined;
  return {
    ok: true,
    value: {
      type,
      url: obj.url,
      ...(headers ? { headers } : {}),
    } as McpHTTPServerConfig | McpSSEServerConfig,
  };
}

async function readSettingsFile(filePath: string): Promise<{
  raw: RawSettings | null;
  parseError?: string;
}> {
  try {
    const text = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(text) as RawSettings;
    return { raw: parsed };
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") return { raw: null };
    if (error instanceof SyntaxError) {
      return { raw: null, parseError: `Invalid JSON in ${filePath}: ${error.message}` };
    }
    return { raw: null, parseError: `Failed to read ${filePath}: ${(error as Error).message}` };
  }
}

function extractScopedServers(
  raw: RawSettings | null,
  scope: "user" | "project",
  filePath: string,
  errors: string[],
): Record<string, ScopedMcpServerConfig> {
  if (!raw || raw.mcpServers === undefined) return {};
  if (typeof raw.mcpServers !== "object" || raw.mcpServers === null || Array.isArray(raw.mcpServers)) {
    errors.push(`${filePath}: 'mcpServers' must be an object`);
    return {};
  }
  const out: Record<string, ScopedMcpServerConfig> = {};
  for (const [name, rawConfig] of Object.entries(raw.mcpServers as Record<string, unknown>)) {
    const result = validateServerConfig(name, rawConfig, scope);
    if (!result.ok) {
      errors.push(result.error);
      continue;
    }
    out[name] = { ...result.value, scope };
  }
  return out;
}

/**
 * Load MCP server configurations from user + project settings.
 *
 * Project overrides user on name conflicts. Servers that fail schema
 * validation are dropped with a warning — never throws (mirrors the source's
 * "best-effort" loading approach so a single malformed entry can't take the
 * whole CLI down).
 */
export async function loadMcpConfigs(cwd: string): Promise<McpConfigLoadResult> {
  const userPath = path.join(os.homedir(), ".easy-agent", "settings.json");
  const projectPath = path.join(cwd, ".easy-agent", "settings.json");

  const errors: string[] = [];
  const [userFile, projectFile] = await Promise.all([
    readSettingsFile(userPath),
    readSettingsFile(projectPath),
  ]);
  if (userFile.parseError) errors.push(userFile.parseError);
  if (projectFile.parseError) errors.push(projectFile.parseError);

  const userServers = extractScopedServers(userFile.raw, "user", userPath, errors);
  const projectServers = extractScopedServers(projectFile.raw, "project", projectPath, errors);

  // Project overrides user — Object.assign right-wins
  const servers: Record<string, ScopedMcpServerConfig> = { ...userServers, ...projectServers };

  for (const error of errors) {
    logWarn(`[mcp] config: ${error}`);
  }
  return { servers, errors };
}
