/**
 * Feature settings of the resolved Agent, in the shape ToolSearch, model-role
 * routing, and configuration diagnostics use. The values come from the
 * Harness keys `features.toolSearch`, `features.toolSearchAutoThreshold`,
 * `features.maxTurns`, and `model.roles.*`.
 */
import { harnessFor, harnessSettingFor } from "../harness/active.js";
import { resolveHarnessFromInputs, type ResolvedHarness, type ResolvedHarnessValue } from "../harness/resolve.js";
import { loadTrustedSettingSources, type LoadedSource } from "./sources.js";

export type ToolSearchSetting = "off" | "auto" | "on";
export type ModelRole = "background" | "think" | "longContext";
export interface FeatureSettings {
  toolSearch: ToolSearchSetting;
  toolSearchAutoThreshold: number;
  /** A settings layer, the Agent, or the legacy variable set `toolSearch`. */
  toolSearchExplicit: boolean;
  modelRoles: Partial<Record<ModelRole, string>>;
  sources: Record<string, string>;
  warnings: string[];
}

const MODEL_ROLES: readonly ModelRole[] = ["background", "think", "longContext"];
const LAYER_ORDER = ["built-in", "user", "harness", "project", "local", "environment", "flag", "policy"];

function sourceLabel(entry: Pick<ResolvedHarnessValue, "source" | "detail">): string {
  if (entry.source === "built-in") return "default";
  if (entry.source === "environment" || entry.source === "harness") return `${entry.source}:${entry.detail}`;
  return entry.source;
}

function sourceDiagnostics(sources: readonly LoadedSource[]): string[] {
  return sources.flatMap((source) => [
    ...(source.parseError ? [source.parseError] : []),
    ...(source.validationErrors ?? []),
  ]);
}

/** The feature settings of a resolved harness; `diagnostics` are appended to the warnings. */
export function featureSettingsOf(resolved: ResolvedHarness, diagnostics: readonly string[] = []): FeatureSettings {
  const toolSearch = resolved.values["features.toolSearch"]!;
  const threshold = resolved.values["features.toolSearchAutoThreshold"]!;
  const sources: Record<string, string> = {
    toolSearch: sourceLabel(toolSearch),
    toolSearchAutoThreshold: sourceLabel(threshold),
    modelRoles: "default",
  };
  const modelRoles: FeatureSettings["modelRoles"] = {};
  let rolesLayer = 0;
  for (const role of MODEL_ROLES) {
    const entry = resolved.values[`model.roles.${role}`]!;
    if (typeof entry.value !== "string") continue;
    modelRoles[role] = entry.value;
    sources[`modelRoles.${role}`] = sourceLabel(entry);
    const layer = LAYER_ORDER.indexOf(entry.source);
    if (layer >= rolesLayer) {
      rolesLayer = layer;
      sources.modelRoles = sourceLabel(entry);
    }
  }

  const warnings: string[] = [];
  const legacy = toolSearch.contributions.find((contribution) => contribution.source === "environment");
  if (legacy) {
    warnings.push(
      `${legacy.detail} is deprecated; use toolSearch/toolSearchAutoThreshold in settings or --tool-search. Supported throughout 0.x; removal no earlier than 1.0 with a migration notice.`,
    );
  }
  const invalid = toolSearch.ignored.find((ignored) => ignored.source === "environment");
  if (invalid) warnings.push(`${invalid.detail}: invalid mode ignored; expected on, off, auto or auto:N.`);
  warnings.push(...diagnostics);

  return {
    toolSearch: toolSearch.value as ToolSearchSetting,
    toolSearchAutoThreshold: threshold.value as number,
    toolSearchExplicit: toolSearch.contributions.some((contribution) => contribution.source !== "built-in"),
    modelRoles,
    sources,
    warnings,
  };
}

/** Feature settings for already-loaded trusted settings sources and an environment. */
export function resolveFeatureSettings(sources: readonly LoadedSource[], env: NodeJS.ProcessEnv): FeatureSettings {
  const resolved = resolveHarnessFromInputs({
    layers: sources.map(({ source, path, raw }) => ({ source, path, raw })),
    workspaceTrusted: true,
    env,
  });
  return featureSettingsOf(resolved, sourceDiagnostics(sources));
}

/**
 * Feature settings for code working in `cwd`, from the settings files as they
 * are now, with their parse and validation warnings. For display; a model
 * request reads `featureSettingsOf(await harnessFor(cwd))`.
 */
export async function loadFeatureSettings(cwd: string): Promise<FeatureSettings> {
  const [resolved, sources] = await Promise.all([harnessFor(cwd, { current: true }), loadTrustedSettingSources(cwd)]);
  return featureSettingsOf(resolved, sourceDiagnostics(sources));
}

/**
 * Effective `maxTurns` (`--max-turns` and managed policy included) from the
 * settings files as they are now. Values that are not positive integers are
 * ignored, so a bad file falls back to the caller's default.
 */
export async function loadMaxTurnsSetting(cwd: string): Promise<number | undefined> {
  return harnessSettingFor<number | undefined>(cwd, "features.maxTurns", { current: true });
}

/** The model for `role` in the request being run in `cwd`, or `fallback`. */
export async function resolveRoleModel(cwd: string, role: ModelRole, fallback: string): Promise<string> {
  return (await harnessSettingFor<string | undefined>(cwd, `model.roles.${role}`)) ?? fallback;
}
