/**
 * Runtime inventory: everything a workspace runtime has loaded, where each
 * item comes from, whether it is in effect, and what it costs in context.
 *
 * Read-only. It reads the live registries the sessions use, so a reload is
 * visible here right away, plus the settings files for configuration that
 * trust rules keep out of the registries (an untrusted project's hooks and
 * `.mcp.json`), so a frontend can show what was ignored and why.
 */

import * as path from "node:path";
import { formatAgentListingLine } from "../agents/promptInjection.js";
import { getAllAgents } from "../agents/registry.js";
import { BUILTIN_COMMAND_HELP } from "../commands/builtinCommandHelp.js";
import { BUILTIN_COMMAND_NAMES } from "../commands/builtinCommandNames.js";
import { getAllUserCommands } from "../commands/userCommands/registry.js";
import { loadFeatureSettings } from "../config/features.js";
import { isProjectTrusted } from "../config/globalState.js";
import { redactUrlForDisplay } from "../config/redaction.js";
import { isTrustedScopeForSensitiveKeys } from "../config/sources.js";
import { listAgentMdFiles } from "../context/claudeMd.js";
import { getProjectMemoryDir, MEMORY_ENTRYPOINT, readMemoryEntrypoint } from "../context/memory/memdir.js";
import { buildPluginView } from "../core/queryEngine/commands/pluginView.js";
import { hooksGloballyDisabled, listConfiguredHooks, refreshHookDisableFromSettings } from "../hooks/settings.js";
import { getActivePlugins } from "../plugins/runtime.js";
import { resolveProfile } from "../services/api/providers/profile.js";
import { getProjectMcpJsonPath, loadMcpConfigs } from "../services/mcp/config.js";
import { getMcpRegistry } from "../services/mcp/registry.js";
import { formatSkillListingLines } from "../services/skills/budget.js";
import {
  getAllUserInvocableSkills,
  getModelVisibleSkills,
  listConditionalSkills,
} from "../services/skills/registry.js";
import { getActiveOutputStyleName, getAllOutputStyles } from "../styles/registry.js";
import { getRegisteredTools, getToolsForMode } from "../tools/index.js";
import { type Tool, toolToApiParam } from "../tools/Tool.js";
import type { ScopedMcpServerConfig } from "../types/mcp.js";
import { estimateJsonTokens, estimateTextTokens } from "../utils/tokens.js";
import { prepareToolSearchRequest } from "../utils/toolSearch.js";
import type { WorkspaceReport } from "./bootstrap.js";
import type {
  AgentInventoryItem,
  CommandInventoryItem,
  HookInventoryItem,
  InventorySource,
  McpServerInventoryItem,
  McpServerStatus,
  McpToolInfo,
  OutputStyleInventoryItem,
  PluginInventoryItem,
  RuleInventoryItem,
  RuntimeInventory,
  SkillInventoryItem,
  TokenCount,
  ToolInventoryItem,
} from "./types.js";

const UNTRUSTED = "The workspace is not trusted.";
const MAX_DESCRIPTION_CHARS = 300;

const estimate = (value: number): TokenCount => ({ value, estimated: true });
const textTokens = (text: string): TokenCount => estimate(estimateTextTokens(text));
const schemaTokens = (tool: Tool): TokenCount => estimate(estimateJsonTokens(JSON.stringify(toolToApiParam(tool))));

/** First paragraph of a description, capped for listing. */
function summary(text: string): string {
  const first =
    text
      .trim()
      .split(/\n\s*\n/)[0]
      ?.replace(/\s+/g, " ") ?? "";
  return first.length > MAX_DESCRIPTION_CHARS ? `${first.slice(0, MAX_DESCRIPTION_CHARS - 1).trimEnd()}…` : first;
}

export async function buildRuntimeInventory(
  cwd: string,
  report: WorkspaceReport,
  model: string,
): Promise<RuntimeInventory> {
  const workspaceTrusted = await isProjectTrusted(cwd);
  const deferred = await deferredToolNames(cwd, model);
  const pluginView = await buildPluginView(cwd);
  const [mcpServers, hooks, rules] = await Promise.all([
    listMcpServers(cwd, deferred),
    listHooks(cwd, workspaceTrusted, pluginView.installed),
    listRules(cwd),
  ]);
  return {
    workspaceTrusted,
    ignoredProjectConfig: workspaceTrusted ? [] : [...report.ignoredProjectConfig],
    skills: listSkills(),
    commands: listCommands(),
    agents: listAgents(),
    outputStyles: listOutputStyles(),
    mcpServers,
    plugins: listPlugins(pluginView),
    hooks,
    rules,
    tools: listTools(deferred),
  };
}

