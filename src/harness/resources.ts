/** Shared resource gates. These only remove resources; trust and global settings still apply. */
import { createHash } from "node:crypto";
import { activeHarness } from "./active.js";
import type { ResolvedHarness } from "./resolve.js";
import { selectionOffReason } from "./selection.js";
import { defineRuntimeState } from "../state/runtimeScope.js";

const state = defineRuntimeState("pluginMcpOwners", () => ({ owners: new Map<string, string>() }));

/** Installed plugin ownership, kept even when an Agent leaves a plugin out. */
export function setPluginMcpOwners(owners: Iterable<readonly [string, string]>): void {
  state().owners = new Map(owners);
}

export function pluginMcpOffByAgent(name: string, resolved: ResolvedHarness = activeHarness()): string | undefined {
  return pluginOffByAgent(state().owners.get(name), resolved);
}

export function pluginOffByAgent(
  pluginId: string | undefined,
  resolved: ResolvedHarness = activeHarness(),
): string | undefined {
  return pluginId ? selectionOffReason(resolved, "plugins", pluginId) : undefined;
}

/**
 * A hook's identity follows its command, not its position in a settings array.
 * Identical commands in the same source/event/matcher are selected together.
 * Timeout changes preserve the choice; changing command or shell makes a new resource.
 */
export function hookSelectionKey(
  source: string,
  event: string,
  matcher: string | undefined,
  hook: { command: string; shell?: string; timeout?: number },
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([matcher ?? "", hook.command, hook.shell ?? "sh"]))
    .digest("hex");
  return `${source}:${event}:${digest}`;
}

export function hookOffByAgent(key: string, resolved: ResolvedHarness = activeHarness()): string | undefined {
  if (resolved.values["hooks.enabled"]?.value === false) return "Turned off by hooks.enabled.";
  return selectionOffReason(resolved, "hooks", key);
}

export function ruleOffByAgent(file: string, resolved: ResolvedHarness = activeHarness()): string | undefined {
  return selectionOffReason(resolved, "rules", file);
}
