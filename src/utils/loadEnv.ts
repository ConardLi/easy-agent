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
import { loadSettingSources } from "../config/sources.js";
import {
  captureInheritedEnvironment,
  isInheritedCredentialProtected,
  setEnvironmentLoadReport,
  type EnvironmentConfigSource,
  type EnvironmentLoadReport,
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

function increment(
  counts: Partial<Record<EnvironmentConfigSource, number>>,
  source: EnvironmentConfigSource,
): void {
  counts[source] = (counts[source] ?? 0) + 1;
}

export async function loadEnv(
  cwd: string = process.cwd(),
  options: LoadEnvironmentOptions = {},
): Promise<EnvironmentLoadReport> {
  captureInheritedEnvironment();
  const projectTrusted = options.allowProject === true || (await isProjectTrusted(cwd));
  const sources = await loadSettingSources(cwd);
  const report: EnvironmentLoadReport = {
    projectTrusted,
    effectiveSources: {},
    ignoredBySource: {},
    protectedCredentialOverrides: {},
  };

  const apply = (
    source: EnvironmentConfigSource,
    values: Record<string, string>,
    projectScoped: boolean,
  ): void => {
    for (const [key, value] of Object.entries(values)) {
      if (projectScoped && !projectTrusted) {
        increment(report.ignoredBySource, source);
        continue;
      }
      if (projectScoped && isInheritedCredentialProtected(key)) {
        increment(report.protectedCredentialOverrides, source);
        continue;
      }
      process.env[key] = value;
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
    }
    const projectScoped = source.source === "project" || source.source === "local";
    apply(source.source, readSourceEnv(source.raw), projectScoped);
  }

  setEnvironmentLoadReport(report);
  return report;
}
