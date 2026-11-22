/**
 * Applies settings-backed environment variables after workspace trust has
 * been resolved. User, explicit flag, and managed policy sources are always
 * eligible. Project settings, local settings, and `<cwd>/.env` are applied
 * only for a trusted workspace.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import dotenv from "dotenv";
import { isProjectTrusted } from "../config/globalState.js";
import { loadSettingSources, resetSettingsCache } from "../config/sources.js";
import {
  captureInheritedEnvironment,
  isInheritedCredentialProtected,
  setEnvironmentLoadReport,
  installConfigurationEnvironment,
  registerCredentialReferences,
  writeRuntimeEnvironment,
  type EnvironmentConfigSource,
  type EnvironmentLoadReport,
  CONNECTION_ENVIRONMENT_NAMES,
  environmentDeclaresConnection,
} from "../config/environment.js";

export interface LoadEnvironmentOptions {
  /** Explicit caller authorization for project settings and `.env`. */
  allowProject?: boolean;
}

function readSourceEnv(raw: Record<string, unknown> | null): Record<string, string> {
  const value = raw?.env;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined || item === null) continue;
    out[key] = typeof item === "string" ? item : String(item);
  }
  return out;
}

async function readDotenv(cwd: string): Promise<Record<string, string>> {
  try {
    return dotenv.parse(await fs.readFile(path.join(cwd, ".env")));
  } catch {
    return {};
  }
}

async function hasDotenv(cwd: string): Promise<boolean> {
  try {
    await fs.access(path.join(cwd, ".env"));
    return true;
  } catch {
    return false;
  }
}

function increment(counts: Partial<Record<EnvironmentConfigSource, number>>, source: EnvironmentConfigSource): void {
  counts[source] = (counts[source] ?? 0) + 1;
}

export async function loadEnv(
  cwd: string = process.cwd(),
  options: LoadEnvironmentOptions = {},
): Promise<EnvironmentLoadReport> {
  const inherited = captureInheritedEnvironment();
  const projectTrusted = options.allowProject === true || (await isProjectTrusted(cwd));
  const sources = await loadSettingSources(cwd);
  for (const source of sources) {
    if ((source.source !== "project" && source.source !== "local") || projectTrusted) {
      registerCredentialReferences(source.raw?.models);
    }
  }
  const report: EnvironmentLoadReport = {
    projectTrusted,
    effectiveSources: {},
    ignoredBySource: {},
    protectedCredentialOverrides: {},
  };
  const targetNames = ["EASY_AGENT_PROFILE", "EASY_AGENT_PROTOCOL", "EASY_AGENT_MODEL", "EASY_AGENT_BASE_URL"];
  const selectConnection = (values: Readonly<NodeJS.ProcessEnv>): void => {
    if (!environmentDeclaresConnection(values)) return;
    // A higher layer chooses a complete connection. Arbitrary environment
    // references remain available, but lower shortcut targets cannot leak in.
    for (const key of CONNECTION_ENVIRONMENT_NAMES) {
      if (values[key] !== undefined) continue;
      if (values.EASY_AGENT_PROFILE?.trim() && !targetNames.includes(key)) continue;
      writeRuntimeEnvironment(key, undefined);
      delete report.effectiveSources[key];
    }
  };

  const apply = (source: EnvironmentConfigSource, values: Record<string, string>, projectScoped: boolean): void => {
    if (!projectScoped || projectTrusted) selectConnection(values);
    for (const [key, value] of Object.entries(values)) {
      if (projectScoped && !projectTrusted) {
        increment(report.ignoredBySource, source);
        continue;
      }
      if (projectScoped && isInheritedCredentialProtected(key)) {
        increment(report.protectedCredentialOverrides, source);
        continue;
      }
      writeRuntimeEnvironment(key, value);
      report.effectiveSources[key] = source;
    }
  };

  for (const source of sources) {
    if (source.source === "flag") {
      if (projectTrusted) {
        apply("dotenv", await readDotenv(cwd), true);
      } else if (await hasDotenv(cwd)) {
        increment(report.ignoredBySource, "dotenv");
      }
      // The process layer follows project files, before explicit flags and policy.
      selectConnection(inherited);
      for (const [key, value] of Object.entries(inherited)) {
        if (value !== undefined) {
          // Windows may retain the parent's "Path" spelling after a "PATH"
          // write. Its environment keys still refer to the same variable.
          const sourceKey =
            process.platform === "win32"
              ? (Object.keys(report.effectiveSources).find((name) => name.toUpperCase() === key.toUpperCase()) ?? key)
              : key;
          // Preserve external-tool environment inheritance (PATH, build
          // variables, etc.). Product settings and credentials use the
          // standardized precedence.
          if (
            report.effectiveSources[sourceKey] &&
            !key.startsWith("EASY_AGENT_") &&
            !isInheritedCredentialProtected(key)
          )
            continue;
          writeRuntimeEnvironment(key, value);
          delete report.effectiveSources[sourceKey];
        }
      }
    }
    const projectScoped = source.source === "project" || source.source === "local";
    apply(source.source, readSourceEnv(source.raw), projectScoped);
  }

  setEnvironmentLoadReport(report);
  installConfigurationEnvironment(process.env);
  resetSettingsCache();
  return report;
}
