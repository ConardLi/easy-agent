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

import type {
  McpHTTPServerConfig,
  McpSSEServerConfig,
  McpServerConfig,
  McpStdioServerConfig,
  ScopedMcpServerConfig,
} from "../../types/mcp.js";
import * as path from "node:path";
import { logWarn } from "../../utils/log.js";
import { loadSettingSources, type SettingSource } from "../../config/sources.js";
import { isProjectTrusted } from "../../config/globalState.js";
import { readJsonSettingsFile } from "../../utils/settings.js";

interface RawSettings {
  mcpServers?: unknown;
}

export interface McpConfigLoadResult {
  servers: Record<string, ScopedMcpServerConfig>;
  errors: string[];
  /** `.mcp.json` servers awaiting approval (not yet enabled). */
  pending?: string[];
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

function extractScopedServers(
  raw: RawSettings | null,
  scope: SettingSource,
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

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
}

/**
 * Read + gate the project-level `<cwd>/.mcp.json` servers.
 *
 * `.mcp.json` is the standard Claude Code project MCP file (`{ "mcpServers":
 * {...} }`). Because each stdio server runs a local command, loading one is an
 * execution surface — so it is gated twice:
 *
 *   1. Folder trust: an untrusted folder's `.mcp.json` is ignored entirely.
 *   2. Per-server approval (mirrors source's `enabledMcpjsonServers` flow):
 *        - in `disabledMcpjsonServers`            → rejected
 *        - `enableAllProjectMcpServers: true`     → approved
 *        - listed in `enabledMcpjsonServers`      → approved
 *        - otherwise                              → PENDING (not loaded; the
 *          user approves by adding it to `enabledMcpjsonServers` or setting
 *          `enableAllProjectMcpServers`). We don't have an interactive prompt,
 *          so pending servers are surfaced as a notice instead of auto-loaded.
 */
async function loadProjectMcpJson(
  cwd: string,
  approval: { enableAll: boolean; enabled: string[]; disabled: string[] },
  errors: string[],
): Promise<{ approved: Record<string, ScopedMcpServerConfig>; pending: string[] }> {
  const approved: Record<string, ScopedMcpServerConfig> = {};
  const pending: string[] = [];

  if (!(await isProjectTrusted(cwd))) return { approved, pending };

  const filePath = path.join(cwd, ".mcp.json");
  const { raw, parseError } = await readJsonSettingsFile<RawSettings>(filePath);
  if (parseError) {
    errors.push(parseError);
    return { approved, pending };
  }
  if (!raw) return { approved, pending };

  const enabledSet = new Set(approval.enabled);
  const disabledSet = new Set(approval.disabled);
  const scoped = extractScopedServers(raw, "project", filePath, errors);
  for (const [name, config] of Object.entries(scoped)) {
    if (disabledSet.has(name)) continue;
    if (approval.enableAll || enabledSet.has(name)) {
      approved[name] = config;
    } else {
      pending.push(name);
    }
  }
  return { approved, pending };
}

/**
 * Load MCP server configurations from every settings source, plus the gated
 * project `.mcp.json`.
 *
 * Later sources override earlier ones on name conflicts (user → project →
 * local → flag → policy; `.mcp.json` is applied before settings so an explicit
 * settings entry wins). Servers that fail schema validation are dropped with a
 * warning — never throws (mirrors the source's "best-effort" loading approach
 * so a single malformed entry can't take the whole CLI down).
 */
export async function loadMcpConfigs(cwd: string): Promise<McpConfigLoadResult> {
  const sources = await loadSettingSources(cwd);

  const errors: string[] = [];
  const servers: Record<string, ScopedMcpServerConfig> = {};

  // Approval config for .mcp.json, merged across sources.
  let enableAll = false;
  const enabled: string[] = [];
  const disabled: string[] = [];
  for (const src of sources) {
    if (!src.raw) continue;
    if (src.raw["enableAllProjectMcpServers"] === true) enableAll = true;
    enabled.push(...asStringArray(src.raw["enabledMcpjsonServers"]));
    disabled.push(...asStringArray(src.raw["disabledMcpjsonServers"]));
  }

  // .mcp.json first, so a same-named entry in settings.json overrides it.
  const projectMcp = await loadProjectMcpJson(
    cwd,
    { enableAll, enabled, disabled },
    errors,
  );
  Object.assign(servers, projectMcp.approved);

  for (const src of sources) {
    if (src.parseError) errors.push(src.parseError);
    if (!src.raw) continue;
    const scoped = extractScopedServers(
      src.raw as RawSettings,
      src.source,
      src.path ?? `<${src.source}>`,
      errors,
    );
    // Later source wins on name conflicts.
    Object.assign(servers, scoped);
  }

  for (const error of errors) {
    logWarn(`[mcp] config: ${error}`);
  }
  if (projectMcp.pending.length > 0) {
    logWarn(
      `[mcp] .mcp.json: ${projectMcp.pending.length} server(s) awaiting approval: ${projectMcp.pending.join(", ")}. ` +
        `Add them to "enabledMcpjsonServers" or set "enableAllProjectMcpServers": true to enable.`,
    );
  }
  return { servers, errors, pending: projectMcp.pending };
}
