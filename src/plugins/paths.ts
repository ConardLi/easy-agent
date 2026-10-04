/**
 * On-disk layout for the plugin subsystem.
 *
 * Everything the runtime writes lives under `~/.easy-agent/plugins/`:
 *
 *   ~/.easy-agent/plugins/
 *   ├── known_marketplaces.json          ← registered marketplace sources
 *   ├── installed_plugins.json           ← version-locked install records
 *   ├── marketplaces/<marketplace>/      ← managed clones of Git marketplaces
 *   ├── cache/<marketplace>/<plugin>/<version>/   ← version-locked plugin copies
 *   └── data/<plugin@marketplace>/       ← per-plugin data, preserved across versions
 *
 * These are all derived from `getEasyAgentPath(...)` so they share the one
 * home-dir resolution the rest of the CLI uses (see utils/paths.ts). The
 * helpers are pure — they never touch the filesystem; callers `mkdir -p`.
 */

import * as path from "node:path";
import { createHash } from "node:crypto";
import { getEasyAgentPath } from "../utils/paths.js";

/**
 * The plugin manifest lives at `<pluginRoot>/<manifestDir>/plugin.json`.
 *
 * `PLUGIN_MANIFEST_DIR` is the CANONICAL directory we create when scaffolding.
 * `PLUGIN_MANIFEST_DIRS` is the ordered list we ACCEPT when reading, so plugins
 * authored against the widely-used `.claude-plugin/` convention load unchanged.
 * Order matters: the first existing directory wins.
 */
export const PLUGIN_MANIFEST_DIR = ".easy-agent-plugin";
export const PLUGIN_MANIFEST_DIRS = [".easy-agent-plugin", ".claude-plugin"] as const;
export const PLUGIN_MANIFEST_FILE = "plugin.json";
export const MARKETPLACE_MANIFEST_FILE = "marketplace.json";

/** Whether a directory basename is a recognized manifest directory. */
export function isPluginManifestDir(basename: string): boolean {
  return (PLUGIN_MANIFEST_DIRS as readonly string[]).includes(basename);
}

/** `~/.easy-agent/plugins`. */
export function getPluginsRoot(): string {
  return getEasyAgentPath("plugins");
}

export function getKnownMarketplacesPath(): string {
  return path.join(getPluginsRoot(), "known_marketplaces.json");
}

export function getInstalledPluginsPath(): string {
  return path.join(getPluginsRoot(), "installed_plugins.json");
}

/** `~/.easy-agent/plugins/marketplaces/<name>` — managed clone of a Git marketplace. */
export function getManagedMarketplaceDir(name: string): string {
  return path.join(getManagedMarketplaceRoot(), safePathSegment(name));
}

/** Root containing managed Git marketplace clones only. */
export function getManagedMarketplaceRoot(): string {
  return path.join(getPluginsRoot(), "marketplaces");
}

/** `~/.easy-agent/plugins/cache/<marketplace>/<plugin>/<version>` — version-locked copy. */
export function getPluginCacheDir(marketplace: string, plugin: string, version: string): string {
  return path.join(
    getPluginCacheRoot(),
    safePathSegment(marketplace),
    safePathSegment(plugin),
    safePathSegment(version),
  );
}

/** `~/.easy-agent/plugins/data/<plugin@marketplace>` — cross-version data dir. */
export function getPluginDataDir(pluginId: string): string {
  return path.join(getPluginDataRoot(), safePathSegment(pluginId));
}

/** Root containing only versioned, disposable plugin copies. */
export function getPluginCacheRoot(): string {
  return path.join(getPluginsRoot(), "cache");
}

/** Root containing persistent, explicitly user-removable plugin data. */
export function getPluginDataRoot(): string {
  return path.join(getPluginsRoot(), "data");
}

/**
 * Convert untrusted manifest/catalog identifiers into one filesystem segment.
 *
 * Versions are publisher-controlled and may legally contain punctuation, but
 * must never become path syntax. A short hash suffix preserves determinism and
 * prevents two different unsafe versions from collapsing onto the same cache
 * directory after replacement.
 */
export function safePathSegment(value: string): string {
  const trimmed = value.trim();
  const clean = trimmed
    .replace(/[^a-zA-Z0-9._+-]/g, "-")
    .replace(/^\.+$/, "")
    .slice(0, 120);
  if (clean === trimmed && clean !== "" && clean !== "." && clean !== "..") {
    return clean;
  }
  const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, 10);
  const prefix = clean && clean !== "." && clean !== ".." ? clean : "unknown";
  return `${prefix.slice(0, 100)}-${digest}`;
}

/** Canonical manifest path inside a plugin root directory (used for scaffolding). */
export function getPluginManifestPath(pluginRoot: string): string {
  return path.join(pluginRoot, PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE);
}

/** Ordered candidate manifest paths inside a plugin root, by dir preference. */
export function getPluginManifestPathCandidates(pluginRoot: string): string[] {
  return PLUGIN_MANIFEST_DIRS.map((dir) => path.join(pluginRoot, dir, PLUGIN_MANIFEST_FILE));
}

/** Canonical marketplace manifest path inside a marketplace root directory. */
export function getMarketplaceManifestPath(marketplaceRoot: string): string {
  return path.join(marketplaceRoot, PLUGIN_MANIFEST_DIR, MARKETPLACE_MANIFEST_FILE);
}

/** Ordered candidate marketplace manifest paths inside a marketplace root. */
export function getMarketplaceManifestPathCandidates(marketplaceRoot: string): string[] {
  return PLUGIN_MANIFEST_DIRS.map((dir) => path.join(marketplaceRoot, dir, MARKETPLACE_MANIFEST_FILE));
}

// ─── Variable substitution ────────────────────────────────────────────

/**
 * The two environment variables a plugin's components (hooks / MCP / bodies)
 * may reference. `ROOT` is the current version's directory; `DATA` survives
 * upgrades so a plugin can keep caches / sqlite / logs across versions.
 */
export const PLUGIN_ROOT_VAR = "EASY_AGENT_PLUGIN_ROOT";
export const PLUGIN_DATA_VAR = "EASY_AGENT_PLUGIN_DATA";

/**
 * Substitute `${EASY_AGENT_PLUGIN_ROOT}` / `${EASY_AGENT_PLUGIN_DATA}` in a
 * string. Used for hook commands, MCP command/args/env, and component bodies.
 * Unknown `${...}` tokens are left untouched so we don't clobber a user's own
 * shell variables.
 */
export function substitutePluginVars(input: string, vars: { root: string; data: string }): string {
  return input.replaceAll(`\${${PLUGIN_ROOT_VAR}}`, vars.root).replaceAll(`\${${PLUGIN_DATA_VAR}}`, vars.data);
}