/** Tools ToolSearch defers for the runtime's model in the default mode. */
async function deferredToolNames(cwd: string, model: string): Promise<Set<string>> {
  const profile = await resolveProfile(model, cwd);
  const shaped = prepareToolSearchRequest({
    tools: getToolsForMode("default"),
    messages: [],
    model: profile.model,
    env: {
      protocol: profile.protocol,
      baseURL: profile.baseURL ?? process.env.ANTHROPIC_BASE_URL,
      settings: await loadFeatureSettings(cwd),
    },
    source: "inventory",
  });
  return shaped.deferredToolNames;
}

function listSkills(): SkillInventoryItem[] {
  const visible = getModelVisibleSkills();
  const lines = formatSkillListingLines(visible);
  const listing = new Map(visible.map((skill, index) => [skill.name, lines[index] ?? ""]));
  const latent = new Set(listConditionalSkills().map((skill) => skill.name));
  return getAllUserInvocableSkills().map((skill) => {
    const { frontmatter } = skill;
    const invocation = frontmatter.disableModelInvocation ? "manual" : frontmatter.paths?.length ? "paths" : "model";
    const activated = invocation === "paths" ? !latent.has(skill.name) : undefined;
    const reason =
      invocation === "manual"
        ? `Hidden from the model; run it with /${skill.name}.`
        : activated === false
          ? "Listed to the model once a matching file is read or edited."
          : undefined;
    return {
      kind: "skill",
      id: `skill:${skill.source}:${skill.name}`,
      name: skill.name,
      source: skill.source,
      ...(skill.pluginId ? { pluginId: skill.pluginId } : {}),
      path: skill.filePath,
      enabled: true,
      ...(reason ? { reason } : {}),
      description: skill.description,
      ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
      ...(frontmatter.argumentHint ? { argumentHint: frontmatter.argumentHint } : {}),
      invocation,
      ...(frontmatter.paths?.length ? { paths: [...frontmatter.paths] } : {}),
      ...(activated !== undefined ? { activated } : {}),
      allowedTools: [...frontmatter.allowedTools],
      fork: frontmatter.hasForkContext,
      listing: textTokens(listing.get(skill.name) ?? ""),
      body: textTokens(skill.body),
    };
  });
}

function listCommands(): CommandInventoryItem[] {
  const help = (name: string): string =>
    BUILTIN_COMMAND_HELP.find(({ usage }) => usage === `/${name}` || usage.startsWith(`/${name} `))?.description ?? "";
  const builtins = [...BUILTIN_COMMAND_NAMES].sort().map(
    (name): CommandInventoryItem => ({
      kind: "command",
      id: `command:built-in:${name}`,
      name,
      source: "built-in",
      enabled: true,
      description: help(name),
    }),
  );
  const custom = getAllUserCommands().map(
    (command): CommandInventoryItem => ({
      kind: "command",
      id: `command:${command.source}:${command.name}`,
      name: command.name,
      source: command.source,
      ...(command.pluginId ? { pluginId: command.pluginId } : {}),
      path: command.filePath,
      enabled: true,
      description: command.description,
      ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
    }),
  );
  return [...builtins, ...custom];
}

function listAgents(): AgentInventoryItem[] {
  return getAllAgents().map((agent) => ({
    kind: "agent",
    id: `agent:${agent.source}:${agent.agentType}`,
    name: agent.agentType,
    source: agent.source,
    ...(agent.pluginId ? { pluginId: agent.pluginId } : {}),
    ...(agent.filePath ? { path: agent.filePath } : {}),
    enabled: true,
    description: agent.whenToUse,
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.tools ? { tools: [...agent.tools] } : {}),
    listing: textTokens(formatAgentListingLine(agent)),
  }));
}

function listOutputStyles(): OutputStyleInventoryItem[] {
  const active = getActiveOutputStyleName();
  return getAllOutputStyles().map((style) => ({
    kind: "output_style",
    id: `output_style:${style.source}:${style.name}`,
    name: style.name,
    source: style.source,
    ...(style.pluginId ? { pluginId: style.pluginId } : {}),
    enabled: style.name === active,
    description: style.description,
    active: style.name === active,
    prompt: textTokens(style.prompt),
  }));
}

function transportOf(config: ScopedMcpServerConfig): Pick<McpServerInventoryItem, "transport" | "command" | "url"> {
  if (config.type === "http" || config.type === "sse") {
    return { transport: config.type, url: redactUrlForDisplay(config.url) };
  }
  return { transport: "stdio", command: [config.command, ...(config.args ?? [])].join(" ") };
}

