/**
 * `/plugin` command family.
 *
 *   /plugin                                — interactive manager overlay
 *   /plugin list [--available]             — installed plugins + enable state
 *   /plugin validate <plugin-or-marketplace-path>
 *   /plugin marketplace add <path|url> [--ref <r>]
 *   /plugin marketplace list
 *   /plugin marketplace update <name>
 *   /plugin marketplace remove <name>
 *   /plugin install <name[@marketplace]> [--scope user|project|local]
 *   /plugin enable  <id> [--scope user|project|local]
 *   /plugin disable <id> [--scope user|project|local]
 *   /plugin update  <id> [--scope user|project|local]
 *   /plugin uninstall <id> [--scope user|project|local] [--keep-data]
 *
 * Output is rendered as system notices, never sent to the model. Every
 * mutating subcommand reconciles the live registries via
 * `refreshActivePlugins()` so a plugin's skills/agents/commands/hooks/MCP
 * become available (or disappear) without restarting the CLI.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PluginViewData, QueryEngineEvent } from "../types.js";
import type { CommandContext } from "./context.js";
import { buildPluginView } from "./pluginView.js";
import {
  addMarketplace,
  installPlugin,
  inspectPlugin,
  listMarketplaces,
  readInstalledPlugins,
  refreshActivePlugins,
  removeMarketplace,
  setPluginEnabled,
  getEnabledPluginState,
  uninstallPlugin,
  updateMarketplace,
  updatePlugin,
  loadPlugin,
  readMarketplaceManifest,
  type MarketplaceSource,
  type PluginScope,
  type PluginInstallPreview,
} from "../../../plugins/index.js";

type Yield = AsyncGenerator<QueryEngineEvent, { handled: boolean }>;

function info(message: string): QueryEngineEvent {
  return { type: "command", kind: "info", message };
}
function error(message: string): QueryEngineEvent {
  return { type: "command", kind: "error", message };
}
function progress(title: string, message: string, spinnerLabel = title): QueryEngineEvent {
  return { type: "command_progress", title, message, spinnerLabel };
}

/**
 * Classify a marketplace source string: an explicit Git URL, the `owner/repo`
 * shorthand published install docs use, or a local directory.
 *
 * `owner/repo` is also a valid relative path, so an existing local directory
 * always wins — only a non-existent path falls through to the GitHub shorthand.
 */
async function marketplaceSourceFor(
  target: string,
  cwd: string,
  ref?: string,
): Promise<MarketplaceSource> {
  if (/^[a-z]+:\/\//i.test(target) || /^git@/.test(target)) {
    return { kind: "git", url: target, ...(ref ? { ref } : {}) };
  }
  const local = path.resolve(cwd, target);
  const existsLocally = await fs.stat(local).then(() => true).catch(() => false);
  if (!existsLocally && /^[\w.-]+\/[\w.-]+$/.test(target)) {
    return { kind: "git", url: `https://github.com/${target}.git`, ...(ref ? { ref } : {}) };
  }
  return { kind: "local", path: local };
}

/** Parse scope flags (`--scope project` or legacy `--project`) → scope. */
function scopeFromFlags(args: string[]): { scope: PluginScope; rest: string[] } {
  let scope: PluginScope = "user";
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "--project") scope = "project";
    else if (a === "--local") scope = "local";
    else if (a === "--user") scope = "user";
    else if (a === "--scope") {
      const value = args[i + 1];
      if (value !== "user" && value !== "project" && value !== "local") {
        throw new Error("--scope must be one of: user, project, local");
      }
      scope = value;
      i += 1;
    }
    else rest.push(a);
  }
  return { scope, rest };
}

