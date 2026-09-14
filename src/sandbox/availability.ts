import { SandboxManager, type SandboxDependencyCheck } from "@anthropic-ai/sandbox-runtime";
import type { SandboxBackend, SandboxCapability } from "./types.js";

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
  const platform = process.platform;
  const runtimeSupported = SandboxManager.isSupportedPlatform();
  if (backendForPlatform(platform) === null || !runtimeSupported) {
    return resolveSandboxCapability(platform, runtimeSupported, { errors: [], warnings: [] });
  }
  try {
    return resolveSandboxCapability(platform, runtimeSupported, SandboxManager.checkDependencies());
  } catch (error) {
    return resolveSandboxCapability(platform, runtimeSupported, {
      errors: [`dependency check failed: ${error instanceof Error ? error.message : String(error)}`],
      warnings: [],
    });
  }
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

/** Compatibility no-op: dependency detection is owned and cached by the runtime. */
export function _resetAvailabilityCache(): void {}
