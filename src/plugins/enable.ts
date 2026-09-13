/**
 * Enabled-plugin state (plan §35.4 — the third layer).
 *
 * INSTALL is global (a version lands in `~/.easy-agent/plugins/cache`), but
 * ENABLE is per-scope: a plugin can be on for your user account, on only in
 * one project, or on just for your local (gitignored) overrides. That maps
 * exactly onto Easy Agent's existing settings source chain, so we store the
 * enabled set as an `enabledPlugins` object inside settings.json:
 *
 *   { "enabledPlugins": { "review@team-tools": true, "old@x": false } }
 *
 * Effective state = merge across sources (user → project → local → flag →
 * policy), later source wins per key. An explicit `false` in a higher-priority
 * scope therefore turns OFF something a lower scope turned on — the same
 * last-write-wins rule every scalar setting uses.
 *
 * Project and local enablement only contributes to effective state after the
 * workspace is trusted. Scope-specific mutations still edit the requested
 * settings file so the saved intent becomes active once trust is established.
 */

import { loadSettingSources, loadTrustedSettingSources } from "../config/sources.js";
import {
  updateLocalSettings,
  updateProjectSettings,
  updateUserSettings,
} from "../utils/settings.js";
import type { PluginScope } from "./schemas.js";

/** The settings key we read/write. */
export const ENABLED_PLUGINS_KEY = "enabledPlugins";

function asEnabledMap(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "boolean") out[key] = value;
  }
  return out;
}

/**
 * Merge `enabledPlugins` across effective trusted sources and return the ids
 * whose effective value is `true`, plus the deciding source for diagnostics.
 */
export async function getEnabledPluginState(
  cwd: string,
): Promise<{ enabled: Set<string>; bySource: Map<string, string> }> {
  const sources = await loadTrustedSettingSources(cwd);
  const merged: Record<string, boolean> = {};
  const bySource = new Map<string, string>();
  for (const src of sources) {
    const map = asEnabledMap(src.raw?.[ENABLED_PLUGINS_KEY]);
    for (const [id, value] of Object.entries(map)) {
      merged[id] = value;
      bySource.set(id, src.source);
    }
  }
  const enabled = new Set<string>();
  for (const [id, value] of Object.entries(merged)) {
    if (value) enabled.add(id);
  }
  return { enabled, bySource };
}

/** Convenience: just the enabled id set. */
export async function getEnabledPluginIds(cwd: string): Promise<Set<string>> {
  return (await getEnabledPluginState(cwd)).enabled;
}

/**
 * Turn a plugin on/off in a specific scope. Reads the current `enabledPlugins`
 * map for that scope, flips the one key, and writes it back through the
 * existing shallow-merge settings writers (which bust the settings cache so the
 * next read sees it). `null` removes the key entirely (revert to inherited).
 */
export async function setPluginEnabled(
  cwd: string,
  pluginId: string,
  enabled: boolean | null,
  scope: PluginScope,
): Promise<void> {
  const sources = await loadSettingSources(cwd);
  const current = asEnabledMap(sources.find((s) => s.source === scope)?.raw?.[ENABLED_PLUGINS_KEY]);
  const next = { ...current };
  if (enabled === null) delete next[pluginId];
  else next[pluginId] = enabled;

  const patch = { [ENABLED_PLUGINS_KEY]: next };
  if (scope === "user") await updateUserSettings(patch);
  else if (scope === "project") await updateProjectSettings(cwd, patch);
  else await updateLocalSettings(cwd, patch);
}