export async function* handlePluginCommand(
  ctx: CommandContext,
  args: string[],
): Yield {
  const [sub, ...rest] = args;

  try {
    switch (sub) {
      case undefined:
        // Bare `/plugin` opens the interactive manager. The text subcommands below stay for
        // headless / scripted use.
        yield { type: "plugin_view", data: await buildPluginView(ctx.cwd) };
        return { handled: true };
      case "list":
        return yield* listPlugins(ctx, rest);
      case "validate":
        return yield* validate(ctx, rest);
      case "marketplace":
      case "market":
        return yield* handleMarketplace(ctx, rest);
      case "install":
        return yield* install(ctx, rest);
      case "enable":
        return yield* toggle(ctx, rest, true);
      case "disable":
        return yield* toggle(ctx, rest, false);
      case "update":
        return yield* update(ctx, rest);
      case "reload":
        return yield* reload(ctx);
      case "uninstall":
      case "remove":
        return yield* uninstall(ctx, rest);
      default:
        yield error(
          `Unknown /plugin subcommand: ${sub}. Try /plugin, /plugin list [--available], ` +
            `/plugin install <id>, /plugin validate <path>, ` +
            `/plugin marketplace add <path|url>, /plugin enable|disable <id>, ` +
            `/plugin update <id>, /plugin uninstall <id>, /plugin reload.`,
        );
        return { handled: true };
    }
  } catch (err) {
    yield error(`/plugin ${sub ?? ""} failed: ${(err as Error).message}`);
    return { handled: true };
  }
}

async function* reload(ctx: CommandContext): Yield {
  yield progress("Reloading plugins", "Rebuilding extension registries and MCP connections…");
  const result = await refreshActivePlugins(ctx.cwd);
  const summary = result.summary;
  const lines = [
    `Plugins reloaded: ${summary.enabledPlugins} enabled, ${summary.disabledPlugins} disabled.`,
    `  Skills ${summary.skills} · Commands ${summary.commands} · Agents ${summary.agents} · ` +
      `Styles ${summary.outputStyles} · Hooks ${summary.hooks} · MCP ${summary.mcpServers} · LSP ${summary.lspServers} · ` +
      `Errors ${summary.errors}`,
  ];
  if (result.mcpStarted.length > 0) lines.push(`  MCP started: ${result.mcpStarted.join(", ")}`);
  if (result.mcpStopped.length > 0) lines.push(`  MCP stopped: ${result.mcpStopped.join(", ")}`);
  if (summary.errors > 0) {
    lines.push(`  ${summary.errors} issue(s) detected; run /doctor for details.`);
  }
  yield summary.errors > 0 ? error(lines.join("\n")) : info(lines.join("\n"));
  return { handled: true };
}

/** One action the interactive manager can trigger. */
export type PluginMutation =
  | { op: "enable"; pluginId: string; scope: PluginScope }
  | { op: "disable"; pluginId: string; scope: PluginScope }
  | {
      op: "install";
      pluginId: string;
      scope: PluginScope;
      confirmedExecutableComponents: true;
      expectedFingerprint: string;
    }
  | {
      op: "update";
      pluginId: string;
      scope: PluginScope;
      confirmedExecutableComponents: true;
      expectedFingerprint: string;
    }
  | { op: "uninstall"; pluginId: string; scope: PluginScope }
  | { op: "marketplace-add"; source: string }
  | { op: "marketplace-update"; name: string }
  | { op: "marketplace-remove"; name: string }
  | { op: "reload" };

/**
 * Apply one manager action, then reconcile the live registries so the change is
 * visible immediately. Returns the rebuilt view; errors propagate to the caller
 * so the overlay can surface them without closing.
 */
