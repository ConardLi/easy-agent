/**
 * Runtime-level extension management without a session: reloading the
 * extension registries, approving project MCP servers, and reconnecting a
 * server. Decisions are written through the same validated settings writer as
 * `config/write`, so they persist exactly as if the user had edited the file.
 */

import { getAllAgents } from "../agents/registry.js";
import { getAllUserCommands } from "../commands/userCommands/registry.js";
import { isProjectTrusted } from "../config/globalState.js";
import { loadSettingSources } from "../config/sources.js";
import { refreshHookDisableFromSettings } from "../hooks/settings.js";
import { refreshActivePlugins } from "../plugins/runtime.js";
import {
  connectAdditionalMcpServers,
  disconnectMcpServer,
  reconnectMcpServer as reconnectServer,
} from "../services/mcp/bootstrap.js";
import { loadMcpConfigs } from "../services/mcp/config.js";
import { getMcpRegistryEntry } from "../services/mcp/registry.js";
import { getAllUserInvocableSkills } from "../services/skills/registry.js";
import { getAllOutputStyles } from "../styles/registry.js";
import { writeConfig } from "./config.js";
import { AgentSdkError } from "./errors.js";
import type { ConfigScope, McpApprovalResult, McpReconnectResult, McpServerStatus, ReloadResult } from "./types.js";

/**
 * Reload skills, commands, sub-agents, output styles, and plugins from disk,
 * and re-read the hook kill switch. Open sessions see the new registries on
 * their next turn, through the context update the session prompt sends.
 */
export async function reloadExtensions(cwd: string): Promise<ReloadResult> {
  const result = await refreshActivePlugins(cwd);
  await refreshHookDisableFromSettings(cwd);
  return {
    plugins: { enabled: result.summary.enabledPlugins, disabled: result.summary.disabledPlugins },
    skills: getAllUserInvocableSkills().length,
    commands: getAllUserCommands().length,
    agents: getAllAgents().length,
    outputStyles: getAllOutputStyles().length,
    mcpStarted: result.mcpStarted,
    mcpStopped: result.mcpStopped,
    errors: result.errors.map((error) => `${error.pluginId}: ${error.message}`),
  };
}

function currentList(raw: Record<string, unknown> | null | undefined, key: string): string[] {
  const value = raw?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Status of a registered server, or null when it is not running. */
function registryStatus(name: string): { status: McpServerStatus | null; error?: string; toolCount: number } {
  const entry = getMcpRegistryEntry(name);
  if (!entry) return { status: null, toolCount: 0 };
  return {
    status: entry.connection.type,
    ...(entry.connection.type === "failed" ? { error: entry.connection.error } : {}),
    toolCount: entry.tools.length,
  };
}

/**
 * Approve or reject a server from the project's `.mcp.json`. The decision is
 * saved in `enabledMcpjsonServers` or `disabledMcpjsonServers` of `scope`
 * (and removed from the other list there); an approved server is connected
 * right away, a rejected one is stopped.
 */
export async function approveMcpServer(
  cwd: string,
  name: string,
  approved: boolean,
  scope: ConfigScope = "local",
): Promise<McpApprovalResult> {
  if (!(await isProjectTrusted(cwd))) {
    throw new AgentSdkError("untrusted", "Project MCP servers are ignored until the workspace is trusted.");
  }
  const before = await loadMcpConfigs(cwd, { quiet: true });
  if (!before.projectServers?.some((server) => server.name === name)) {
    throw new AgentSdkError("not_found", `No server named "${name}" in .mcp.json.`);
  }

  const raw = (await loadSettingSources(cwd)).find((source) => source.source === scope)?.raw;
  const [addKey, removeKey] = approved
    ? ["enabledMcpjsonServers", "disabledMcpjsonServers"]
    : ["disabledMcpjsonServers", "enabledMcpjsonServers"];
  const added = [...new Set([...currentList(raw, addKey), name])];
  const kept = currentList(raw, removeKey).filter((item) => item !== name);
  await writeConfig(cwd, scope, addKey, added);
  if (currentList(raw, removeKey).length !== kept.length) {
    await writeConfig(cwd, scope, removeKey, kept.length > 0 ? kept : null);
  }

  const after = await loadMcpConfigs(cwd, { quiet: true });
  const state = after.projectServers?.find((server) => server.name === name)?.state;
  const config = after.servers[name];
  if (approved) {
    if (state !== "approved" || !config) {
      return {
        name,
        approved: false,
        scope,
        status: null,
        error: "Another settings file rejects this server in disabledMcpjsonServers.",
      };
    }
    if (!getMcpRegistryEntry(name)) await connectAdditionalMcpServers({ [name]: config });
  } else if (getMcpRegistryEntry(name)?.connection.config.scope === "project") {
    await disconnectMcpServer(name);
  }
  const { status, error } = registryStatus(name);
  return { name, approved, scope, status, ...(error ? { error } : {}) };
}

/** Drop a server's connection and connect it again. */
export async function reconnectMcpServer(name: string): Promise<McpReconnectResult> {
  if (!getMcpRegistryEntry(name)) throw new AgentSdkError("not_found", `No MCP server named "${name}" is registered.`);
  await reconnectServer(name);
  const { status, error, toolCount } = registryStatus(name);
  if (!status) throw new AgentSdkError("not_found", `MCP server "${name}" was removed while reconnecting.`);
  return { name, status, ...(error ? { error } : {}), toolCount };
}
