import type { SettingSource } from "./sources.js";
import { defineRuntimeState } from "../state/runtimeScope.js";
import { migrateLegacyEnvironment, type EnvironmentMigration } from "./migration.js";
import { environmentReferences } from "./values.js";

export type EnvironmentConfigSource = SettingSource | "dotenv";

export interface EnvironmentLoadReport {
  projectTrusted: boolean;
  effectiveSources: Record<string, EnvironmentConfigSource>;
  ignoredBySource: Partial<Record<EnvironmentConfigSource, number>>;
  protectedCredentialOverrides: Partial<Record<EnvironmentConfigSource, number>>;
}

const state = defineRuntimeState(
  "configurationEnvironment",
  () => ({
    inherited: null as Readonly<NodeJS.ProcessEnv> | null,
    report: null as EnvironmentLoadReport | null,
    snapshot: null as EnvironmentMigration | null,
    input: null as Readonly<NodeJS.ProcessEnv> | null,
    credentialReferences: new Set<string>(),
    writes: new Map<string, { original: string | undefined; applied: string | undefined }>(),
  }),
  (value) => restoreEnvironment(value.writes),
);

function restoreEnvironment(writes: Map<string, { original: string | undefined; applied: string | undefined }>): void {
  for (const [key, entry] of writes) {
    // Preserve an explicit external edit made while the runtime was alive.
    if (process.env[key] !== entry.applied) continue;
    if (entry.original === undefined) delete process.env[key];
    else process.env[key] = entry.original;
  }
  writes.clear();
}

/** Track process inheritance for external tools and restore it when this runtime closes. */
export function writeRuntimeEnvironment(key: string, value: string | undefined): void {
  const writes = state().writes;
  const original = writes.has(key) ? writes.get(key)!.original : process.env[key];
  writes.set(key, { original, applied: value });
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Model configuration reads this immutable runtime snapshot, never ambient mutations. */
export function installConfigurationEnvironment(
  env: Readonly<NodeJS.ProcessEnv>,
  options: { savedProfileSelected?: boolean } = {},
): EnvironmentMigration {
  state().input = Object.freeze({ ...env });
  const migrated = migrateLegacyEnvironment(env, options);
  Object.freeze(migrated.env);
  state().snapshot = migrated;
  return migrated;
}

/** Unconverted snapshot for the centralized migration boundary. */
export function configurationInputEnvironment(): Readonly<NodeJS.ProcessEnv> {
  configurationEnvironmentMigration();
  return state().input!;
}

export function configurationEnvironment(): Readonly<NodeJS.ProcessEnv> {
  return configurationEnvironmentMigration().env;
}

export function configurationEnvironmentMigration(): EnvironmentMigration {
  return state().snapshot ?? installConfigurationEnvironment(process.env);
}

export function registerCredentialReferences(models: unknown): void {
  if (!models || typeof models !== "object") return;
  for (const profile of Object.values(models)) {
    if (!profile || typeof profile !== "object") continue;
    for (const name of environmentReferences((profile as Record<string, unknown>).apiKey)) {
      state().credentialReferences.add(name);
    }
  }
}

/** Capture the environment supplied by the parent process before settings are applied. */
export function captureInheritedEnvironment(): Readonly<NodeJS.ProcessEnv> {
  const cell = state();
  cell.inherited ??= Object.freeze({ ...process.env });
  return cell.inherited;
}

/** Credential-shaped variables require an explicit parent-process override. */
export function isCredentialEnvironmentKey(key: string): boolean {
  return /(?:^|_)(?:API_?KEY|AUTH(?:ORIZATION)?|ACCESS_?TOKEN|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY|CLIENT_?SECRET)(?:_|$)/i.test(
    key,
  );
}

/** Project configuration cannot replace a credential already supplied by the parent process. */
export function isInheritedCredentialProtected(key: string): boolean {
  const inherited = captureInheritedEnvironment();
  const value = inherited[key];
  return (
    (isCredentialEnvironmentKey(key) || state().credentialReferences.has(key)) && value !== undefined && value !== ""
  );
}

export function setEnvironmentLoadReport(report: EnvironmentLoadReport): void {
  state().report = {
    projectTrusted: report.projectTrusted,
    effectiveSources: { ...report.effectiveSources },
    ignoredBySource: { ...report.ignoredBySource },
    protectedCredentialOverrides: { ...report.protectedCredentialOverrides },
  };
}

export function getEnvironmentLoadReport(): EnvironmentLoadReport | null {
  const lastLoadReport = state().report;
  if (!lastLoadReport) return null;
  return {
    projectTrusted: lastLoadReport.projectTrusted,
    effectiveSources: { ...lastLoadReport.effectiveSources },
    ignoredBySource: { ...lastLoadReport.ignoredBySource },
    protectedCredentialOverrides: { ...lastLoadReport.protectedCredentialOverrides },
  };
}

export function resetEnvironmentStateForTests(): void {
  restoreEnvironment(state().writes);
  state().inherited = null;
  state().report = null;
  state().snapshot = null;
  state().input = null;
  state().credentialReferences.clear();
}