export async function mutatePlugin(
  ctx: CommandContext,
  action: PluginMutation,
): Promise<PluginViewData> {
  switch (action.op) {
    case "enable":
    case "disable":
      await setPluginEnabled(ctx.cwd, action.pluginId, action.op === "enable", action.scope);
      break;
    case "install":
      await installPlugin(action.pluginId, action.scope, ctx.cwd, {
        allowExecutableComponents: action.confirmedExecutableComponents,
        expectedFingerprint: action.expectedFingerprint,
      });
      break;
    case "update":
      await updatePlugin(action.pluginId, action.scope, ctx.cwd, {
        allowExecutableComponents: action.confirmedExecutableComponents,
        expectedFingerprint: action.expectedFingerprint,
      });
      break;
    case "uninstall":
      await uninstallPlugin(action.pluginId, { scope: action.scope, cwd: ctx.cwd });
      break;
    case "marketplace-add":
      await addMarketplace(await marketplaceSourceFor(action.source, ctx.cwd));
      break;
    case "marketplace-update":
      await updateMarketplace(action.name);
      break;
    case "marketplace-remove":
      await removeMarketplace(action.name);
      break;
    case "reload":
      break;
  }
  await refreshActivePlugins(ctx.cwd);
  return buildPluginView(ctx.cwd);
}

/** Read-only preflight used by the manager before install/update confirmation. */
export async function previewPlugin(pluginId: string): Promise<PluginInstallPreview> {
  return inspectPlugin(pluginId);
}

async function* listPlugins(ctx: CommandContext, args: string[] = []): Yield {
  // `--available` lists what the registered catalogs offer but isn't installed.
  if (args.includes("--available")) {
    const view = await buildPluginView(ctx.cwd);
    if (view.marketplaces.length === 0) {
      yield info("No marketplaces registered.\n\nAdd one: /plugin marketplace add <path-or-git-url>");
      return { handled: true };
    }
    if (view.available.length === 0) {
      yield info("Available plugins (0)\n\nEvery catalogued plugin is already installed.");
      return { handled: true };
    }
    const lines = [`Available plugins (${view.available.length})`, ""];
    for (const p of view.available) {
      const desc = p.description ? `  ${p.description}` : "";
      lines.push(`  ${p.pluginId}${p.version ? `  v${p.version}` : ""}${desc}`);
    }
    lines.push("", "Install: /plugin install <name>@<marketplace>");
    yield info(lines.join("\n"));
    return { handled: true };
  }

  const installed = Object.values((await readInstalledPlugins()).plugins);
  const { enabled, bySource } = await getEnabledPluginState(ctx.cwd);
  if (installed.length === 0) {
    yield info(
      "Plugins (0 installed)\n\n" +
        "Add a marketplace then install:\n" +
        "  /plugin marketplace add <path-or-git-url>\n" +
        "  /plugin install <name>@<marketplace>",
    );
    return { handled: true };
  }
  const lines = [`Plugins (${installed.length} installed)`, ""];
  for (const p of installed) {
    const on = enabled.has(p.pluginId);
    const scope = bySource.get(p.pluginId);
    const state = on ? `enabled${scope ? ` (${scope})` : ""}` : "disabled";
    lines.push(`  ${on ? "✓" : "-"} ${p.pluginId}  v${p.version}  ${state}`);
  }
  lines.push("", "Subcommands: install | enable | disable | update | uninstall | marketplace");
  yield info(lines.join("\n"));
  return { handled: true };
}

