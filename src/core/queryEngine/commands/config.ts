/**
 * Config command group — `/config` and `/output-style`.
 *
 * Extracted verbatim from queryEngine.ts; behavior is unchanged.
 *   - `/config [list|get|set]`  layered settings inspector/editor
 *   - `/output-style [name]`    list/switch the active output style
 */

import { loadSettingSources, type SettingSource } from "../../../config/sources.js";
import { isProjectTrusted } from "../../../config/globalState.js";
import { redactSettingValue } from "../../../config/redaction.js";
import {
  updateUserSettings,
  updateProjectSettings,
  updateLocalSettings,
} from "../../../utils/settings.js";
import {
  getActiveOutputStyleName,
  getAllOutputStyles,
  resolveOutputStyle,
  setActiveOutputStyle,
} from "../../../styles/registry.js";
import type { QueryEngineEvent } from "../types.js";
import type { CommandContext } from "./context.js";

export async function* handleConfigCommand(
  ctx: CommandContext,
  args: string[],
): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
  const ALWAYS_RESTRICTED_KEYS = new Set(["mode", "autoMode"]);
  const cwd = ctx.cwd;
  const sub = (args[0] ?? "list").toLowerCase();
  const workspaceTrusted = await isProjectTrusted(cwd);

  // Compute the effective value + provenance for a key across sources.
  const resolveKey = (
    sources: { source: SettingSource; raw: Record<string, unknown> | null }[],
    key: string,
  ): { value: unknown; from: string } | null => {
    const alwaysRestricted = ALWAYS_RESTRICTED_KEYS.has(key);
    const defs = sources.filter(
      (s) =>
        s.raw &&
        s.raw[key] !== undefined &&
        ((s.source !== "project" && s.source !== "local") ||
          (workspaceTrusted && !alwaysRestricted)),
    );
    if (defs.length === 0) return null;
    const allArrays = defs.every((s) => Array.isArray(s.raw![key]));
    if (allArrays) {
      const seen = new Set<string>();
      const merged: unknown[] = [];
      for (const s of defs) {
        for (const item of s.raw![key] as unknown[]) {
          const k = JSON.stringify(item);
          if (seen.has(k)) continue;
          seen.add(k);
          merged.push(item);
        }
      }
      return { value: merged, from: `merged(${defs.map((s) => s.source).join("+")})` };
    }
    const last = defs[defs.length - 1]!;
    return { value: last.raw![key], from: last.source };
  };

  const fmt = (key: string, value: unknown): string => {
    const safe = redactSettingValue(key, value);
    return typeof safe === "string" ? safe : JSON.stringify(safe);
  };

  if (sub === "list") {
    const sources = await loadSettingSources(cwd);
    const keys = new Set<string>();
    for (const s of sources) if (s.raw) for (const k of Object.keys(s.raw)) keys.add(k);
    const lines = ["Configuration (effective values + source)"];
    if (keys.size === 0) {
      lines.push("", "No settings configured. Use /config set <key> <value> to add one.");
    } else {
      let displayed = 0;
      for (const key of [...keys].sort()) {
        const r = resolveKey(sources, key);
        if (!r) continue;
        lines.push(`  ${key} = ${fmt(key, r.value)}   [${r.from}]`);
        displayed++;
      }
      if (displayed === 0) {
        lines.push("", "No effective settings configured for this workspace.");
      }
    }
    lines.push(
      "",
      "Usage: /config get <key>",
      "Usage: /config set <key> <value> [--user|--project|--local]",
    );
    yield { type: "command", kind: "info", message: lines.join("\n") };
    return { handled: true };
  }

  if (sub === "get") {
    const key = args[1]?.trim();
    if (!key) {
      yield { type: "command", kind: "error", message: "Usage: /config get <key>" };
      return { handled: true };
    }
    const sources = await loadSettingSources(cwd);
    const r = resolveKey(sources, key);
    if (!r) {
      yield { type: "command", kind: "info", message: `${key} is not set.` };
      return { handled: true };
    }
    yield { type: "command", kind: "info", message: `${key} = ${fmt(key, r.value)}   [${r.from}]` };
    return { handled: true };
  }

  if (sub === "set") {
    // Parse: /config set <key> <value...> [--user|--project|--local]
    const rest = args.slice(1);
    let scope: SettingSource = "user";
    const positional: string[] = [];
    for (const tok of rest) {
      if (tok === "--user") scope = "user";
      else if (tok === "--project") scope = "project";
      else if (tok === "--local") scope = "local";
      else positional.push(tok);
    }
    const key = positional.shift();
    const rawValue = positional.join(" ").trim();
    if (!key || !rawValue) {
      yield {
        type: "command",
        kind: "error",
        message: "Usage: /config set <key> <value> [--user|--project|--local]",
      };
      return { handled: true };
    }

    let value: unknown;
    try {
      value = JSON.parse(rawValue);
    } catch {
      value = rawValue;
    }

    try {
      if (scope === "project") await updateProjectSettings(cwd, { [key]: value });
      else if (scope === "local") await updateLocalSettings(cwd, { [key]: value });
      else await updateUserSettings({ [key]: value });
      // Apply live: permission rules / mode are read fresh into the engine;
      // model / outputStyle / statusLine are re-read on their next use.
      await ctx.reloadPermissionSettings();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      yield { type: "command", kind: "error", message: `Failed to write setting: ${msg}` };
      return { handled: true };
    }

    yield {
      type: "command",
      kind: "info",
      message: [
        "Setting updated",
        `- ${key} = ${fmt(key, value)}`,
        `- Scope: ${scope}`,
        "- Applied to this session; permission changes take effect on the next tool call.",
      ].join("\n"),
    };
    return { handled: true };
  }

  yield {
    type: "command",
    kind: "error",
    message: `Unknown /config subcommand: ${sub}. Use list, get, or set.`,
  };
  return { handled: true };
}