function mcpToolInfo(tool: Tool, deferred: Set<string>): McpToolInfo {
  return {
    name: tool.name,
    description: summary(tool.description),
    readOnly: tool.isReadOnly(),
    deferred: deferred.has(tool.name),
    schema: schemaTokens(tool),
  };
}

/** Plugin that owns each running MCP server, by registry name. */
function pluginOfServer(): Map<string, string> {
  const owners = new Map<string, string>();
  for (const plugin of getActivePlugins()) {
    for (const server of plugin.mcpServers) owners.set(server.namespacedName, plugin.pluginId);
  }
  return owners;
}

async function listMcpServers(cwd: string, deferred: Set<string>): Promise<McpServerInventoryItem[]> {
  const { projectServers = [] } = await loadMcpConfigs(cwd, { quiet: true });
  const projectFile = getProjectMcpJsonPath(cwd);
  const fromProjectFile = new Set(projectServers.filter((s) => s.state === "approved").map((s) => s.name));
  const owners = pluginOfServer();

  const items: McpServerInventoryItem[] = getMcpRegistry().map(({ connection, tools }) => {
    const pluginId = owners.get(connection.name);
    const status: McpServerStatus = connection.type;
    const source: InventorySource = pluginId ? "plugin" : connection.config.scope;
    return {
      kind: "mcp_server",
      id: `mcp_server:${connection.name}`,
      name: connection.name,
      source,
      ...(pluginId ? { pluginId } : {}),
      ...(!pluginId && connection.config.scope === "project" && fromProjectFile.has(connection.name)
        ? { path: projectFile }
        : {}),
      enabled: status === "connected" || status === "pending",
      ...transportOf(connection.config),
      status,
      ...(connection.type === "failed" ? { error: connection.error } : {}),
      tools: tools.map((tool) => mcpToolInfo(tool, deferred)),
    };
  });

  const registered = new Set(items.map((item) => item.name));
  for (const server of projectServers) {
    if (server.state === "approved" || registered.has(server.name)) continue;
    const status: McpServerStatus =
      server.state === "pending" ? "awaiting_approval" : server.state === "rejected" ? "rejected" : "ignored";
    const reason =
      status === "awaiting_approval"
        ? "Not approved yet."
        : status === "rejected"
          ? "Rejected in disabledMcpjsonServers."
          : UNTRUSTED;
    items.push({
      kind: "mcp_server",
      id: `mcp_server:${server.name}`,
      name: server.name,
      source: "project",
      path: projectFile,
      enabled: false,
      reason,
      ...transportOf(server.config),
      status,
      tools: [],
    });
  }
  return items;
}

type PluginView = Awaited<ReturnType<typeof buildPluginView>>;

function listPlugins(view: PluginView): PluginInventoryItem[] {
  return view.installed.map((row) => {
    const limited = row.enabled && row.hasExecutableComponents && !row.executablesTrusted;
    return {
      kind: "plugin",
      id: `plugin:${row.pluginId}`,
      name: row.name,
      source: row.scope ?? "user",
      pluginId: row.pluginId,
      enabled: row.enabled,
      ...(limited ? { reason: `${UNTRUSTED} Its hooks, MCP servers, and LSP servers do not run.` } : {}),
      marketplace: row.marketplace,
      version: row.version,
      ...(row.description ? { description: row.description } : {}),
      ...(row.author ? { author: row.author } : {}),
      ...(row.scope ? { scope: row.scope } : {}),
      components: {
        skills: [...row.componentNames.skills],
        commands: [...row.componentNames.commands],
        agents: [...row.componentNames.agents],
        outputStyles: [...row.componentNames.outputStyles],
        hooks: [...row.componentNames.hooks],
        mcpServers: [...row.componentNames.mcpServers],
        lspServers: [...(row.componentNames.lspServers ?? [])],
      },
      hasExecutableComponents: row.hasExecutableComponents,
      executablesTrusted: row.executablesTrusted,
      errors: view.errors.filter((error) => error.pluginId === row.pluginId).map((error) => error.message),
      warnings: [...row.warnings],
    };
  });
}

