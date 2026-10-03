/**
 * Public surface of the plugin subsystem.
 *
 * A plugin bundles Easy Agent's six extension kinds — Skills / Agents /
 * Commands / Output Styles / Hooks / MCP servers — into one namespaced,
 * version-locked, distributable unit resolved through a static marketplace.
 *
 * Layers (bottom-up):
 *   schemas / paths / pathSafety  — on-disk shapes + containment
 *   state / enable                — durable install + per-scope enable state
 *   git / marketplace / install   — fetch + resolve + version-lock + rollback
 *   loader / namespace            — parse a dir → namespaced component snapshot
 *   runtime / mcpApply            — reconcile snapshots into the live registries
 */

export * from "./schemas.js";
export * from "./loadedTypes.js";
export * from "./namespace.js";
export {
  getPluginsRoot,
  getInstalledPluginsPath,
  getKnownMarketplacesPath,
  getPluginDataDir,
  PLUGIN_ROOT_VAR,
  PLUGIN_DATA_VAR,
  substitutePluginVars,
} from "./paths.js";
export { resolveInsidePlugin } from "./pathSafety.js";
export {
  readKnownMarketplaces,
  readInstalledPlugins,
  loadPluginStateDiagnostics,
} from "./state.js";
export {
  getEnabledPluginIds,
  getEnabledPluginState,
  setPluginEnabled,
  ENABLED_PLUGINS_KEY,
} from "./enable.js";
export { loadPlugin, type LoadPluginOptions } from "./loader.js";
export {
  addMarketplace,
  listMarketplaces,
  getMarketplace,
  updateMarketplace,
  removeMarketplace,
  resolvePlugin,
  readMarketplaceManifest,
  type ResolvedPluginEntry,
} from "./marketplace.js";
export {
  installPlugin,
  inspectPlugin,
  updatePlugin,
  uninstallPlugin,
  isManagedPluginPath,
  type InstallResult,
  type InstallOptions,
  type PluginInstallPreview,
  type UninstallOptions,
} from "./install.js";
export {
  refreshActivePlugins,
  getActivePlugins,
  getActivePluginErrors,
  getActivePluginHooks,
  _resetPluginRuntimeForTesting,
  type RefreshOptions,
  type RefreshResult,
} from "./runtime.js";
export { diffMcpServers, applyPluginMcpDiff, type McpDiff } from "./mcpApply.js";
export { GitError } from "./git.js";