async function* handleMarketplace(ctx: CommandContext, args: string[]): Yield {
  const [action, ...rest] = args;
  switch (action) {
    case undefined:
    case "list": {
      const all = await listMarketplaces();
      if (all.length === 0) {
        yield info("Marketplaces (0)\n\nAdd one: /plugin marketplace add <path-or-git-url>");
        return { handled: true };
      }
      const lines = [`Marketplaces (${all.length})`, ""];
      for (const m of all) {
        const src = m.source.kind === "git" ? `git ${m.source.url}` : `local ${m.source.path}`;
        lines.push(`  ${m.name}  [${src}]`);
      }
      yield info(lines.join("\n"));
      return { handled: true };
    }
    case "add": {
      const refIdx = rest.indexOf("--ref");
      const ref = refIdx >= 0 ? rest[refIdx + 1] : undefined;
      const target = rest.find((a, i) => !a.startsWith("--") && (refIdx < 0 || i !== refIdx + 1));
      if (!target) {
        yield error("Usage: /plugin marketplace add <local-path|git-url> [--ref <ref>]");
        return { handled: true };
      }
      yield progress(
        "Adding marketplace",
        `${target}\nValidating the catalog and saving its source…`,
      );
      const entry = await addMarketplace(await marketplaceSourceFor(target, ctx.cwd, ref));
      yield info(`Marketplace added: ${entry.name} (${entry.source.kind}).`);
      return { handled: true };
    }
    case "update": {
      if (!rest[0]) {
        const all = await listMarketplaces();
        if (all.length === 0) {
          yield info("No marketplaces registered.");
          return { handled: true };
        }
        yield progress(
          "Updating marketplaces",
          `Fetching and validating ${all.length} registered marketplace(s)…`,
        );
        const updated = [];
        for (const marketplace of all) {
          updated.push(await updateMarketplace(marketplace.name));
        }
        await refreshActivePlugins(ctx.cwd);
        yield info(`Updated ${updated.length} marketplace(s): ${updated.map((entry) => entry.name).join(", ")}.`);
        return { handled: true };
      }
      yield progress(
        "Updating marketplace",
        `${rest[0]}\nFetching and validating the latest catalog…`,
      );
      const entry = await updateMarketplace(rest[0]);
      await refreshActivePlugins(ctx.cwd);
      yield info(`Marketplace updated: ${entry.name} (${entry.lastUpdated}).`);
      return { handled: true };
    }
    case "remove": {
      if (!rest[0]) {
        yield error("Usage: /plugin marketplace remove <name>");
        return { handled: true };
      }
      yield progress("Removing marketplace", `${rest[0]}\nUpdating the marketplace registry…`);
      await removeMarketplace(rest[0]);
      yield info(`Marketplace removed: ${rest[0]}.`);
      return { handled: true };
    }
    default:
      yield error(`Unknown /plugin marketplace subcommand: ${action}.`);
      return { handled: true };
  }
}

/**
 * `/plugin validate <path>` — strict-check a plugin or
 * marketplace directory WITHOUT installing it, so an author sees schema and
 * path mistakes (typos, escaping paths, bad frontmatter) before publishing.
 */
async function* validate(ctx: CommandContext, args: string[]): Yield {
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) {
    yield error("Usage: /plugin validate <plugin-or-marketplace-path>");
    return { handled: true };
  }
  const root = path.resolve(ctx.cwd, target);

  // A marketplace manifest and a plugin manifest live side by side in the same
  // conventional dir, so try the catalog shape first and fall back to plugin.
  try {
    const { manifest } = await readMarketplaceManifest(root);
    const lines = [
      `Marketplace OK: ${manifest.name}`,
      `  ${manifest.plugins.length} plugin entr(ies)`,
    ];
    for (const entry of manifest.plugins) {
      lines.push(`    - ${entry.name}  ${entry.source}${entry.strict === false ? "  (strict:false)" : ""}`);
    }
    yield info(lines.join("\n"));
    return { handled: true };
  } catch {
    // Not a marketplace — validate it as a plugin below.
  }

  const loaded = await loadPlugin({
    root,
    pluginId: `${path.basename(root)}@local`,
    strict: true,
  });
  const parts = [
    `${loaded.skills.length} skill(s)`,
    `${loaded.agents.length} agent(s)`,
    `${loaded.commands.length} command(s)`,
    `${loaded.outputStyles.length} style(s)`,
    `${loaded.hooks.length} hook(s)`,
    `${loaded.mcpServers.length} mcp server(s)`,
    `${loaded.lspServers?.length ?? 0} lsp server(s)`,
  ];
  const lines = [
    loaded.errors.length === 0
      ? `Plugin OK: ${loaded.name} v${loaded.version}`
      : `Plugin INVALID: ${loaded.name}`,
    `  components: ${parts.join(", ")}`,
  ];
  for (const e of loaded.errors) lines.push(`  error [${e.scope}] ${e.message}`);
  for (const w of loaded.warnings) lines.push(`  warn  ${w}`);
  yield loaded.errors.length === 0 ? info(lines.join("\n")) : error(lines.join("\n"));
  return { handled: true };
}

