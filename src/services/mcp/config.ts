/** Load and validate MCP server configuration from trusted settings sources. */

import type {
  McpHTTPServerConfig,
  McpSSEServerConfig,
  McpServerConfig,
  McpStdioServerConfig,
  ScopedMcpServerConfig,
} from "../../types/mcp.js";
import * as path from "node:path";
import { logWarn } from "../../utils/log.js";
import {
  loadSettingSources,
  loadTrustedSettingSources,
  type SettingSource,
} from "../../config/sources.js";
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

/** Validate one configured server without rejecting unrelated servers. */
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
  // Local loopback HTTP endpoints are supported alongside remote HTTPS servers.
  try {
    const parsed = new URL(obj.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Unsupported protocol");
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
      try { new Headers({ [k]: v }); } catch { return { ok: false, error: `mcpServers.${name} (${scope}): headers.${k} is invalid` }; }
    }
  }
  const headers = obj.headers as Record<string, string> | undefined;
  let headersEnv: Record<string, string> | undefined;
  if (obj.headersEnv !== undefined) {
    if (!obj.headersEnv || typeof obj.headersEnv !== "object" || Array.isArray(obj.headersEnv)) {
      return { ok: false, error: `mcpServers.${name} (${scope}): 'headersEnv' must be a string→environment-variable map` };
    }
    headersEnv = {};
    for (const [header, envName] of Object.entries(obj.headersEnv)) {
      if (typeof envName !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
        return { ok: false, error: `mcpServers.${name} (${scope}): headersEnv.${header} must name an environment variable` };
      }
      try { new Headers({ [header]: "value" }); } catch { return { ok: false, error: `mcpServers.${name} (${scope}): headersEnv.${header} is invalid` }; }
      headersEnv[header] = envName;
    }
  }
  let headersHelper: { command: string; args?: string[] } | undefined;
  if (obj.headersHelper !== undefined) {
    const helper = obj.headersHelper as Record<string, unknown> | null;
    if (!helper || typeof helper !== "object" || Array.isArray(helper) || typeof helper.command !== "string" || !helper.command.trim() || (helper.args !== undefined && (!Array.isArray(helper.args) || helper.args.some((arg) => typeof arg !== "string")))) {
      return { ok: false, error: `mcpServers.${name} (${scope}): 'headersHelper' requires command and optional string args` };
    }
    headersHelper = { command: helper.command, ...(helper.args ? { args: helper.args as string[] } : {}) };
  }
  let oauth: McpHTTPServerConfig["oauth"];
  if (obj.oauth !== undefined) {
    const raw = obj.oauth === true ? { type: "authorization_code" } : obj.oauth;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, error: `mcpServers.${name} (${scope}): 'oauth' must be true or an OAuth configuration object` };
    }
    const auth = raw as Record<string, unknown>;
    const authType = auth.type ?? "authorization_code";
    if (authType !== "authorization_code" && authType !== "client_credentials") {
      return { ok: false, error: `mcpServers.${name} (${scope}): unsupported OAuth type` };
    }
    if (auth.clientId !== undefined && (typeof auth.clientId !== "string" || !auth.clientId.trim())) {
      return { ok: false, error: `mcpServers.${name} (${scope}): oauth.clientId must be non-empty` };
    }
    if (auth.clientSecretEnv !== undefined && (typeof auth.clientSecretEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(auth.clientSecretEnv))) {
      return { ok: false, error: `mcpServers.${name} (${scope}): oauth.clientSecretEnv must name an environment variable` };
    }
    if (auth.scope !== undefined && typeof auth.scope !== "string") {
      return { ok: false, error: `mcpServers.${name} (${scope}): oauth.scope must be a string` };
    }
    if (authType === "client_credentials") {
      if (typeof auth.clientId !== "string" || typeof auth.clientSecretEnv !== "string") {
        return { ok: false, error: `mcpServers.${name} (${scope}): client_credentials requires clientId and clientSecretEnv` };
      }
      oauth = { type: "client_credentials", clientId: auth.clientId, clientSecretEnv: auth.clientSecretEnv, ...(typeof auth.scope === "string" ? { scope: auth.scope } : {}) };
    } else {
      if (auth.redirectPort !== undefined && (!Number.isSafeInteger(auth.redirectPort) || (auth.redirectPort as number) < 1 || (auth.redirectPort as number) > 65535)) {
        return { ok: false, error: `mcpServers.${name} (${scope}): oauth.redirectPort must be a TCP port` };
      }
      if (auth.clientId && auth.redirectPort === undefined) {
        return { ok: false, error: `mcpServers.${name} (${scope}): pre-registered OAuth clients require redirectPort` };
      }
      if (auth.clientSecretEnv && !auth.clientId) {
        return { ok: false, error: `mcpServers.${name} (${scope}): oauth.clientSecretEnv requires clientId` };
      }
      oauth = { type: "authorization_code", ...(typeof auth.clientId === "string" ? { clientId: auth.clientId } : {}), ...(typeof auth.clientSecretEnv === "string" ? { clientSecretEnv: auth.clientSecretEnv } : {}), ...(typeof auth.scope === "string" ? { scope: auth.scope } : {}), ...(typeof auth.redirectPort === "number" ? { redirectPort: auth.redirectPort } : {}) };
    }
    const authorizationHeaders = [
      ...Object.keys(headers ?? {}),
      ...Object.keys(headersEnv ?? {}),
    ].some((header) => header.toLowerCase() === "authorization");
    if (authorizationHeaders || headersHelper) {
      return { ok: false, error: `mcpServers.${name} (${scope}): OAuth cannot be combined with custom authorization headers or headersHelper` };
    }
  }
  return {
    ok: true,
    value: {
      type,
      url: obj.url,
      ...(headers ? { headers } : {}),
      ...(headersEnv ? { headersEnv } : {}),
      ...(headersHelper ? { headersHelper } : {}),
      ...(oauth ? { oauth } : {}),
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
 * Stdio definitions in this file can execute local commands, so loading it is
 * gated by project trust and per-server approval:
 *
 *   1. Folder trust: an untrusted folder's `.mcp.json` is ignored entirely.
 *   2. Per-server approval:
 *        - in `disabledMcpjsonServers`            → rejected
 *        - `enableAllProjectMcpServers: true`     → approved
 *        - listed in `enabledMcpjsonServers`      → approved
 *        - otherwise                              → PENDING (not loaded; the
 *          user approves by adding it to `enabledMcpjsonServers` or setting
 *          `enableAllProjectMcpServers`). Pending servers are surfaced as a notice.
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
 * warning, so one malformed entry cannot prevent other servers from loading.
 */
export async function loadMcpConfigs(cwd: string): Promise<McpConfigLoadResult> {
  const [allSources, sources] = await Promise.all([
    loadSettingSources(cwd),
    loadTrustedSettingSources(cwd),
  ]);

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
  for (const src of allSources) {
    if (!src.raw) continue;
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