/**
 * Stage 23: `/output-style [name]`.
 *   - no arg          → list available styles + show the active one
 *   - <name>          → switch the active style and persist it as the
 *                       default (`outputStyle` in ~/.easy-agent/settings.json)
 * The switch takes effect on the NEXT turn because buildSystemPrompt reads
 * the registry fresh each request.
 */
export async function* handleOutputStyleCommand(
  args: string[],
): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
  const target = args.join(" ").trim();
  const active = getActiveOutputStyleName();

  if (!target) {
    const all = getAllOutputStyles();
    const lines = ["Output style status", `- Active: ${active}`, "", "Available styles:"];
    for (const style of all) {
      const marker = style.name === active ? "*" : " ";
      lines.push(`  ${marker} ${style.name}    ${style.description} [${style.source}]`);
    }
    lines.push(
      "",
      "Usage: /output-style <name> to switch (e.g. /output-style Explanatory)",
      "Usage: /output-style default to reset",
    );
    yield { type: "command", kind: "info", message: lines.join("\n") };
    return { handled: true };
  }

  const resolved = resolveOutputStyle(target);
  if (!resolved) {
    const names = getAllOutputStyles().map((s) => s.name).join(", ");
    yield {
      type: "command",
      kind: "error",
      message: `Output style not found: ${target}. Available: ${names}.`,
    };
    return { handled: true };
  }

  if (resolved.name === active) {
    yield {
      type: "command",
      kind: "info",
      message: `Output style is already '${resolved.name}'.`,
    };
    return { handled: true };
  }

  setActiveOutputStyle(resolved.name);
  // Persist as the default for future sessions. Best-effort: a write
  // failure (e.g. read-only home) shouldn't break the in-session switch.
  await updateUserSettings({ outputStyle: resolved.name }).catch(() => {});
  yield {
    type: "command",
    kind: "info",
    message: `Output style changed: ${active} → ${resolved.name}. Applies from the next turn.`,
  };
  return { handled: true };
}
