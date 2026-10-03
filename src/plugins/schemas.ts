/**
 * Plugin & Marketplace schemas.
 *
 * A "plugin" is a directory that bundles the six extension kinds Easy Agent
 * already supports — Skills / Agents / Commands / Output Styles / Hooks /
 * MCP servers — into a single, namespaced, version-able, distributable unit.
 *
 * This module is the single source of truth for the on-disk shapes:
 *   - `plugin.json`        → {@link PluginManifest}
 *   - `marketplace.json`   → {@link MarketplaceManifest}
 *   - state files          → {@link InstalledPluginRecord} / {@link KnownMarketplace}
 *
 * The schemas cover the fields that map onto supported extension kinds and
 * keep unknown top-level fields for forward-compat. Fields for unsupported
 * features (userConfig, channels, cross-marketplace dependency resolution,
 * plugin signing) are not interpreted.
 */

import { z } from "zod";
import { LspServersSchema } from "../services/lsp/schema.js";

// ─── Shared primitives ────────────────────────────────────────────────

/**
 * A relative path that is only allowed to reference locations INSIDE the
 * plugin root. We reject absolute paths and any `..` segment here so a
 * malformed / hostile manifest can't point the loader outside the plugin
 * directory. Deeper realpath-based containment is enforced at load time
 * (see pathSafety.ts), because a symlink can escape without a literal `..`.
 */
const RelInsidePath = z
  .string()
  .trim()
  .min(1)
  .refine((p) => !p.startsWith("/") && !p.startsWith("\\"), {
    message: "must be a relative path (no leading slash)",
  })
  .refine((p) => !/(^|[\\/])\.\.([\\/]|$)/.test(p), {
    message: "must not contain '..' segments",
  })
  .refine((p) => !/^[a-zA-Z]:[\\/]/.test(p), {
    message: "must not be an absolute Windows path",
  });

/** One or many relative-inside paths. Manifests may declare either shape. */
const RelInsidePathList = z.union([RelInsidePath, z.array(RelInsidePath)]);

// ─── plugin.json ──────────────────────────────────────────────────────

/**
 * The plugin manifest. Only `name` is required; everything else refines
 * discovery. Component path fields SUPPLEMENT the always-scanned default
 * directories (skills/, agents/, commands/, output-styles/, hooks/,
 * .mcp.json) — they never replace them, and they can only point inside the
 * plugin root.
 *
 * `looseObject` keeps unknown top-level keys so a newer plugin format still
 * loads (with a warning surfaced by the loader) instead of hard-failing.
 */
export const PluginManifestSchema = z.looseObject({
  name: z
    .string()
    .trim()
    .min(1)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, {
      message: "plugin name must start alphanumeric and contain only letters, digits, '-' or '_'",
    }),
  version: z.string().trim().min(1).optional(),
  description: z.string().trim().optional(),
  author: z.union([z.string(), z.looseObject({ name: z.string().optional() })]).optional(),
  homepage: z.string().trim().optional(),
  repository: z.string().trim().optional(),
  license: z.string().trim().optional(),
  keywords: z.array(z.string()).optional(),

  // Component path overrides — all constrained to inside the plugin root.
  skills: RelInsidePathList.optional(),
  agents: RelInsidePathList.optional(),
  commands: RelInsidePathList.optional(),
  outputStyles: RelInsidePathList.optional(),
  hooks: RelInsidePathList.optional(),
  mcpServers: RelInsidePathList.optional(),

  lspServers: z.union([RelInsidePathList, LspServersSchema]).optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

// ─── marketplace.json ─────────────────────────────────────────────────

/**
 * How a marketplace resolves a single plugin entry to a source directory:
 *   - a relative `./path` inside the marketplace root, OR
 *   - an external Git URL (with optional ref / commit).
 * Only the plugin `name` is mandatory; version/description are advisory and
 * used as fallbacks when the plugin's own manifest omits them.
 */
export const MarketplacePluginEntrySchema = z.looseObject({
  name: z
    .string()
    .trim()
    .min(1)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  version: z.string().trim().optional(),
  description: z.string().trim().optional(),
  /** `./path` relative to the marketplace root (local plugin), OR a Git URL. */
  source: z.union([RelInsidePath, z.string().trim().min(1)]),
  /** Optional git ref / commit when `source` is a Git URL. */
  ref: z.string().trim().optional(),

  /**
   * When `false`, the plugin's own `plugin.json` is OPTIONAL — the catalog
   * entry itself supplies the identity and component layout. Marketplaces that
   * publish plain component directories (a bare skill folder, say) rely on
   * this. Defaults to strict.
   */
  strict: z.boolean().optional(),

  /**
   * Component paths declared INLINE by the catalog entry, resolved against the
   * plugin root. These are merged with (never replace) whatever the plugin's
   * own manifest declares, which lets a marketplace point at a directory that
   * holds components directly — e.g. `"skills": ["./"]` for a folder whose
   * `SKILL.md` sits at its root.
   */
  skills: RelInsidePathList.optional(),
  agents: RelInsidePathList.optional(),
  commands: RelInsidePathList.optional(),
  outputStyles: RelInsidePathList.optional(),
  hooks: RelInsidePathList.optional(),
  mcpServers: RelInsidePathList.optional(),
  lspServers: RelInsidePathList.optional(),
});

export type MarketplacePluginEntry = z.infer<typeof MarketplacePluginEntrySchema>;

export const MarketplaceManifestSchema = z.looseObject({
  name: z
    .string()
    .trim()
    .min(1)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, {
      message: "marketplace name must be alphanumeric with '-'/'_' only",
    }),
  description: z.string().trim().optional(),
  plugins: z.array(MarketplacePluginEntrySchema).default([]),
});

