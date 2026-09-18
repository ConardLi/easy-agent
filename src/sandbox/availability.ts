import { spawnSync } from "node:child_process";
import { SandboxManager, type SandboxDependencyCheck } from "@anthropic-ai/sandbox-runtime";
import type { SandboxBackend, SandboxCapability } from "./types.js";

let cachedCapability: SandboxCapability | undefined;

function backendForPlatform(platform: NodeJS.Platform): SandboxBackend | null {
  if (platform === "darwin") return "seatbelt";
  if (platform === "linux") return "bubblewrap";
  return null;
}

export function resolveSandboxCapability(
  platform: NodeJS.Platform,
  runtimeSupported: boolean,
  dependencies: SandboxDependencyCheck,
): SandboxCapability {
  const backend = backendForPlatform(platform);
  const supported = backend !== null && runtimeSupported;
  const errors = supported
    ? [...dependencies.errors]
    : platform === "win32"
      ? ["PowerShell sandboxing is not yet integrated; Bash sandboxing supports macOS and Linux"]
      : [`sandboxing is not supported on ${platform}`];
  return {
    platform,
    backend,
    supported,
    available: supported && errors.length === 0,
    errors,
    warnings: [...dependencies.warnings],
  };
}

export function getSandboxCapability(): SandboxCapability {
  if (cachedCapability) return cachedCapability;
  const platform = process.platform;
  const runtimeSupported = SandboxManager.isSupportedPlatform();
  if (backendForPlatform(platform) === null || !runtimeSupported) {
    cachedCapability = resolveSandboxCapability(platform, runtimeSupported, { errors: [], warnings: [] });
    return cachedCapability;
  }
  try {
    const dependencies = SandboxManager.checkDependencies();
    if (platform === "linux" && dependencies.errors.length === 0) {
      const namespaceError = probeLinuxNamespaces();
      if (namespaceError) dependencies.errors.push(namespaceError);
    }
    cachedCapability = resolveSandboxCapability(platform, runtimeSupported, dependencies);
  } catch (error) {
    cachedCapability = resolveSandboxCapability(platform, runtimeSupported, {
      errors: [`dependency check failed: ${error instanceof Error ? error.message : String(error)}`],
      warnings: [],
    });
  }
  return cachedCapability;
}

function probeLinuxNamespaces(): string | undefined {
  const result = spawnSync(
    "bwrap",
    [
      "--new-session",
      "--die-with-parent",
      "--unshare-net",
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--unshare-pid",
      "--unshare-user",
      "--proc", "/proc",
      "--", "/bin/true",
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  if (!result.error && result.status === 0) return undefined;
  const detail = result.error?.message ?? result.stderr.trim() ?? `exit ${result.status ?? "unknown"}`;
  return `bubblewrap cannot create the required user, PID, and network namespaces: ${detail}`;
}

export function isPlatformSupported(): boolean {
  return getSandboxCapability().supported;
}

export function getSandboxUnavailableReason(enabledInSettings: boolean): string | undefined {
  if (!enabledInSettings) return undefined;
  const capability = getSandboxCapability();
  if (capability.available) return undefined;
  return capability.errors.join("; ") || `sandbox is unavailable on ${capability.platform}`;
}

export function isSandboxRuntimeReady(): boolean {
  return getSandboxCapability().available;
}

export function _resetAvailabilityCache(): void {
  cachedCapability = undefined;
}
