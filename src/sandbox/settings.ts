/**
 * Load + merge sandbox settings from user (~/.easy-agent/settings.json)
 * and project (<cwd>/.easy-agent/settings.json) scopes.
 *
 * Project overrides user (matches the existing permissions/MCP loaders
 * — see `src/permissions/permissions.ts:loadPermissionSettings`).
 *
 * Defaults:
 *   - enabled: false                      → opt-in feature
 *   - autoAllowBashIfSandboxed: true      → matches source code
 *   - allowUnsandboxedCommands: true      → matches source code
 *
 * Returns a fully-populated SandboxSettings — every field has a value,
 * so callers don't need to repeat default-checking.
 */

import { getSettingsPaths } from "../utils/paths.js";
import { readJsonSettingsFile } from "../utils/settings.js";
import type {
  SandboxFilesystemSettings,
  SandboxNetworkSettings,
  SandboxSettings,
} from "./types.js";

interface RawRootSettings {
  sandbox?: unknown;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function pickFilesystem(value: unknown): SandboxFilesystemSettings {
  if (!value || typeof value !== "object") return {};
  const fs = value as Record<string, unknown>;
  return {
    allowWrite: asStringArray(fs.allowWrite),
    denyWrite: asStringArray(fs.denyWrite),
    allowRead: asStringArray(fs.allowRead),
    denyRead: asStringArray(fs.denyRead),
  };
}

function pickNetwork(value: unknown): SandboxNetworkSettings {
  if (!value || typeof value !== "object") return {};
  const net = value as Record<string, unknown>;
  return {
    allowedDomains: asStringArray(net.allowedDomains),
    deniedDomains: asStringArray(net.deniedDomains),
  };
}

function pickSandbox(value: unknown): SandboxSettings {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
    autoAllowBashIfSandboxed:
      typeof raw.autoAllowBashIfSandboxed === "boolean"
        ? raw.autoAllowBashIfSandboxed
        : undefined,
    allowUnsandboxedCommands:
      typeof raw.allowUnsandboxedCommands === "boolean"
        ? raw.allowUnsandboxedCommands
        : undefined,
    excludedCommands: asStringArray(raw.excludedCommands),
    filesystem: pickFilesystem(raw.filesystem),
    network: pickNetwork(raw.network),
  };
}

async function readSandboxFromFile(filePath: string): Promise<SandboxSettings> {
  const result = await readJsonSettingsFile<RawRootSettings>(filePath);
  if (!result.raw || result.parseError) return {};
  return pickSandbox(result.raw.sandbox);
}

function mergeStringArrays(...lists: (string[] | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const item of list ?? []) {
      if (!seen.has(item)) {
        seen.add(item);
        out.push(item);
      }
    }
  }
  return out;
}

export interface ResolvedSandboxSettings {
  enabled: boolean;
  autoAllowBashIfSandboxed: boolean;
  allowUnsandboxedCommands: boolean;
  excludedCommands: string[];
  filesystem: Required<SandboxFilesystemSettings>;
  network: Required<SandboxNetworkSettings>;
}

export const DEFAULT_RESOLVED_SANDBOX_SETTINGS: ResolvedSandboxSettings = {
  enabled: false,
  autoAllowBashIfSandboxed: true,
  allowUnsandboxedCommands: true,
  excludedCommands: [],
  filesystem: { allowWrite: [], denyWrite: [], allowRead: [], denyRead: [] },
  network: { allowedDomains: [], deniedDomains: [] },
};

export function resolveSandboxSettings(
  user: SandboxSettings,
  project: SandboxSettings,
): ResolvedSandboxSettings {
  return {
    enabled: project.enabled ?? user.enabled ?? false,
    autoAllowBashIfSandboxed:
      project.autoAllowBashIfSandboxed ?? user.autoAllowBashIfSandboxed ?? true,
    allowUnsandboxedCommands:
      project.allowUnsandboxedCommands ?? user.allowUnsandboxedCommands ?? true,
    excludedCommands: mergeStringArrays(
      user.excludedCommands,
      project.excludedCommands,
    ),
    filesystem: {
      allowWrite: mergeStringArrays(
        user.filesystem?.allowWrite,
        project.filesystem?.allowWrite,
      ),
      denyWrite: mergeStringArrays(
        user.filesystem?.denyWrite,
        project.filesystem?.denyWrite,
      ),
      allowRead: mergeStringArrays(
        user.filesystem?.allowRead,
        project.filesystem?.allowRead,
      ),
      denyRead: mergeStringArrays(
        user.filesystem?.denyRead,
        project.filesystem?.denyRead,
      ),
    },
    network: {
      allowedDomains: mergeStringArrays(
        user.network?.allowedDomains,
        project.network?.allowedDomains,
      ),
      deniedDomains: mergeStringArrays(
        user.network?.deniedDomains,
        project.network?.deniedDomains,
      ),
    },
  };
}

export async function loadSandboxSettings(
  cwd: string,
): Promise<ResolvedSandboxSettings> {
  const { user, project } = getSettingsPaths(cwd);
  const [userSandbox, projectSandbox] = await Promise.all([
    readSandboxFromFile(user),
    readSandboxFromFile(project),
  ]);
  return resolveSandboxSettings(userSandbox, projectSandbox);
}
