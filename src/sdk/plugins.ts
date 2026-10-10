/**
 * Plugin and marketplace management without a session, for clients that
 * manage a workspace's plugins outside any conversation. These are the same
 * operations the terminal's `/plugin` manager runs. Installs and updates need
 * the fingerprint of a preview the user confirmed. In an untrusted workspace
 * the project and local scopes are refused, since those settings would not
 * apply; user-scope plugins run there with their hooks and servers, as in the
 * terminal.
 */

import { isProjectTrusted } from "../config/globalState.js";
import { mutatePlugin as applyPluginMutation, type PluginMutation } from "../core/queryEngine/commands/plugin.js";
import { buildPluginView } from "../core/queryEngine/commands/pluginView.js";
import type { PluginViewData } from "../core/queryEngine/types.js";
import { refreshHookDisableFromSettings } from "../hooks/settings.js";
import { inspectPlugin, type PluginInstallPreview } from "../plugins/install.js";
import { AgentSdkError } from "./errors.js";

async function asPluginError<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AgentSdkError) throw error;
    throw new AgentSdkError("plugin", error instanceof Error ? error.message : String(error), { cause: error });
  }
}

/** Installed plugins, what the registered marketplaces offer, the marketplaces, and load errors. */
export function listPlugins(cwd: string): Promise<PluginViewData> {
  return asPluginError(() => buildPluginView(cwd));
}

/** Fetch and validate a plugin without installing it; the fingerprint confirms this exact content later. */
export function previewPlugin(pluginId: string): Promise<PluginInstallPreview> {
  return asPluginError(() => inspectPlugin(pluginId));
}

/**
 * Apply one plugin or marketplace change, reload the extension registries,
 * and return the new view. Open sessions use the change from their next turn.
 */
export function mutatePlugins(cwd: string, action: PluginMutation): Promise<PluginViewData> {
  return asPluginError(async () => {
    // An untrusted workspace ignores project and local settings, so turning a plugin on or off there would not apply.
    const ignoredScope = "scope" in action && action.scope !== "user" && action.op !== "uninstall";
    if (ignoredScope && !(await isProjectTrusted(cwd))) {
      throw new AgentSdkError(
        "untrusted",
        `The workspace is not trusted, so ${action.scope} settings do not apply. Trust it first, or use the user scope.`,
      );
    }
    const view = await applyPluginMutation(cwd, action);
    await refreshHookDisableFromSettings(cwd);
    return view;
  });
}