async function* install(ctx: CommandContext, args: string[]): Yield {
  const { scope, rest } = scopeFromFlags(args);
  const ref = rest[0];
  if (!ref) {
    yield error("Usage: /plugin install <name[@marketplace]> [--scope user|project|local]");
    return { handled: true };
  }
  yield progress("Installing plugin", `${ref}\nResolving, validating, and preparing the plugin…`);
  const result = await installPlugin(ref, scope, ctx.cwd);
  await refreshActivePlugins(ctx.cwd);
  const l = result.loaded;
  const parts = [
    `${l.skills.length} skill(s)`,
    `${l.agents.length} agent(s)`,
    `${l.commands.length} command(s)`,
    `${l.outputStyles.length} style(s)`,
    `${l.hooks.length} hook(s)`,
    `${l.mcpServers.length} mcp server(s)`,
    `${l.lspServers?.length ?? 0} lsp server(s)`,
  ];
  const lines = [
    `Installed ${result.record.pluginId} v${result.record.version} (${scope}).`,
    `  components: ${parts.join(", ")}`,
  ];
  if (result.requiresTrust) {
    lines.push(
      "  note: this plugin ships hooks/MCP/LSP servers. They run only in trusted folders" +
        (scope === "user" ? "" : " — trust this folder to enable them here."),
    );
  }
  if (l.errors.length > 0) lines.push(`  warnings: ${l.errors.map((e) => e.message).join("; ")}`);
  yield info(lines.join("\n"));
  return { handled: true };
}

async function* toggle(ctx: CommandContext, args: string[], on: boolean): Yield {
  const { scope, rest } = scopeFromFlags(args);
  const id = rest[0];
  if (!id) {
    yield error(
      `Usage: /plugin ${on ? "enable" : "disable"} <id> [--scope user|project|local]`,
    );
    return { handled: true };
  }
  yield progress(
    on ? "Enabling plugin" : "Disabling plugin",
    `${id} (${scope})\nRebuilding extension registries…`,
  );
  await setPluginEnabled(ctx.cwd, id, on, scope);
  const summary = await refreshActivePlugins(ctx.cwd);
  const churn = [
    ...summary.mcpStarted.map((n) => `+mcp ${n}`),
    ...summary.mcpStopped.map((n) => `-mcp ${n}`),
  ];
  yield info(
    `${on ? "Enabled" : "Disabled"} ${id} (${scope}).` +
      (churn.length ? `\n  ${churn.join(", ")}` : ""),
  );
  return { handled: true };
}

async function* update(ctx: CommandContext, args: string[]): Yield {
  const { scope, rest } = scopeFromFlags(args);
  if (!rest[0]) {
    yield error("Usage: /plugin update <id> [--scope user|project|local]");
    return { handled: true };
  }
  yield progress("Updating plugin", `${rest[0]}\nResolving and validating the new version…`);
  const result = await updatePlugin(rest[0], scope, ctx.cwd);
  await refreshActivePlugins(ctx.cwd);
  yield info(`Updated ${result.record.pluginId} → v${result.record.version}.`);
  return { handled: true };
}

async function* uninstall(ctx: CommandContext, args: string[]): Yield {
  const keepData = args.includes("--keep-data");
  const { scope, rest } = scopeFromFlags(args.filter((a) => a !== "--keep-data"));
  if (!rest[0]) {
    yield error(
      "Usage: /plugin uninstall <id> [--scope user|project|local] [--keep-data]",
    );
    return { handled: true };
  }
  yield progress(
    "Uninstalling plugin",
    `${rest[0]} (${scope})\nRemoving the installation and reloading extensions…`,
  );
  await uninstallPlugin(rest[0], { keepData, scope, cwd: ctx.cwd });
  await refreshActivePlugins(ctx.cwd);
  yield info(`Uninstalled ${rest[0]}${keepData ? " (data kept)" : ""}.`);
  return { handled: true };
}
