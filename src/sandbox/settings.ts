import { loadTrustedSettingSources, type LoadedSource } from "../config/sources.js";
import type {
  SandboxFilesystemSettings,
  SandboxNetworkSettings,
  SandboxSettings,
} from "./types.js";

interface RawRootSettings {
  sandbox?: unknown;
}

const SANDBOX_KEYS = new Set([
  "enabled",
  "failClosed",
  "autoAllowBashIfSandboxed",
  "allowUnsandboxedCommands",
  "excludedCommands",
  "filesystem",
  "network",
]);
const FILESYSTEM_KEYS = new Set(["allowWrite", "denyWrite", "allowRead", "denyRead"]);
const NETWORK_KEYS = new Set([
  "allowedDomains",
  "deniedDomains",
  "allowUnixSockets",
  "allowAllUnixSockets",
  "allowLocalBinding",
]);

export class SandboxConfigurationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid sandbox configuration:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    this.name = "SandboxConfigurationError";
  }
}

function readBoolean(
  raw: Record<string, unknown>,
  key: string,
  label: string,
  problems: string[],
): boolean | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  problems.push(`${label}.${key} must be a boolean`);
  return undefined;
}

function readStringArray(
  raw: Record<string, unknown>,
  key: string,
  label: string,
  problems: string[],
): string[] | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    problems.push(`${label}.${key} must be an array of non-empty strings`);
    return undefined;
  }
  const normalized: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      problems.push(`${label}.${key}[${index}] must be a non-empty string`);
      return;
    }
    normalized.push(item.trim());
  });
  return normalized;
}

function reportUnknownKeys(
  raw: Record<string, unknown>,
  supported: Set<string>,
  label: string,
  problems: string[],
): void {
  for (const key of Object.keys(raw)) {
    if (!supported.has(key)) problems.push(`${label}.${key} is not supported by this version`);
  }
}

function readObject(
  value: unknown,
  label: string,
  problems: string[],
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    problems.push(`${label} must be an object`);
    return undefined;
  }
  return value as Record<string, unknown>;
}

function pickFilesystem(
  value: unknown,
  label: string,
  problems: string[],
): SandboxFilesystemSettings | undefined {
  const raw = readObject(value, label, problems);
  if (!raw) return undefined;
  reportUnknownKeys(raw, FILESYSTEM_KEYS, label, problems);
  return {
    allowWrite: readStringArray(raw, "allowWrite", label, problems),
    denyWrite: readStringArray(raw, "denyWrite", label, problems),
    allowRead: readStringArray(raw, "allowRead", label, problems),
    denyRead: readStringArray(raw, "denyRead", label, problems),
  };
}

function pickNetwork(
  value: unknown,
  label: string,
  problems: string[],
): SandboxNetworkSettings | undefined {
  const raw = readObject(value, label, problems);
  if (!raw) return undefined;
  reportUnknownKeys(raw, NETWORK_KEYS, label, problems);
  return {
    allowedDomains: readStringArray(raw, "allowedDomains", label, problems),
    deniedDomains: readStringArray(raw, "deniedDomains", label, problems),
    allowUnixSockets: readStringArray(raw, "allowUnixSockets", label, problems),
    allowAllUnixSockets: readBoolean(raw, "allowAllUnixSockets", label, problems),
    allowLocalBinding: readBoolean(raw, "allowLocalBinding", label, problems),
  };
}

function parseSandboxValue(
  value: unknown,
  label: string,
  problems: string[],
): SandboxSettings {
  if (value === undefined) return {};
  const raw = readObject(value, label, problems);
  if (!raw) return {};
  reportUnknownKeys(raw, SANDBOX_KEYS, label, problems);
  return {
    enabled: readBoolean(raw, "enabled", label, problems),
    failClosed: readBoolean(raw, "failClosed", label, problems),
    autoAllowBashIfSandboxed: readBoolean(raw, "autoAllowBashIfSandboxed", label, problems),
    allowUnsandboxedCommands: readBoolean(raw, "allowUnsandboxedCommands", label, problems),
    excludedCommands: readStringArray(raw, "excludedCommands", label, problems),
    filesystem: pickFilesystem(raw.filesystem, `${label}.filesystem`, problems),
    network: pickNetwork(raw.network, `${label}.network`, problems),
  };
}

