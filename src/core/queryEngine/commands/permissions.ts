/**
 * Permission-rule command group — `/permissions` (alias `/allowed-tools`).
 *
 * Extracted verbatim from queryEngine.ts; behavior is unchanged. This module
 * also backs the two public engine methods the UI calls directly:
 *   - `buildPermissionsView`   ← QueryEngine.getPermissionsView()
 *   - `mutatePermissionRule`   ← QueryEngine.mutatePermissionRule()
 * Those stay as thin wrappers on the engine so the UI's call sites and the
 * method signatures are untouched.
 */

import {
  loadPermissionSettings,
} from "../../../permissions/permissions.js";
import {
  updateUserSettings,
  updateProjectSettings,
  updateLocalSettings,
} from "../../../utils/settings.js";
import { loadSettingSources, type SettingSource } from "../../../config/sources.js";
import type { QueryEngineEvent, PermissionsViewData, PermissionRuleRow } from "../types.js";
import type { CommandContext } from "./context.js";

/** Read one settings layer's allow/deny array (strings only). */
export function readScopeRules(
  sources: { source: SettingSource; raw: Record<string, unknown> | null }[],
  scope: SettingSource,
  key: "allow" | "deny",
): string[] {
  const arr = sources.find((s) => s.source === scope)?.raw?.[key];
  return Array.isArray(arr)
    ? arr.filter((x): x is string => typeof x === "string")
    : [];
}

/**
 * Build the structured allow/deny rule list for the `/permissions` overlay:
 * every persisted rule tagged with its source layer (user/project/local),
 * plus the in-memory session rules, plus the active mode.
 */
export async function buildPermissionsView(ctx: CommandContext): Promise<PermissionsViewData> {
  const cwd = ctx.cwd;
  const sources = await loadSettingSources(cwd);
  const settings = ctx.getPermissionSettings() ?? (await loadPermissionSettings(cwd));

  const allow: PermissionRuleRow[] = [];
  const deny: PermissionRuleRow[] = [];
  for (const scope of ["user", "project", "local"] as const) {
    for (const rule of readScopeRules(sources, scope, "allow")) allow.push({ rule, scope });
    for (const rule of readScopeRules(sources, scope, "deny")) deny.push({ rule, scope });
  }
  const session = ctx.getSessionPermissionRules();
  for (const rule of session.allow) allow.push({ rule, scope: "session" });
  for (const rule of session.deny) deny.push({ rule, scope: "session" });

  return { mode: settings.mode, allow, deny };
}

/**
 * Apply a single allow/deny rule change from the interactive `/permissions`
 * overlay, then hot-reload permission settings and return the fresh view.
 * `scope` must be a persisted layer — "session" rules aren't editable here.
 */
export async function mutatePermissionRule(
  ctx: CommandContext,
  op: "allow" | "deny" | "remove",
  rule: string,
  scope: SettingSource,
): Promise<PermissionsViewData> {
  const cwd = ctx.cwd;
  const write = async (patch: Record<string, unknown>): Promise<void> => {
    if (scope === "project") await updateProjectSettings(cwd, patch);
    else if (scope === "local") await updateLocalSettings(cwd, patch);
    else await updateUserSettings(patch);
  };

  const sources = await loadSettingSources(cwd);
  if (op === "remove") {
    await write({
      allow: readScopeRules(sources, scope, "allow").filter((r) => r !== rule),
      deny: readScopeRules(sources, scope, "deny").filter((r) => r !== rule),
    });
  } else {
    const current = readScopeRules(sources, scope, op);
    if (!current.includes(rule)) current.push(rule);
    await write({ [op]: current });
  }
  await ctx.reloadPermissionSettings();
  return buildPermissionsView(ctx);
}

/**
 * `/permissions` (alias `/allowed-tools`). A dedicated allow/deny
 * rule manager that mirrors `/config`'s layered-write model but is scoped to
 * permission rules.
 *   - (no args) | list  → every allow/deny rule grouped by source layer
 *                         (user / project / local) + the in-memory session
 *                         rules + the active mode
 *   - allow <rule>      → append to a layer's `allow` array
 *   - deny  <rule>      → append to a layer's `deny` array
 *   - remove <rule>     → drop <rule> from a layer's allow AND deny arrays
 * Scope defaults to --local (this project, gitignored) and can be overridden
 * with --user / --project / --local. Writes hot-reload permission settings so
 * the next tool call sees them — same live-apply contract as `/config set`.
 */
