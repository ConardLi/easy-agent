import { runControlledProcess } from "../../utils/controlledProcess.js";
import type { McpHTTPServerConfig, McpSSEServerConfig } from "../../types/mcp.js";
import { USER_AGENT } from "../../version.js";

type RemoteConfig = McpHTTPServerConfig | McpSSEServerConfig;

function mergeHeaders(target: Headers, values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) {
    try { target.set(name, value); } catch { throw new Error(`Invalid MCP header ${name}`); }
  }
}

export async function resolveMcpHeaders(config: RemoteConfig): Promise<Headers> {
  const headers = new Headers({ "User-Agent": USER_AGENT });
  mergeHeaders(headers, config.headers ?? {});
  for (const [name, envName] of Object.entries(config.headersEnv ?? {})) {
    const value = process.env[envName];
    if (!value) throw new Error(`MCP header ${name} requires environment variable ${envName}`);
    mergeHeaders(headers, { [name]: value });
  }
  if (config.headersHelper) {
    const result = await runControlledProcess({
      executable: config.headersHelper.command,
      args: config.headersHelper.args ?? [],
      timeoutMs: 5_000,
      maxOutputBytes: 16 * 1024,
    });
    if (result.reason !== "completed" || result.exitCode !== 0 || result.stdoutTruncated) {
      throw new Error("MCP headers helper failed or exceeded its output limit");
    }
    let values: unknown;
    try { values = JSON.parse(result.stdout); } catch { throw new Error("MCP headers helper must return a JSON object"); }
    if (!values || typeof values !== "object" || Array.isArray(values) || Object.values(values).some((value) => typeof value !== "string")) {
      throw new Error("MCP headers helper must return a string-to-string JSON object");
    }
    mergeHeaders(headers, values as Record<string, string>);
  }
  return headers;
}

export function createMcpFetch(config: RemoteConfig): typeof fetch {
  const origin = new URL(config.url).origin;
  return async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.origin !== origin) return fetch(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const resolved = await resolveMcpHeaders(config);
    resolved.forEach((value, name) => headers.set(name, value));
    return fetch(input, { ...init, headers });
  };
}
