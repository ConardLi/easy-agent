/**
 * Type definitions for the sandbox subsystem.
 *
 * Two concept layers, intentionally separated:
 *
 *   1. SandboxSettings  — what the user writes in settings.json. Strings
 *                         and bools, no derivation logic. Loader returns
 *                         this verbatim.
 *
 *   2. SandboxProfile   — what the runtime feeds into sandbox-exec. Built
 *                         by `buildProfile.ts` by mixing SandboxSettings
 *                         with the permission rules (Edit/WebFetch) and
 *                         a hardcoded set of always-deny paths. The
 *                         macOS sbpl compiler reads this, NOT the raw
 *                         settings.
 *
 * Reference: `claude-code-source-code/src/utils/sandbox/sandbox-adapter.ts`
 *   - SandboxSettings  ≈ SettingsJson["sandbox"]
 *   - SandboxProfile   ≈ SandboxRuntimeConfig (the @anthropic-ai/sandbox-runtime input)
 */

export interface SandboxFilesystemSettings {
  allowWrite?: string[];
  denyWrite?: string[];
  allowRead?: string[];
  denyRead?: string[];
}

export interface SandboxNetworkSettings {
  allowedDomains?: string[];
  deniedDomains?: string[];
}

export interface SandboxSettings {
  /** Master switch. Default false — we DON'T sandbox by default; users opt in. */
  enabled?: boolean;
  /**
   * If true and sandboxing is on, Bash commands skip the user-confirmation
   * dialog when no explicit deny/ask rule matches. The sandbox is the
   * safety net. Default true (matches source code).
   */
  autoAllowBashIfSandboxed?: boolean;
  /**
   * If true, the model can pass `dangerouslyDisableSandbox: true` to escape
   * the sandbox for one command. If false, that flag is ignored — the
   * sandbox always wraps Bash. Default true (matches source code).
   */
  allowUnsandboxedCommands?: boolean;
  /**
   * Wildcard prefixes for commands that should NEVER be sandboxed. Used
   * for things like `docker:*` and `make:*` that need raw filesystem
   * access. NOT a security boundary — it's a UX escape hatch.
   * See source code's `shouldUseSandbox.ts:18` NOTE comment.
   */
  excludedCommands?: string[];
  filesystem?: SandboxFilesystemSettings;
  network?: SandboxNetworkSettings;
}

/**
 * Concrete profile to feed into sandbox-exec. All paths are absolute.
 * The macOS profile compiler converts this into sbpl.
 */
export interface SandboxProfile {
  filesystem: {
    allowWrite: string[];
    denyWrite: string[];
    allowRead: string[];
    denyRead: string[];
  };
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
  };
}

/** Reasons why the sandbox cannot run on the current host. */
export type SandboxUnavailableReason =
  | { kind: "platform"; platform: NodeJS.Platform }
  | { kind: "missingBinary"; binary: string };
