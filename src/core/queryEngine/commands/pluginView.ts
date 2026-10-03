/**
 * Snapshot builder for the interactive `/plugin` manager.
 *
 * Feeds the manager's four tabs — Discover / Installed / Marketplaces /
 * Errors — by turning the three separate pieces of
 * durable state (marketplace sources, install records, per-scope enable flags)
 * plus the live runtime snapshot into one flat, render-ready payload.
 *
 * Read-only: this never mutates state, so the overlay can rebuild it after
 * every action to stay in sync.
 */

import {
  getActivePluginErrors,
  getActivePlugins,
  getEnabledPluginState,
  listMarketplaces,
  loadPlugin,
  readInstalledPlugins,
  readMarketplaceManifest,
} from "../../../plugins/index.js";
import { isProjectTrusted } from "../../../config/globalState.js";
import type { PluginScope } from "../../../plugins/index.js";
import type {
  PluginAvailableRow,
  PluginComponentCounts,
  PluginComponentNames,
  PluginInstalledRow,
  PluginMarketplaceRow,
  PluginViewData,
} from "../types.js";

/**
 * `bySource` reports any settings layer (including `flag` / `policy`), but only
 * the three writable layers are addressable as a plugin scope.
 */
const WRITABLE_SCOPES = new Set<string>(["user", "project", "local"]);
function asPluginScope(source: string | undefined): PluginScope | undefined {
  return source !== undefined && WRITABLE_SCOPES.has(source)
    ? (source as PluginScope)
    : undefined;
}

const EMPTY_COUNTS: PluginComponentCounts = {
  skills: 0,
  agents: 0,
  commands: 0,
  outputStyles: 0,
  hooks: 0,
  mcpServers: 0,
  lspServers: 0,
};

const EMPTY_NAMES: PluginComponentNames = {
  skills: [],
  agents: [],
  commands: [],
  outputStyles: [],
  hooks: [],
  mcpServers: [],
  lspServers: [],
};

function authorLabel(author: unknown): string | undefined {
  if (typeof author === "string") return author;
  if (
    author &&
    typeof author === "object" &&
    typeof (author as { name?: unknown }).name === "string"
  ) {
    return (author as { name: string }).name;
  }
  return undefined;
}

export async function buildPluginView(cwd: string): Promise<PluginViewData> {
  const [installedFile, enableState, marketplaces, trusted] = await Promise.all([
    readInstalledPlugins(),
    getEnabledPluginState(cwd),
    listMarketplaces(),
    isProjectTrusted(cwd),
  ]);

  // Load disabled records too. Parsing a cached plugin is side-effect free and
  // lets the manager show an accurate component/risk preview before enabling
  // or updating it.
  const active = new Map(getActivePlugins().map((p) => [p.pluginId, p]));
  const inspected = new Map(active);
  await Promise.all(
    Object.values(installedFile.plugins).map(async (record) => {
      if (inspected.has(record.pluginId)) return;
      const loaded = await loadPlugin({
        root: record.installPath,
        pluginId: record.pluginId,
        strict: record.strict !== false,
        nameHint: record.name,
        ...(record.componentPaths ? { overlay: record.componentPaths } : {}),
      }).catch(() => null);
      if (loaded) inspected.set(record.pluginId, loaded);
    }),
  );
  const runtimeErrors = getActivePluginErrors();

  const installed: PluginInstalledRow[] = Object.values(installedFile.plugins)
    .map((record) => {
      const loaded = inspected.get(record.pluginId);
      const source = enableState.bySource.get(record.pluginId);
      const scope = asPluginScope(source);
      const manifest = loaded?.manifest;
      return {
        pluginId: record.pluginId,
        name: record.name,
        marketplace: record.marketplace,
        version: record.version,
        ...(manifest?.description ? { description: manifest.description } : {}),
        ...(authorLabel(manifest?.author) ? { author: authorLabel(manifest?.author) } : {}),
        ...(manifest?.homepage ? { homepage: manifest.homepage } : {}),
        ...(manifest?.repository ? { repository: manifest.repository } : {}),
        enabled: enableState.enabled.has(record.pluginId),
        ...(scope ? { scope } : {}),
        components: loaded
          ? {
              skills: loaded.skills.length,
              agents: loaded.agents.length,
              commands: loaded.commands.length,
              outputStyles: loaded.outputStyles.length,
              hooks: loaded.hooks.length,
              mcpServers: loaded.mcpServers.length,
              lspServers: loaded.lspServers.length,
            }
          : { ...EMPTY_COUNTS },
        componentNames: loaded
          ? {
              skills: loaded.skills.map((item) => item.name),
              agents: loaded.agents.map((item) => item.agentType),
              commands: loaded.commands.map((item) => item.name),
              outputStyles: loaded.outputStyles.map((item) => item.name),
              hooks: loaded.hooks.map((item) =>
                `${item.event}${item.matcher ? `:${item.matcher}` : ""}`,
              ),
              mcpServers: loaded.mcpServers.map((item) => item.namespacedName),
              lspServers: loaded.lspServers.map((item) => item.name),
            }
          : { ...EMPTY_NAMES },
        hasExecutableComponents: loaded?.hasExecutableComponents ?? false,
        warnings: loaded?.warnings ?? [],
        errorCount:
          (active.has(record.pluginId) ? 0 : (loaded?.errors.length ?? 0)) +
          runtimeErrors.filter((error) => error.pluginId === record.pluginId).length,
        // Same rule the runtime applies: user-scope enable is the machine
        // owner's own call and always runs; anything else needs folder trust.
        executablesTrusted: source === "user" ? true : trusted,
      };
    })
    .sort((a, b) => a.pluginId.localeCompare(b.pluginId));

  const installedIds = new Set(installed.map((p) => p.pluginId));

  // ── Marketplaces + the catalogued-but-not-installed set ──
  const marketplaceRows: PluginMarketplaceRow[] = [];
  const available: PluginAvailableRow[] = [];
  for (const entry of marketplaces) {
    let pluginCount: number | null = null;
    let readError: string | undefined;
    try {
      const { manifest } = await readMarketplaceManifest(entry.installLocation);
      pluginCount = manifest.plugins.length;
      for (const plugin of manifest.plugins) {
        const pluginId = `${plugin.name}@${entry.name}`;
        if (installedIds.has(pluginId)) continue;
        available.push({
          pluginId,
          name: plugin.name,
          marketplace: entry.name,
          ...(plugin.description ? { description: plugin.description } : {}),
          ...(plugin.version ? { version: plugin.version } : {}),
        });
      }
    } catch (error) {
      readError = (error as Error).message;
    }
    marketplaceRows.push({
      name: entry.name,
      kind: entry.source.kind,
      location: entry.installLocation,
      lastUpdated: entry.lastUpdated,
      pluginCount,
      ...(readError ? { error: readError } : {}),
    });
  }

  available.sort((a, b) => a.pluginId.localeCompare(b.pluginId));
  marketplaceRows.sort((a, b) => a.name.localeCompare(b.name));

  return {
    installed,
    available,
    marketplaces: marketplaceRows,
    errors: [
      ...runtimeErrors,
      ...[...inspected.values()]
        .filter((plugin) => !active.has(plugin.pluginId))
        .flatMap((plugin) => plugin.errors),
    ].map((e) => ({
      pluginId: e.pluginId,
      scope: e.scope,
      message: e.message,
    })),
    projectTrusted: trusted,
  };
}
