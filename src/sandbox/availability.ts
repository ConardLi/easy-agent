/**
 * Detect whether the sandbox can actually run on the current host.
 *
 * Why this exists (security footgun, mirroring source code's
 * `getSandboxUnavailableReason`):
 *
 *   The user opts in by writing `sandbox.enabled: true` in settings.json.
 *   If the host can't run sandbox-exec — e.g. they're on Windows or
 *   Linux, or sandbox-exec was removed by some MDM tool — and we
 *   silently fall back to "no sandbox", the user thinks they're
 *   protected and they aren't. So we surface the reason loudly at
 *   startup and let the user decide.
 *
 * Easy-agent only ships the macOS backend (see DEVELOPMENT-PLAN
 * stage 18.6). Linux/WSL is explicitly out of scope for the tutorial.
 */

import { execFileSync } from "node:child_process";

let cachedSupported: boolean | undefined;
let cachedReason: string | undefined;

export function isPlatformSupported(): boolean {
  return process.platform === "darwin";
}

function isSandboxExecAvailable(): boolean {
  // `which sandbox-exec` is fast (~5ms) and avoids spawning the binary
  // itself. We synchronously check once at startup; if the user ever
  // installs/removes sandbox-exec mid-session they need to restart.
  try {
    execFileSync("/usr/bin/which", ["sandbox-exec"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns a reason string if the user enabled the sandbox but it
 * cannot run; returns undefined otherwise. Caller should print this
 * once at CLI startup, NOT on every Bash command (it would spam).
 *
 * Result is cached after the first call — sandbox availability does
 * not change during a process lifetime.
 */
export function getSandboxUnavailableReason(
  enabledInSettings: boolean,
): string | undefined {
  if (!enabledInSettings) return undefined;

  if (cachedReason !== undefined) return cachedReason || undefined;
  if (cachedSupported === true) return undefined;

  if (!isPlatformSupported()) {
    cachedSupported = false;
    cachedReason = `sandbox.enabled is true but ${process.platform} is not supported (easy-agent only sandboxes on macOS).`;
    return cachedReason;
  }

  if (!isSandboxExecAvailable()) {
    cachedSupported = false;
    cachedReason = "sandbox.enabled is true but /usr/bin/sandbox-exec is not available on this Mac.";
    return cachedReason;
  }

  cachedSupported = true;
  cachedReason = "";
  return undefined;
}

/**
 * "Can the sandbox actually run right now?" — fast, cached, no I/O after
 * the first call. Used by `shouldUseSandbox()` on every Bash invocation.
 */
export function isSandboxRuntimeReady(): boolean {
  if (cachedSupported !== undefined) return cachedSupported;
  cachedSupported = isPlatformSupported() && isSandboxExecAvailable();
  return cachedSupported;
}

/** Test-only — reset memoization. */
export function _resetAvailabilityCache(): void {
  cachedSupported = undefined;
  cachedReason = undefined;
}
