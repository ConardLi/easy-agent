import { SettingsSchema } from "./schema.js";
import { loadSettingSources, isTrustedScopeForSensitiveKeys } from "./sources.js";
import { isProjectTrusted } from "./globalState.js";
import { redactSettingValue } from "./redaction.js";
import { loadFeatureSettings } from "./features.js";

/** Metadata supplements (rather than duplicates) the executable schema. */
export const SETTING_RELOAD: Record<string, string> = {
  toolSearch: "next request", toolSearchAutoThreshold: "next request", modelRoles: "next invocation/request",
  hooks: "next event", disableAllHooks: "next event", models: "next request", model: "next turn",
  defaultModel: "next turn", language: "next turn", maxTurns: "next turn", checkpointingEnabled: "next checkpoint",
  respectGitignore: "next search", allow: "config command", deny: "config command", ask: "config command",
  mode: "config command", autoMode: "config command", outputStyle: "output-style command or restart",
  enabledPlugins: "plugin reload", mcpServers: "MCP reconnect", sandbox: "next shell execution",
};
const defaults: Record<string, unknown> = {
  toolSearch: "on", toolSearchAutoThreshold: 10, modelRoles: {}, mode: "default", autoMode: false,
  allow: [], deny: [], ask: [], additionalDirectories: [], disableAllHooks: false,
  checkpointingEnabled: true, respectGitignore: true, syntaxHighlightingDisabled: false,
  prefersReducedMotion: false, enableAllProjectMcpServers: false, enabledPlugins: {},
};

export async function describeConfiguration(cwd: string): Promise<string[]> {
  const all = await loadSettingSources(cwd);
  const trusted = await isProjectTrusted(cwd);
  const lines = ["Configuration (effective values + source; reload policy)"];
  const keys = new Set([...Object.keys(SettingsSchema.shape), "sandbox"]);
  for (const key of keys) {
    if (["toolSearch", "toolSearchAutoThreshold", "modelRoles"].includes(key)) continue;
    const eligible = all.filter((source) => source.raw?.[key] !== undefined &&
      (isTrustedScopeForSensitiveKeys(source.source) || (trusted && !["mode", "autoMode"].includes(key))));
    let value: unknown = defaults[key];
    let from = "default";
    for (const source of eligible) { value = source.raw![key]; from = source.source; }
    if (["allow", "deny", "ask", "additionalDirectories", "claudeMdExcludes", "enabledMcpjsonServers", "disabledMcpjsonServers"].includes(key) && eligible.length) {
      value = [...new Set(eligible.flatMap((source) => source.raw![key] as string[]))];
      from = `merged(${eligible.map((source) => source.source).join("+")})`;
    }
    if (["env", "enabledPlugins", "mcpServers"].includes(key) && eligible.length) {
      value = Object.assign({}, ...eligible.map((source) => source.raw![key]));
      from = `merged(${eligible.map((source) => source.source).join("+")})`;
    }
    if (key === "models") {
      const { loadProfiles } = await import("../services/api/providers/profile.js");
      const profiles = await loadProfiles(cwd);
      value = profiles.profiles;
      from = JSON.stringify(profiles.provenance);
    }
    if (key === "disableAllHooks") {
      const disabling = all.filter((source) => source.raw?.disableAllHooks === true);
      value = disabling.length > 0;
      from = disabling.length ? disabling.map((source) => source.source).join("+") : from;
    }
    if (value !== undefined) lines.push(`  ${key} = ${JSON.stringify(redactSettingValue(key, value))} [${from}; ${SETTING_RELOAD[key] ?? "restart"}]`);
  }
  const features = await loadFeatureSettings(cwd);
  lines.push(`  toolSearch = ${features.toolSearch} [${features.sources.toolSearch}; next request]`,
    `  toolSearchAutoThreshold = ${features.toolSearchAutoThreshold} [${features.sources.toolSearchAutoThreshold}; next request]`);
  for (const [role, model] of Object.entries(features.modelRoles)) lines.push(`  modelRoles.${role} = ${JSON.stringify(model)} [${features.sources[`modelRoles.${role}`]}; next invocation/request]`);
  for (const warning of features.warnings) lines.push(`  Warning: ${warning}`);
  return lines;
}