export async function* handlePermissionsCommand(
  ctx: CommandContext,
  args: string[],
): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
  const cwd = ctx.cwd;
  const sub = (args[0] ?? "").toLowerCase();

  // `/permissions` (no args) → interactive manager overlay. The UI owns the keyboard and mutates rules directly
  // via mutatePermissionRule(); the text subcommands below remain for headless
  // use and power-users.
  if (sub === "") {
    yield { type: "permissions_view", data: await buildPermissionsView(ctx) };
    return { handled: true };
  }

  if (sub === "list" || sub === "ls") {
    const sources = await loadSettingSources(cwd);
    const settings = ctx.getPermissionSettings() ?? (await loadPermissionSettings(cwd));
    const lines: string[] = ["Permission rules", `- Mode: ${settings.mode}`, ""];

    const layers: { scope: SettingSource; label: string }[] = [
      { scope: "user", label: "user (~/.easy-agent/settings.json)" },
      { scope: "project", label: "project (.easy-agent/settings.json)" },
      { scope: "local", label: "local (.easy-agent/settings.local.json)" },
    ];
    for (const { scope, label } of layers) {
      const allow = readScopeRules(sources, scope, "allow");
      const deny = readScopeRules(sources, scope, "deny");
      lines.push(`[${label}]`);
      if (allow.length === 0 && deny.length === 0) {
        lines.push("  (none)");
      } else {
        for (const r of allow) lines.push(`  allow  ${r}`);
        for (const r of deny) lines.push(`  deny   ${r}`);
      }
    }

    const session = ctx.getSessionPermissionRules();
    lines.push("[session (this run only, not persisted)]");
    if (session.allow.length === 0 && session.deny.length === 0) {
      lines.push("  (none)");
    } else {
      for (const r of session.allow) lines.push(`  allow  ${r}`);
      for (const r of session.deny) lines.push(`  deny   ${r}`);
    }

    lines.push(
      "",
      "Usage: /permissions allow <rule>  [--user|--project|--local]",
      "Usage: /permissions deny <rule>   [--user|--project|--local]",
      "Usage: /permissions remove <rule> [--user|--project|--local]",
      "Default scope is --local (this project, gitignored).",
      "Rule examples: Read · Bash(git status:*) · WebFetch(domain:example.com)",
    );
    yield { type: "command", kind: "info", message: lines.join("\n") };
    return { handled: true };
  }

  const isRemove = sub === "remove" || sub === "rm";
  if (sub === "allow" || sub === "deny" || isRemove) {
    let scope: SettingSource = "local";
    const positional: string[] = [];
    for (const tok of args.slice(1)) {
      if (tok === "--user") scope = "user";
      else if (tok === "--project") scope = "project";
      else if (tok === "--local") scope = "local";
      else positional.push(tok);
    }
    const rule = positional.join(" ").trim();
    if (!rule) {
      yield {
        type: "command",
        kind: "error",
        message: `Usage: /permissions ${sub} <rule> [--user|--project|--local]`,
      };
      return { handled: true };
    }

    try {
      const sources = await loadSettingSources(cwd);
      const write = async (patch: Record<string, unknown>): Promise<void> => {
        if (scope === "project") await updateProjectSettings(cwd, patch);
        else if (scope === "local") await updateLocalSettings(cwd, patch);
        else await updateUserSettings(patch);
      };

      if (isRemove) {
        const allow = readScopeRules(sources, scope, "allow").filter((r) => r !== rule);
        const deny = readScopeRules(sources, scope, "deny").filter((r) => r !== rule);
        await write({ allow, deny });
      } else {
        const key = sub === "allow" ? "allow" : "deny";
        const current = readScopeRules(sources, scope, key);
        if (!current.includes(rule)) current.push(rule);
        await write({ [key]: current });
      }
      await ctx.reloadPermissionSettings();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      yield {
        type: "command",
        kind: "error",
        message: `Failed to update permission rules: ${msg}`,
      };
      return { handled: true };
    }

    const verb = isRemove ? "Removed" : sub === "allow" ? "Allowed" : "Denied";
    yield {
      type: "command",
      kind: "info",
      message: [
        `${verb} rule`,
        `- Rule: ${rule}`,
        `- Scope: ${scope}`,
        "- Applied to this session; takes effect on the next tool call.",
      ].join("\n"),
    };
    return { handled: true };
  }

  yield {
    type: "command",
    kind: "error",
    message: `Unknown /permissions subcommand: ${sub}. Use list, allow, deny, or remove.`,
  };
  return { handled: true };
}
