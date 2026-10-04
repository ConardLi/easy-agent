import type { CommandSuggestion } from "./types.js";

interface PaletteEntry {
  token: string;
  description: string;
  /** Complete the input and keep the palette workflow open instead of running. */
  completionOnly?: boolean;
}

const PLUGIN_ACTIONS: PaletteEntry[] = [
  { token: "install", description: "Install a plugin from a marketplace", completionOnly: true },
  { token: "list", description: "List installed plugins and enable state" },
  { token: "marketplace", description: "Manage marketplace sources", completionOnly: true },
  { token: "enable", description: "Enable an installed plugin", completionOnly: true },
  { token: "disable", description: "Disable an installed plugin", completionOnly: true },
  { token: "update", description: "Update an installed plugin", completionOnly: true },
  { token: "uninstall", description: "Uninstall a plugin", completionOnly: true },
  { token: "validate", description: "Validate a plugin or marketplace directory", completionOnly: true },
  { token: "reload", description: "Reload plugins and extension registries" },
];

const MARKETPLACE_ACTIONS: PaletteEntry[] = [
  { token: "add", description: "Add a local directory or Git marketplace", completionOnly: true },
  { token: "list", description: "List registered marketplaces" },
  { token: "update", description: "Update one marketplace, or all when omitted", completionOnly: true },
  { token: "remove", description: "Remove a registered marketplace", completionOnly: true },
];

function suggestionsFor(commandPrefix: string, entries: PaletteEntry[], partial: string): CommandSuggestion[] {
  const query = partial.toLowerCase();
  return entries
    .filter((entry) => entry.token.startsWith(query))
    .map((entry) => ({
      name: `${commandPrefix} ${entry.token}`,
      description: entry.description,
      tag: "plugin",
      completionOnly: entry.completionOnly,
    }));
}

/**
 * Return hierarchical slash-command suggestions, or `null` when the ordinary
 * top-level palette should handle the input.
 *
 * Keeping this parser independent from React makes the `/plugin` grammar easy
 * to extend and prevents the old "any whitespace closes suggestions" rule
 * from swallowing nested command help.
 */
export function getNestedCommandSuggestions(input: string): CommandSuggestion[] | null {
  if (!input.startsWith("/")) return null;

  const trailingSpace = /\s$/.test(input);
  const trimmed = input.trim();
  const tokens = trimmed.split(/\s+/);
  const root = (tokens[0] ?? "").toLowerCase();

  if (root === "/marketplace") {
    if (tokens.length === 1) {
      return trailingSpace ? suggestionsFor("/marketplace", MARKETPLACE_ACTIONS, "") : null;
    }
    if (tokens.length === 2 && !trailingSpace) {
      return suggestionsFor("/marketplace", MARKETPLACE_ACTIONS, tokens[1] ?? "");
    }
    return [];
  }

  if (root !== "/plugin" && root !== "/plugins") return null;
  const prefix = root === "/plugins" ? "/plugins" : "/plugin";

  if (tokens.length === 1) {
    return trailingSpace ? suggestionsFor(prefix, PLUGIN_ACTIONS, "") : null;
  }

  if (tokens.length === 2 && !trailingSpace) {
    return suggestionsFor(prefix, PLUGIN_ACTIONS, tokens[1] ?? "");
  }

  const action = (tokens[1] ?? "").toLowerCase();
  if (action === "marketplace" || action === "market") {
    const marketplacePrefix = `${prefix} ${action}`;
    if (tokens.length === 2 && trailingSpace) {
      return suggestionsFor(marketplacePrefix, MARKETPLACE_ACTIONS, "");
    }
    if (tokens.length === 3 && !trailingSpace) {
      return suggestionsFor(marketplacePrefix, MARKETPLACE_ACTIONS, tokens[2] ?? "");
    }
  }

  // The user is now entering a plugin id/path/scope flag. Do not fall back to
  // unrelated top-level commands while they fill the argument.
  return [];
}
