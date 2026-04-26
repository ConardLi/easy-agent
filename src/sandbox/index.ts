/**
 * Public API for the sandbox subsystem. Importers should depend on
 * this module, NOT on individual files inside src/sandbox/, so we can
 * refactor the internal layout without breaking callers.
 */

export {
  isPlatformSupported,
  isSandboxRuntimeReady,
  getSandboxUnavailableReason,
  _resetAvailabilityCache,
} from "./availability.js";

export {
  loadSandboxSettings,
  resolveSandboxSettings,
  DEFAULT_RESOLVED_SANDBOX_SETTINGS,
  type ResolvedSandboxSettings,
} from "./settings.js";

export {
  shouldUseSandbox,
  containsExcludedCommand,
  matchesExcludedPattern,
  type ShouldUseSandboxInput,
} from "./shouldUseSandbox.js";

export { splitCommand } from "./splitCommand.js";

export {
  buildSandboxProfile,
  type PermissionRules,
} from "./buildProfile.js";

export { compileMacosProfile } from "./macosProfile.js";

export { wrapWithSandbox, type WrapWithSandboxResult } from "./wrapWithSandbox.js";

export {
  annotateStderrWithSandboxFailures,
  removeSandboxViolationTags,
  looksLikeSandboxViolation,
  hasSandboxViolationTag,
} from "./violations.js";

export type { SandboxSettings, SandboxProfile } from "./types.js";
