/**
 * Install / update / uninstall (plan §35.5).
 *
 * Install pipeline (fixed order — safety depends on it):
 *   resolve id → fetch to a TEMP dir → validate manifest/paths/components →
 *   compute version → copy into a version-locked cache dir → atomically update
 *   the install record → enable in the requested scope.
 *
 * Everything before the record update is reversible: a failure deletes the temp
 * (and any half-copied cache dir) and leaves `installed_plugins.json` untouched,
 * so a broken download can never pollute state or leave a loadable half-plugin
 * on disk.
 *
 * Delete safety: uninstall only ever removes a directory it can prove lives
 * under `~/.easy-agent/plugins/cache/`. Local marketplaces, `--plugin-dir`
 * checkouts and external source directories are never deleted.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  getPluginCacheDir,
  getPluginCacheRoot,
  getPluginDataDir,
  getPluginDataRoot,
  getPluginsRoot,
} from "./paths.js";
import {
  componentPathsFromEntry,
  resolvePlugin,
  type ResolvedPluginEntry,
} from "./marketplace.js";
import { gitClone, gitHeadCommit } from "./git.js";
import { loadPlugin } from "./loader.js";
import {
  readInstalledPlugins,
  removeInstalledPlugin,
  updateInstalledPlugins,
  upsertInstalledPlugin,
  withPluginOperationLock,
} from "./state.js";
import { ensurePrivateDirectory } from "../utils/privateData.js";
import { setPluginEnabled } from "./enable.js";
import type { InstalledPluginRecord, PluginScope } from "./schemas.js";
import type { LoadedPlugin } from "./loadedTypes.js";

export interface InstallResult {
  record: InstalledPluginRecord;
  loaded: LoadedPlugin;
  /** True when hooks/MCP were present and require folder trust to run. */
  requiresTrust: boolean;
}

export interface InstallOptions {
  /**
   * Explicit user acknowledgement that Hooks/MCP can execute local processes.
   * Non-interactive callers leave this false, so executable plugins fail
   * closed instead of silently acquiring code-execution capability.
   */
  allowExecutableComponents?: boolean;
  /** Content fingerprint shown in the UI preflight, preventing TOCTOU swaps. */
  expectedFingerprint?: string;
}

export interface PluginInstallPreview {
  pluginId: string;
  version: string;
  fingerprint: string;
  description?: string;
  components: {
    skills: string[];
    agents: string[];
    commands: string[];
    outputStyles: string[];
    hooks: string[];
    mcpServers: string[];
  };
  hasExecutableComponents: boolean;
  warnings: string[];
  errors: string[];
}