async function listHooks(
  cwd: string,
  workspaceTrusted: boolean,
  plugins: PluginView["installed"],
): Promise<HookInventoryItem[]> {
  await refreshHookDisableFromSettings(cwd);
  const globallyDisabled = hooksGloballyDisabled(cwd);
  const off = "Hooks are turned off (disableAllHooks or EASY_AGENT_DISABLE_HOOKS).";
  const items: HookInventoryItem[] = [];
  const counters = new Map<string, number>();
  const nextId = (prefix: string): string => {
    const index = counters.get(prefix) ?? 0;
    counters.set(prefix, index + 1);
    return `${prefix}:${index}`;
  };

  for (const entry of await listConfiguredHooks(cwd)) {
    const applies = isTrustedScopeForSensitiveKeys(entry.source) || workspaceTrusted;
    const reason = globallyDisabled ? off : applies ? undefined : UNTRUSTED;
    items.push({
      kind: "hook",
      id: nextId(`hook:${entry.source}:${entry.event}`),
      name: entry.matcher ? `${entry.event} ${entry.matcher}` : entry.event,
      source: entry.source,
      ...(entry.path ? { path: entry.path } : {}),
      enabled: !reason,
      ...(reason ? { reason } : {}),
      event: entry.event,
      ...(entry.matcher ? { matcher: entry.matcher } : {}),
      command: entry.hook.command,
      timeout: entry.hook.timeout ?? 60,
      ...(entry.hook.shell ? { shell: entry.hook.shell } : {}),
    });
  }

  const trustedPlugins = new Map(plugins.map((row) => [row.pluginId, row.executablesTrusted]));
  for (const plugin of getActivePlugins()) {
    const reason = globallyDisabled ? off : trustedPlugins.get(plugin.pluginId) === false ? UNTRUSTED : undefined;
    for (const entry of plugin.hooks) {
      for (const hook of entry.hooks) {
        items.push({
          kind: "hook",
          id: nextId(`hook:plugin:${plugin.pluginId}:${entry.event}`),
          name: entry.matcher ? `${entry.event} ${entry.matcher}` : entry.event,
          source: "plugin",
          pluginId: plugin.pluginId,
          enabled: !reason,
          ...(reason ? { reason } : {}),
          event: entry.event,
          ...(entry.matcher ? { matcher: entry.matcher } : {}),
          command: hook.command,
          timeout: hook.timeout ?? 60,
          ...(hook.shell ? { shell: hook.shell } : {}),
        });
      }
    }
  }
  return items;
}

const lineCount = (text: string): number => (text ? text.split("\n").length : 0);

async function listRules(cwd: string): Promise<RuleInventoryItem[]> {
  const items: RuleInventoryItem[] = (await listAgentMdFiles(cwd)).map((file) => ({
    kind: "rule",
    id: `rule:${file.filePath}`,
    name: path.basename(file.filePath),
    source: file.scope === "global" ? "user" : "project",
    path: file.filePath,
    enabled: !file.excluded,
    ...(file.excluded ? { reason: "Matched by claudeMdExcludes." } : {}),
    scope: file.scope,
    excluded: file.excluded,
    lines: lineCount(file.content),
    tokens: textTokens(file.content),
  }));
  const memory = await readMemoryEntrypoint(cwd).catch(() => null);
  if (memory) {
    items.push({
      kind: "rule",
      id: "rule:memory",
      name: MEMORY_ENTRYPOINT,
      source: "project",
      path: path.join(await getProjectMemoryDir(cwd), MEMORY_ENTRYPOINT),
      enabled: true,
      scope: "memory",
      excluded: false,
      lines: lineCount(memory),
      tokens: textTokens(memory),
    });
  }
  return items;
}

function listTools(deferred: Set<string>): ToolInventoryItem[] {
  const servers = new Map<string, { name: string; source: InventorySource; pluginId?: string }>();
  const owners = pluginOfServer();
  for (const { connection, tools } of getMcpRegistry()) {
    const pluginId = owners.get(connection.name);
    for (const tool of tools) {
      servers.set(tool.name, {
        name: connection.name,
        source: pluginId ? "plugin" : connection.config.scope,
        ...(pluginId ? { pluginId } : {}),
      });
    }
  }
  return getRegisteredTools().map((tool) => {
    const server = servers.get(tool.name);
    const enabled = tool.isEnabled();
    return {
      kind: "tool",
      id: `tool:${tool.name}`,
      name: tool.name,
      source: server?.source ?? "built-in",
      ...(server?.pluginId ? { pluginId: server.pluginId } : {}),
      enabled,
      ...(enabled ? {} : { reason: "Turned off by its feature setting or not available on this platform." }),
      description: summary(tool.description),
      readOnly: tool.isReadOnly(),
      ...(server ? { mcpServer: server.name } : {}),
      deferred: deferred.has(tool.name),
      schema: schemaTokens(tool),
    };
  });
}
