/**
 * Runtime shapes produced by the Plugin Loader (plan §35.2).
 *
 * A `LoadedPlugin` is the fully-resolved, namespaced snapshot of everything a
 * single plugin contributes — the currency the runtime merges into the live
 * registries. Every component already carries its plugin provenance so it can
 * be cleanly removed on disable/uninstall.
 */

import type { Skill } from "../types/types.js";
import type { AgentDefinition } from "../agents/types.js";
import type { UserCommand } from "../commands/userCommands/types.js";
import type { OutputStyleConfig } from "../styles/registry.js";
import type { HookCommand, HookEvent } from "../hooks/types.js";
import type { ScopedMcpServerConfig } from "../types/mcp.js";
import type { PluginError, PluginManifest } from "./schemas.js";

/** One plugin-contributed hook matcher group, tagged with its owner. */
export interface PluginHookEntry {
  event: HookEvent;
  matcher?: string;
  hooks: HookCommand[];
  pluginId: string;
  pluginRoot: string;
}

/** A plugin-contributed MCP server, namespaced `plugin:<plugin>:<server>`. */
export interface PluginMcpServer {
  /** Namespaced server id used in the registry / status UI. */
  namespacedName: string;
  config: ScopedMcpServerConfig;
  pluginId: string;
  pluginRoot: string;
}

export interface LoadedPlugin {
  /** Stable id `<name>@<marketplace>`; for `--plugin-dir` it's `<name>@dev`. */
  pluginId: string;
  /** The plugin's own name (namespace prefix for all its components). */
  name: string;
  version: string;
  /** Absolute plugin root directory. */
  root: string;
  /** Cross-version data directory (`${EASY_AGENT_PLUGIN_DATA}`). */
  dataDir: string;
  manifest: PluginManifest;

  skills: Skill[];
  agents: AgentDefinition[];
  commands: UserCommand[];
  outputStyles: OutputStyleConfig[];
  hooks: PluginHookEntry[];
  mcpServers: PluginMcpServer[];
  lspServers: import("../services/lsp/runtime.js").LspRegistration[];

  /** True when the plugin ships hooks, MCP, or LSP servers (needs trust to run). */
  hasExecutableComponents: boolean;

  /** Non-fatal per-component failures; the plugin still loads its good parts. */
  errors: PluginError[];
  /** Human-readable warnings (unknown manifest fields, dropped files, …). */
  warnings: string[];
}
