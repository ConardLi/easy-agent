/**
 * Unified plugin namespace + conflict rules.
 *
 * Every component a plugin contributes is addressed under the plugin's name so
 * two plugins can both ship a `review` command without colliding, and so the
 * user always knows where a `/foo:bar` came from:
 *
 *   Skill        →  plugin:skill            (/plugin:skill, Skill(skill="plugin:skill"))
 *   Command      →  plugin:command          (/plugin:command; subdirs → plugin:group:command)
 *   Agent        →  plugin:agent            (Agent(subagent_type="plugin:agent"))
 *   Output Style →  plugin:style            (/output-style plugin:style)
 *   MCP Server   →  plugin:<plugin>:<server>
 *
 * The separator is `:` — the same one user-command subdirectories already use,
 * so `/team:review` (a subdir command) and `/myplugin:review` (a plugin
 * command) parse through the exact same slash-command grammar.
 *
 * Conflict rules:
 *   - Within ONE plugin, a Skill and a Command that resolve to the same public
 *     name is a hard validation error (ambiguous `/name`).
 *   - Two DIFFERENT marketplaces whose manifest `name` collides may not be
 *     enabled at once — the namespace prefix would be ambiguous. The runtime
 *     refuses the second and reports a deterministic conflict.
 */

export const NAMESPACE_SEP = ":";

/** `plugin` + `skill` → `plugin:skill`. Idempotent if already namespaced. */
export function applyNamespace(pluginName: string, localName: string): string {
  const prefix = `${pluginName}${NAMESPACE_SEP}`;
  return localName.startsWith(prefix) ? localName : `${prefix}${localName}`;
}

/** Split `plugin:rest` → { pluginName, rest }, or null when unqualified. */
export function splitNamespace(
  qualified: string,
): { pluginName: string; rest: string } | null {
  const idx = qualified.indexOf(NAMESPACE_SEP);
  if (idx <= 0) return null;
  return { pluginName: qualified.slice(0, idx), rest: qualified.slice(idx + 1) };
}

/** True when `name` carries a plugin namespace prefix (`plugin:...`). */
export function isNamespaced(name: string): boolean {
  return name.includes(NAMESPACE_SEP);
}

/**
 * The MCP tool/server namespace is doubly-qualified: `plugin:<plugin>:<server>`
 * for the human-facing server id. (The final MCP TOOL names still flow through
 * the existing `mcp__<server>__<tool>` normalizer downstream.)
 */
export function mcpServerNamespace(pluginName: string, serverName: string): string {
  return `plugin${NAMESPACE_SEP}${pluginName}${NAMESPACE_SEP}${serverName}`;
}
