/** Typed feature policy shared by runtime consumers and configuration diagnostics. */
import { loadTrustedSettingSources, type LoadedSource } from "./sources.js";

export type ToolSearchSetting = "off" | "auto" | "on";
export type ModelRole = "background" | "think" | "longContext";
export interface FeatureSettings {
  toolSearch: ToolSearchSetting;
  toolSearchAutoThreshold: number;
  toolSearchExplicit: boolean;
  modelRoles: Partial<Record<ModelRole, string>>;
  sources: Record<string, string>;
  warnings: string[];
}

/** Preserve the legacy boolean and auto:N spellings during the migration window. */
export function parseLegacyToolSearch(value: string): Pick<FeatureSettings, "toolSearch" | "toolSearchAutoThreshold"> | null {
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return { toolSearch: "on", toolSearchAutoThreshold: 10 };
  if (["false", "0", "no", "off"].includes(normalized)) return { toolSearch: "off", toolSearchAutoThreshold: 10 };
  if (normalized === "auto") return { toolSearch: "auto", toolSearchAutoThreshold: 10 };
  if (normalized.startsWith("auto:")) {
    const n = Number.parseInt(normalized.slice(5), 10);
    const threshold = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 10;
    return { toolSearch: threshold === 0 ? "on" : threshold === 100 ? "off" : "auto", toolSearchAutoThreshold: threshold };
  }
  return null;
}

export function resolveFeatureSettings(sources: readonly LoadedSource[], env: NodeJS.ProcessEnv = process.env): FeatureSettings {
  const result: FeatureSettings = { toolSearch: "on", toolSearchAutoThreshold: 10,
    toolSearchExplicit: false, modelRoles: {}, sources: { toolSearch: "default", toolSearchAutoThreshold: "default", modelRoles: "default" }, warnings: [] };
  const apply = (source: LoadedSource) => {
    const raw = source.raw;
    if (!raw) return;
    if (raw.toolSearch !== undefined) {
      result.toolSearch = raw.toolSearch as ToolSearchSetting;
      result.toolSearchExplicit = true;
      result.sources.toolSearch = source.source;
    }
    if (raw.toolSearchAutoThreshold !== undefined) {
      result.toolSearchAutoThreshold = raw.toolSearchAutoThreshold as number;
      result.sources.toolSearchAutoThreshold = source.source;
    }
    if (raw.modelRoles && typeof raw.modelRoles === "object") {
      for (const [role, model] of Object.entries(raw.modelRoles)) {
        result.modelRoles[role as ModelRole] = model as string;
        result.sources[`modelRoles.${role}`] = source.source;
      }
      result.sources.modelRoles = source.source;
    }
  };
  // Managed policy remains the highest-priority authority. Parent environment
  // overrides file preferences, while explicit CLI flags override environment.
  for (const source of sources) if (source.source !== "flag" && source.source !== "policy") apply(source);
  const legacyKey = env.EASY_AGENT_ENABLE_TOOL_SEARCH !== undefined ? "EASY_AGENT_ENABLE_TOOL_SEARCH" : "ENABLE_TOOL_SEARCH";
  const legacyValue = env[legacyKey];
  if (legacyValue !== undefined) {
    const legacy = parseLegacyToolSearch(legacyValue);
    if (legacy) {
      Object.assign(result, legacy);
      result.toolSearchExplicit = true;
      result.sources.toolSearch = `environment:${legacyKey}`;
      result.sources.toolSearchAutoThreshold = `environment:${legacyKey}`;
      result.warnings.push(`${legacyKey} is deprecated; use toolSearch/toolSearchAutoThreshold in settings or --tool-search. Supported throughout 0.x; removal no earlier than 1.0 with a migration notice.`);
    } else result.warnings.push(`${legacyKey}: invalid mode ignored; expected on, off, auto or auto:N.`);
  }
  for (const source of sources) if (source.source === "flag" || source.source === "policy") apply(source);
  for (const source of sources) {
    if (source.parseError) result.warnings.push(source.parseError);
    result.warnings.push(...(source.validationErrors ?? []));
  }
  return result;
}

/**
 * Effective `maxTurns` from trusted sources (the `--max-turns` flag and
 * managed policy included; later sources win). Values that are not positive
 * integers are ignored, so a bad file falls back to the caller's default.
 */
export async function loadMaxTurnsSetting(cwd: string): Promise<number | undefined> {
  let result: number | undefined;
  for (const source of await loadTrustedSettingSources(cwd)) {
    const value = source.raw?.maxTurns;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) result = value;
  }
  return result;
}

export async function loadFeatureSettings(cwd: string): Promise<FeatureSettings> {
  return resolveFeatureSettings(await loadTrustedSettingSources(cwd));
}

export async function resolveRoleModel(cwd: string, role: ModelRole, fallback: string): Promise<string> {
  return (await loadFeatureSettings(cwd)).modelRoles[role] ?? fallback;
}
