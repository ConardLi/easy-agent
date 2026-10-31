/**
 * Which tools and MCP servers an Agent keeps, from its `include` and
 * `exclude` lists.
 *
 * A name matches a list entry exactly, or by pattern where `*` stands for any
 * run of characters (`mcp__github__*`, `Task*`). Without `include` everything
 * is kept; with it, only matching names. `exclude` is applied after
 * `include` and wins over it. An empty `include` keeps nothing.
 */

import { describeSource } from "./format.js";
import type { ResolvedHarness, ResolvedHarnessValue } from "./resolve.js";

export type HarnessSelection = "tools" | "mcpServers";

const patterns = new Map<string, RegExp>();

/** Whether `name` matches a list entry: the same name, or a pattern with `*`. */
export function selectionMatches(entry: string, name: string): boolean {
  if (!entry.includes("*")) return entry === name;
  let pattern = patterns.get(entry);
  if (!pattern) {
    pattern = new RegExp(`^${entry.split("*").map(escapeRegExp).join(".*")}$`);
    patterns.set(entry, pattern);
  }
  return pattern.test(name);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function listOf(entry: ResolvedHarnessValue | undefined): readonly string[] | undefined {
  return Array.isArray(entry?.value) ? (entry.value as string[]) : undefined;
}

/** Why the Agent leaves `name` out, or undefined when it keeps it. */
export function selectionOffReason(
  resolved: ResolvedHarness,
  kind: HarnessSelection,
  name: string,
): string | undefined {
  const exclude = resolved.values[`${kind}.exclude`];
  if (listOf(exclude)?.some((entry) => selectionMatches(entry, name))) {
    return `Left out by ${kind}.exclude (${describeSource(exclude!.source, exclude!.detail)}).`;
  }
  const include = resolved.values[`${kind}.include`];
  const kept = listOf(include);
  if (kept && !kept.some((entry) => selectionMatches(entry, name))) {
    return `Not in ${kind}.include (${describeSource(include!.source, include!.detail)}).`;
  }
  return undefined;
}

/** Entries of the Agent's `include` and `exclude` lists that match none of `names`. */
export function unmatchedSelectionEntries(
  resolved: ResolvedHarness,
  kind: HarnessSelection,
  names: readonly string[],
): string[] {
  const entries = [
    ...(listOf(resolved.values[`${kind}.include`]) ?? []),
    ...(listOf(resolved.values[`${kind}.exclude`]) ?? []),
  ];
  return [...new Set(entries)].filter((entry) => !names.some((name) => selectionMatches(entry, name)));
}