export function parseSandboxSettings(value: unknown, label = "sandbox"): SandboxSettings {
  const problems: string[] = [];
  const parsed = parseSandboxValue(value, label, problems);
  if (problems.length > 0) throw new SandboxConfigurationError(problems);
  return parsed;
}

function pickSandbox(source: LoadedSource, problems: string[]): SandboxSettings {
  const root = source.raw as RawRootSettings | null;
  if (!root || root.sandbox === undefined) return {};
  return parseSandboxValue(root.sandbox, `${source.path ?? source.source}: sandbox`, problems);
}

function mergeStringArrays(...lists: (string[] | undefined)[]): string[] {
  return Array.from(new Set(lists.flatMap((list) => list ?? [])));
}

export interface ResolvedSandboxSettings {
  enabled: boolean;
  failClosed: boolean;
  autoAllowBashIfSandboxed: boolean;
  allowUnsandboxedCommands: boolean;
  excludedCommands: string[];
  filesystem: Required<SandboxFilesystemSettings>;
  network: Required<SandboxNetworkSettings>;
}

export const DEFAULT_RESOLVED_SANDBOX_SETTINGS: ResolvedSandboxSettings = {
  enabled: false,
  failClosed: true,
  autoAllowBashIfSandboxed: true,
  allowUnsandboxedCommands: true,
  excludedCommands: [],
  filesystem: { allowWrite: [], denyWrite: [], allowRead: [], denyRead: [] },
  network: {
    allowedDomains: [],
    deniedDomains: [],
    allowUnixSockets: [],
    allowAllUnixSockets: false,
    allowLocalBinding: false,
  },
};

export function resolveSandboxList(list: SandboxSettings[]): ResolvedSandboxSettings {
  const lastDefined = <T>(pick: (settings: SandboxSettings) => T | undefined, fallback: T): T => {
    let result: T | undefined;
    for (const settings of list) {
      const value = pick(settings);
      if (value !== undefined) result = value;
    }
    return result ?? fallback;
  };
  return {
    enabled: lastDefined((settings) => settings.enabled, false),
    failClosed: lastDefined((settings) => settings.failClosed, true),
    autoAllowBashIfSandboxed: lastDefined((settings) => settings.autoAllowBashIfSandboxed, true),
    allowUnsandboxedCommands: lastDefined((settings) => settings.allowUnsandboxedCommands, true),
    excludedCommands: mergeStringArrays(...list.map((settings) => settings.excludedCommands)),
    filesystem: {
      allowWrite: mergeStringArrays(...list.map((settings) => settings.filesystem?.allowWrite)),
      denyWrite: mergeStringArrays(...list.map((settings) => settings.filesystem?.denyWrite)),
      allowRead: mergeStringArrays(...list.map((settings) => settings.filesystem?.allowRead)),
      denyRead: mergeStringArrays(...list.map((settings) => settings.filesystem?.denyRead)),
    },
    network: {
      allowedDomains: mergeStringArrays(...list.map((settings) => settings.network?.allowedDomains)),
      deniedDomains: mergeStringArrays(...list.map((settings) => settings.network?.deniedDomains)),
      allowUnixSockets: mergeStringArrays(...list.map((settings) => settings.network?.allowUnixSockets)),
      allowAllUnixSockets: lastDefined((settings) => settings.network?.allowAllUnixSockets, false),
      allowLocalBinding: lastDefined((settings) => settings.network?.allowLocalBinding, false),
    },
  };
}

export function resolveSandboxSettings(
  user: SandboxSettings,
  project: SandboxSettings,
): ResolvedSandboxSettings {
  return resolveSandboxList([user, project]);
}

export async function loadSandboxSettings(cwd: string): Promise<ResolvedSandboxSettings> {
  const sources = await loadTrustedSettingSources(cwd);
  const problems = sources.flatMap((source) =>
    source.parseError ? [`${source.path ?? source.source}: ${source.parseError}`] : [],
  );
  const list = sources.map((source) => pickSandbox(source, problems));
  if (problems.length > 0) throw new SandboxConfigurationError(problems);
  return resolveSandboxList(list);
}
