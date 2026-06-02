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

import { loadSettingSources } from "../config/sources.js";
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

/**
 * Fold an ordered list of per-source sandbox settings (low → high priority)
 * into a fully-populated resolved object. Scalar fields take the last defined
 * value (later source wins); array fields merge + de-duplicate across sources.
 */
export function resolveSandboxList(list: SandboxSettings[]): ResolvedSandboxSettings {
  const lastDefined = <T>(pick: (s: SandboxSettings) => T | undefined, fallback: T): T => {
    let result: T | undefined;
    for (const s of list) {
      const v = pick(s);
      if (v !== undefined) result = v;
    }
    return result ?? fallback;
  };
  return {
    enabled: lastDefined((s) => s.enabled, false),
    autoAllowBashIfSandboxed: lastDefined((s) => s.autoAllowBashIfSandboxed, true),
    allowUnsandboxedCommands: lastDefined((s) => s.allowUnsandboxedCommands, true),
    excludedCommands: mergeStringArrays(...list.map((s) => s.excludedCommands)),
    filesystem: {
      allowWrite: mergeStringArrays(...list.map((s) => s.filesystem?.allowWrite)),
      denyWrite: mergeStringArrays(...list.map((s) => s.filesystem?.denyWrite)),
      allowRead: mergeStringArrays(...list.map((s) => s.filesystem?.allowRead)),
      denyRead: mergeStringArrays(...list.map((s) => s.filesystem?.denyRead)),
    },
    network: {
      allowedDomains: mergeStringArrays(...list.map((s) => s.network?.allowedDomains)),
      deniedDomains: mergeStringArrays(...list.map((s) => s.network?.deniedDomains)),
    },
  };
}

export function resolveSandboxSettings(
  user: SandboxSettings,
  project: SandboxSettings,
): ResolvedSandboxSettings {
  return resolveSandboxList([user, project]);
}

export async function loadSandboxSettings(
  cwd: string,
): Promise<ResolvedSandboxSettings> {
  const sources = await loadSettingSources(cwd);
  const list = sources.map((src) =>
    src.raw ? pickSandbox((src.raw as RawRootSettings).sandbox) : {},
  );
  return resolveSandboxList(list);
}