async function makeTempDir(label: string): Promise<string> {
  const dir = path.join(getPluginsRoot(), ".tmp", `${label}-${process.pid}-${Date.now()}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Stable content hash excluding Git's transport metadata. */
async function fingerprintTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (dir: string, relativeDir = ""): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const absolute = path.join(dir, entry.name);
      const relative = path.join(relativeDir, entry.name).split(path.sep).join("/");
      if (entry.isDirectory()) {
        hash.update(`dir\0${relative}\0`);
        await walk(absolute, relative);
      } else if (entry.isSymbolicLink()) {
        hash.update(`link\0${relative}\0${await fs.readlink(absolute)}\0`);
      } else if (entry.isFile()) {
        hash.update(`file\0${relative}\0`);
        hash.update(await fs.readFile(absolute));
        hash.update("\0");
      } else {
        hash.update(`other\0${relative}\0`);
      }
    }
  };
  await walk(root);
  return hash.digest("hex");
}

/** Copy a directory tree; the temp form is same-filesystem so rename is atomic. */
async function copyTree(src: string, dest: string): Promise<void> {
  await safeRemoveInside(dest, getPluginCacheRoot());
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.cp(src, dest, { recursive: true, dereference: false });
}

async function fetchToTemp(
  pluginSource: ResolvedPluginEntry["pluginSource"],
): Promise<{ dir: string; commit?: string }> {
  const dir = await makeTempDir("fetch");
  if (pluginSource.kind === "local") {
    // Copy INTO an empty dir (fs.cp needs the dest to not pre-exist as a file).
    await fs.rm(dir, { recursive: true, force: true });
    await fs.cp(pluginSource.path, dir, { recursive: true, dereference: false });
    return { dir };
  }
  // Git: clone into a fresh dir (gitClone requires dest to not exist).
  await fs.rm(dir, { recursive: true, force: true });
  await gitClone(pluginSource.url, dir, pluginSource.ref);
  const commit = await gitHeadCommit(dir);
  return { dir, ...(commit ? { commit } : {}) };
}

/**
 * Version priority: plugin.json → marketplace entry → git SHA → "unknown".
 *
 * The SHA may come from the plugin's own clone or, for a plugin sourced as a
 * path inside a Git marketplace, from that marketplace's checkout — without it
 * such a plugin would install under the literal directory "unknown" and lose
 * version locking entirely.
 */
function resolveVersion(
  loaded: LoadedPlugin,
  entryVersion: string | undefined,
  commit: string | undefined,
): string {
  if (loaded.manifest.version && loaded.manifest.version !== "unknown") {
    return loaded.manifest.version;
  }
  if (entryVersion) return entryVersion;
  if (commit) return commit;
  return "unknown";
}

function hasFatalManifestError(loaded: LoadedPlugin): boolean {
  return loaded.errors.some((e) => e.scope === "manifest");
}

/**
 * Fetch and fully validate a marketplace entry without changing installation
 * or enable state. The manager uses this to show the exact component/risk list
 * before asking for confirmation.
 */
export async function inspectPlugin(pluginRef: string): Promise<PluginInstallPreview> {
  return withPluginOperationLock(() => inspectPluginUnlocked(pluginRef));
}

async function inspectPluginUnlocked(pluginRef: string): Promise<PluginInstallPreview> {
  const resolved = await resolvePlugin(pluginRef);
  const pluginId = `${resolved.entry.name}@${resolved.marketplace.name}`;
  const strict = resolved.entry.strict !== false;
  const componentPaths = componentPathsFromEntry(resolved.entry);
  const { dir: tempDir, commit: sourceCommit } = await fetchToTemp(resolved.pluginSource);
  try {
    const loaded = await loadPlugin({
      root: tempDir,
      pluginId,
      strict,
      nameHint: resolved.entry.name,
      overlay: componentPaths,
    });
    const commit =
      sourceCommit ??
      (resolved.marketplace.source.kind === "git"
        ? await gitHeadCommit(resolved.marketplace.installLocation)
        : undefined);
    return {
      pluginId,
      version: resolveVersion(loaded, resolved.entry.version, commit),
      fingerprint: await fingerprintTree(tempDir),
      ...(loaded.manifest.description
        ? { description: loaded.manifest.description }
        : resolved.entry.description
          ? { description: resolved.entry.description }
          : {}),
      components: {
        skills: loaded.skills.map((item) => item.name),
        agents: loaded.agents.map((item) => item.agentType),
        commands: loaded.commands.map((item) => item.name),
        outputStyles: loaded.outputStyles.map((item) => item.name),
        hooks: loaded.hooks.map((item) =>
          `${item.event}${item.matcher ? `:${item.matcher}` : ""}`,
        ),
        mcpServers: loaded.mcpServers.map((item) => item.namespacedName),
      },
      hasExecutableComponents: loaded.hasExecutableComponents,
      warnings: loaded.warnings,
      errors: loaded.errors.map((issue) => `[${issue.scope}] ${issue.message}`),
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Install (or reinstall) a plugin referenced as `name` or `name@marketplace`
 * and enable it in `scope`. Returns the install record + the loaded snapshot
 * (so the caller can display the component manifest / trust prompt).
 */
export async function installPlugin(
  pluginRef: string,
  scope: PluginScope = "user",
  cwd: string = process.cwd(),
  options: InstallOptions = {},
): Promise<InstallResult> {
  return withPluginOperationLock(() =>
    installPluginUnlocked(pluginRef, scope, cwd, options),
  );
}

async function installPluginUnlocked(
  pluginRef: string,
  scope: PluginScope,
  cwd: string,
  options: InstallOptions,
): Promise<InstallResult> {
  const resolved = await resolvePlugin(pluginRef);
  const pluginId = `${resolved.entry.name}@${resolved.marketplace.name}`;

  // A catalog entry may opt out of requiring `plugin.json` and describe the
  // component layout itself; both are needed on every later load, so they are
  // resolved once here and persisted with the install record.
  const strict = resolved.entry.strict !== false;
  const componentPaths = componentPathsFromEntry(resolved.entry);
  const loadOpts = {
    pluginId,
    strict,
    nameHint: resolved.entry.name,
    overlay: componentPaths,
  };

  const { dir: tempDir, commit: sourceCommit } = await fetchToTemp(resolved.pluginSource);
  // A plugin living inside a Git marketplace has no clone of its own, so fall
  // back to the marketplace checkout's HEAD to keep the install version-locked.
  const commit =
    sourceCommit ??
    (resolved.marketplace.source.kind === "git"
      ? await gitHeadCommit(resolved.marketplace.installLocation)
      : undefined);
  let installPath: string | null = null;
  try {
    const loaded = await loadPlugin({ root: tempDir, ...loadOpts });
    if (hasFatalManifestError(loaded)) {
      throw new Error(
        `plugin validation failed: ${loaded.errors.map((e) => e.message).join("; ")}`,
      );
    }
    if (loaded.hasExecutableComponents && options.allowExecutableComponents !== true) {
      const kinds = [
        loaded.hooks.length > 0 ? `${loaded.hooks.length} hook group(s)` : "",
        loaded.mcpServers.length > 0 ? `${loaded.mcpServers.length} MCP server(s)` : "",
      ].filter(Boolean);
      throw new Error(
        `confirmation required: ${pluginId} includes ${kinds.join(" and ")} that may execute local processes. ` +
          "Open /plugin and review the install, or use a pre-approved interactive flow.",
      );
    }
    if (
      options.expectedFingerprint &&
      (await fingerprintTree(tempDir)) !== options.expectedFingerprint
    ) {
      throw new Error(
        `plugin contents changed after confirmation: ${pluginId}. ` +
          "Review the updated component list and confirm again.",
      );
    }

    const version = resolveVersion(loaded, resolved.entry.version, commit);
    installPath = getPluginCacheDir(resolved.marketplace.name, resolved.entry.name, version);

    // Copy into the version-locked cache via a pending dir, validate the copy,
    // then swap while retaining a rollback directory until every durable write
    // succeeds. This also protects same-version reinstalls.
    const pending = `${installPath}.pending-${process.pid}-${Date.now()}`;
    const rollback = `${installPath}.rollback-${process.pid}-${Date.now()}`;
    await copyTree(tempDir, pending);
    const pendingLoaded = await loadPlugin({ root: pending, ...loadOpts });
    if (pendingLoaded.errors.length > 0) {
      throw new Error(
        `plugin validation failed: ${pendingLoaded.errors.map((e) => e.message).join("; ")}`,
      );
    }

    await fs.mkdir(path.dirname(installPath), { recursive: true });
    const prior = (await readInstalledPlugins()).plugins[pluginId];
    const targetExists = await fs.stat(installPath).then(() => true).catch(() => false);
    if (targetExists) await fs.rename(installPath, rollback);

    let swapped = false;
    let recordCommitted = false;
    try {
      await fs.rename(pending, installPath);
      swapped = true;

      // Re-load from the final path so the record + snapshot reflect real paths.
      const finalLoaded = await loadPlugin({ root: installPath, ...loadOpts });
      if (finalLoaded.errors.length > 0) {
        throw new Error(
          `plugin validation failed: ${finalLoaded.errors.map((e) => e.message).join("; ")}`,
        );
      }
      await ensurePrivateDirectory(getPluginDataDir(pluginId));

      const now = new Date().toISOString();
      const installations = upsertInstallationScope(
        prior?.installations ?? legacyInstallations(prior),
        scope,
        cwd,
        now,
      );
      const record: InstalledPluginRecord = {
        pluginId,
        name: resolved.entry.name,
        marketplace: resolved.marketplace.name,
        version,
        ...(commit ? { commit } : {}),
        installPath,
        installedAt: prior?.installedAt ?? now,
        updatedAt: now,
        installations,
        ...(strict ? {} : { strict: false }),
        ...(Object.keys(componentPaths).length > 0 ? { componentPaths } : {}),
      };
      await updateInstalledPlugins((draft) => upsertInstalledPlugin(draft, record));
      recordCommitted = true;
      await setPluginEnabled(cwd, pluginId, true, scope);

      // The old cache remains last-known-good through the state/enable commit.
      // A different-version prior path is retired only after the new record is
      // live; the same-version backup is likewise removed now.
      await safeRemovePluginCacheDir(rollback);
      if (prior && prior.installPath !== installPath) {
        await safeRemovePluginCacheDir(prior.installPath);
      }

      return { record, loaded: finalLoaded, requiresTrust: finalLoaded.hasExecutableComponents };
    } catch (error) {
      if (recordCommitted) {
        await updateInstalledPlugins((draft) => {
          if (prior) upsertInstalledPlugin(draft, prior);
          else removeInstalledPlugin(draft, pluginId);
        }).catch(() => {});
      }
      if (swapped) await safeRemovePluginCacheDir(installPath);
      const rollbackExists = await fs.stat(rollback).then(() => true).catch(() => false);
      if (rollbackExists) await fs.rename(rollback, installPath);
      throw error;
    }
  } catch (error) {
    throw error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Update = reinstall from the marketplace (which may resolve a newer version). */
export async function updatePlugin(
  pluginId: string,
  scope: PluginScope = "user",
  cwd: string = process.cwd(),
  options: InstallOptions = {},
): Promise<InstallResult> {
  const installed = (await readInstalledPlugins()).plugins[pluginId];
  if (!installed) throw new Error(`plugin not installed: ${pluginId}`);
  return installPlugin(pluginId, scope, cwd, options);
}

export interface UninstallOptions {
  /** Keep the `~/.easy-agent/plugins/data/<id>` dir (default: delete it). */
  keepData?: boolean;
  scope?: PluginScope;
  cwd?: string;
}

/**
 * Uninstall a plugin: drop the install record, disable it in the scope, and
 * delete ONLY the managed cache version dir. Never deletes user-owned dirs.
 */
export async function uninstallPlugin(
  pluginId: string,
  opts: UninstallOptions = {},
): Promise<void> {
  return withPluginOperationLock(() => uninstallPluginUnlocked(pluginId, opts));
}

async function uninstallPluginUnlocked(
  pluginId: string,
  opts: UninstallOptions,
): Promise<void> {
  const installed = (await readInstalledPlugins()).plugins[pluginId];
  if (!installed) throw new Error(`plugin not installed: ${pluginId}`);

  const cwd = opts.cwd ?? process.cwd();
  const scope = opts.scope ?? "user";
  const installations = installed.installations ?? legacyInstallations(installed);
  const remaining = removeInstallationScope(installations, scope, cwd);

  if (remaining.length === 0) {
    const expectedInstallPath = getPluginCacheDir(
      installed.marketplace,
      installed.name,
      installed.version,
    );
    if (path.resolve(installed.installPath) !== path.resolve(expectedInstallPath)) {
      throw new Error(
        `refusing to uninstall: installation record points outside its version slot (${installed.installPath})`,
      );
    }
  }

  // Make the durable state stop referencing the cache before deleting it. A
  // crash between these operations leaves only an orphan directory, never a
  // record that points at missing executable code.
  await setPluginEnabled(cwd, pluginId, null, scope);
  if (remaining.length > 0) {
    await updateInstalledPlugins((draft) =>
      upsertInstalledPlugin(draft, { ...installed, installations: remaining, updatedAt: new Date().toISOString() }),
    );
    return;
  }

  await updateInstalledPlugins((draft) => removeInstalledPlugin(draft, pluginId));
  await safeRemovePluginCacheDir(installed.installPath);

  if (!opts.keepData) {
    await safeRemovePluginDataDir(getPluginDataDir(pluginId));
  }
}

function scopeProjectPath(scope: PluginScope, cwd: string): string | undefined {
  return scope === "user" ? undefined : path.resolve(cwd);
}

function installationKey(scope: PluginScope, cwd: string): string {
  return `${scope}:${scopeProjectPath(scope, cwd) ?? ""}`;
}

function legacyInstallations(
  record: InstalledPluginRecord | undefined,
): NonNullable<InstalledPluginRecord["installations"]> {
  if (!record) return [];
  const legacy = record as InstalledPluginRecord & {
    scope?: PluginScope;
    projectPath?: string;
  };
  const scope: PluginScope =
    legacy.scope === "project" || legacy.scope === "local" ? legacy.scope : "user";
  return [{
    scope,
    ...(scope !== "user" && legacy.projectPath
      ? { projectPath: path.resolve(legacy.projectPath) }
      : {}),
    installedAt: record.installedAt,
  }];
}

function upsertInstallationScope(
  current: NonNullable<InstalledPluginRecord["installations"]>,
  scope: PluginScope,
  cwd: string,
  now: string,
): NonNullable<InstalledPluginRecord["installations"]> {
  const key = installationKey(scope, cwd);
  const existing = current.find((entry) =>
    installationKey(entry.scope, entry.projectPath ?? cwd) === key,
  );
  const next = current.filter((entry) =>
    installationKey(entry.scope, entry.projectPath ?? cwd) !== key,
  );
  next.push({
    scope,
    ...(scopeProjectPath(scope, cwd) ? { projectPath: scopeProjectPath(scope, cwd) } : {}),
    installedAt: existing?.installedAt ?? now,
  });
  return next;
}

function removeInstallationScope(
  current: NonNullable<InstalledPluginRecord["installations"]>,
  scope: PluginScope,
  cwd: string,
): NonNullable<InstalledPluginRecord["installations"]> {
  const key = installationKey(scope, cwd);
  return current.filter((entry) =>
    installationKey(entry.scope, entry.projectPath ?? cwd) !== key,
  );
}

/** Backward-compatible predicate: only versioned cache paths are managed plugin paths. */
export function isManagedPluginPath(p: string): boolean {
  return isPathInside(p, getPluginCacheRoot());
}

function isPathInside(candidate: string, rootDir: string): boolean {
  const root = path.resolve(rootDir);
  const target = path.resolve(candidate);
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function safeRemoveInside(dir: string, rootDir: string): Promise<void> {
  if (!isPathInside(dir, rootDir)) {
    throw new Error(`refusing to delete path outside managed root: ${dir}`);
  }
  await fs.rm(dir, { recursive: true, force: true });
}

/** Remove only versioned cache content, never marketplaces/data/the plugin root. */
async function safeRemovePluginCacheDir(dir: string): Promise<void> {
  if (!isPathInside(dir, getPluginCacheRoot())) return;
  const segments = path
    .relative(path.resolve(getPluginCacheRoot()), path.resolve(dir))
    .split(path.sep)
    .filter(Boolean);
  // Cache layout is <marketplace>/<plugin>/<version>. Never accept a state
  // record that points at a marketplace or plugin parent directory.
  if (segments.length < 3) {
    throw new Error(`refusing to delete broad plugin cache path: ${dir}`);
  }
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** Remove only the selected plugin's persistent data directory. */
async function safeRemovePluginDataDir(dir: string): Promise<void> {
  if (!isPathInside(dir, getPluginDataRoot())) return;
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** True when `p` is somewhere below the overall plugin root (diagnostics only). */
export function isInsidePluginsRoot(p: string): boolean {
  const root = path.resolve(getPluginsRoot());
  const rel = path.relative(root, path.resolve(p));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