export type MarketplaceManifest = z.infer<typeof MarketplaceManifestSchema>;

/**
 * The component-path fields a manifest or catalog entry may declare. Persisted
 * verbatim in the install record so a later load reproduces the same layout
 * without re-consulting (or even needing) the originating marketplace.
 */
export interface PluginComponentPaths {
  skills?: string | string[];
  agents?: string | string[];
  commands?: string | string[];
  outputStyles?: string | string[];
  hooks?: string | string[];
  mcpServers?: string | string[];
  lspServers?: string | string[];
}

// ─── State files (~/.easy-agent/plugins/*.json) ───────────────────────

/** Current schema version stamped into every state file for future migration. */
export const PLUGIN_STATE_VERSION = 1;

/** Where a marketplace's plugin directory ultimately came from. */
export type MarketplaceSource = { kind: "local"; path: string } | { kind: "git"; url: string; ref?: string };

export interface KnownMarketplace {
  name: string;
  source: MarketplaceSource;
  /**
   * Absolute path the marketplace manifest is read from. For `local` sources
   * this points at the user's own directory (never deleted on remove); for
   * `git` sources it points at the managed clone under
   * `~/.easy-agent/plugins/marketplaces/<name>`.
   */
  installLocation: string;
  lastUpdated: string;
}

export interface KnownMarketplacesFile {
  version: number;
  marketplaces: Record<string, KnownMarketplace>;
}

/** One entry in `installed_plugins.json`, keyed by the `name@marketplace` id. */
export interface InstalledPluginRecord {
  /** Stable identifier: `<plugin-name>@<marketplace-name>`. */
  pluginId: string;
  name: string;
  marketplace: string;
  version: string;
  /** Git commit SHA (first 12) when the plugin came from a Git source. */
  commit?: string;
  /** Absolute path to the version-locked copy under the managed cache. */
  installPath: string;
  installedAt: string;
  updatedAt: string;
  /**
   * Scopes that currently own this global cached version. Project/local rows
   * carry their project root so uninstalling in one checkout cannot remove a
   * version still referenced by another checkout or by user scope.
   *
   * Missing on legacy v1 records means a single user-scope installation.
   */
  installations?: PluginInstallationScope[];
  /**
   * Whether the plugin's own `plugin.json` was required at install time. `false`
   * for catalog entries marked `strict: false`, whose identity and layout come
   * from the entry instead. Absent means strict (the default).
   */
  strict?: boolean;
  /**
   * Component paths the catalog entry declared inline. Recorded so the runtime
   * reproduces the exact layout on every later refresh — without this, a plugin
   * whose components are described only by the marketplace would load empty
   * after a restart.
   */
  componentPaths?: PluginComponentPaths;
}

export interface PluginInstallationScope {
  scope: PluginScope;
  projectPath?: string;
  installedAt: string;
}

export interface InstalledPluginsFile {
  version: number;
  plugins: Record<string, InstalledPluginRecord>;
}

// ─── Loaded runtime shapes ────────────────────────────────────────────

/**
 * A generic extension source descriptor. Every loader-produced
 * component carries provenance so the runtime can namespace, diagnose, and
 * cleanly remove it on disable/uninstall.
 */
export interface ExtensionSource {
  kind: "built-in" | "user" | "project" | "plugin";
  root: string;
  namespace?: string;
  pluginId?: string;
  /** Lower runs first / loses to higher on unnamespaced collisions. */
  priority: number;
}

/** A structured, non-fatal error attached to one plugin (surfaced by /doctor). */
export interface PluginError {
  pluginId: string;
  /** Where the failure happened (validation / component kind / io). */
  scope: "manifest" | "path" | "skills" | "agents" | "commands" | "outputStyles" | "hooks" | "mcp" | "io";
  message: string;
}

/** The scopes a plugin can be enabled in, mirroring the settings source chain. */
export type PluginScope = "user" | "project" | "local";
