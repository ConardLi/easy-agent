import type { SettingSource } from "./sources.js";

export type EnvironmentConfigSource = SettingSource | "dotenv";

export interface EnvironmentLoadReport {
  projectTrusted: boolean;
  effectiveSources: Record<string, EnvironmentConfigSource>;
  ignoredBySource: Partial<Record<EnvironmentConfigSource, number>>;
  protectedCredentialOverrides: Partial<Record<EnvironmentConfigSource, number>>;
}

let inheritedEnvironment: Readonly<NodeJS.ProcessEnv> | null = null;
let lastLoadReport: EnvironmentLoadReport | null = null;

/** Capture the environment supplied by the parent process before settings are applied. */
export function captureInheritedEnvironment(): Readonly<NodeJS.ProcessEnv> {
  if (!inheritedEnvironment) inheritedEnvironment = Object.freeze({ ...process.env });
  return inheritedEnvironment;
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
  return isCredentialEnvironmentKey(key) && value !== undefined && value !== "";
}

export function setEnvironmentLoadReport(report: EnvironmentLoadReport): void {
  lastLoadReport = {
    projectTrusted: report.projectTrusted,
    effectiveSources: { ...report.effectiveSources },
    ignoredBySource: { ...report.ignoredBySource },
    protectedCredentialOverrides: { ...report.protectedCredentialOverrides },
  };
}

export function getEnvironmentLoadReport(): EnvironmentLoadReport | null {
  if (!lastLoadReport) return null;
  return {
    projectTrusted: lastLoadReport.projectTrusted,
    effectiveSources: { ...lastLoadReport.effectiveSources },
    ignoredBySource: { ...lastLoadReport.ignoredBySource },
    protectedCredentialOverrides: { ...lastLoadReport.protectedCredentialOverrides },
  };
}

export function resetEnvironmentStateForTests(): void {
  inheritedEnvironment = null;
  lastLoadReport = null;
}
