/**
 * Public API for the sandbox subsystem. Importers should depend on
 * this module, NOT on individual files inside src/sandbox/, so we can
 * refactor the internal layout without breaking callers.
 */

export {
  isPlatformSupported,
  isSandboxRuntimeReady,
  getSandboxUnavailableReason,
  getSandboxCapability,
  resolveSandboxCapability,
  _resetAvailabilityCache,
} from "./availability.js";

export {
  loadSandboxSettings,
  resolveSandboxSettings,
  DEFAULT_RESOLVED_SANDBOX_SETTINGS,
  parseSandboxSettings,
  SandboxConfigurationError,
  type ResolvedSandboxSettings,
} from "./settings.js";

export {
  shouldUseSandbox,
  decideSandboxExecution,
  containsExcludedCommand,
  matchesExcludedPattern,
  type ShouldUseSandboxInput,
  type SandboxExecutionDecision,
} from "./shouldUseSandbox.js";

export { splitCommand } from "./splitCommand.js";

export {
  buildSandboxProfile,
  type PermissionRules,
} from "./buildProfile.js";

export {
  annotateSandboxFailure,
  cleanupSandboxCommand,
  resetSandboxRuntime,
  toSandboxRuntimeConfig,
  wrapWithSandbox,
  SandboxInitializationError,
  type SandboxedCommand,
} from "./runtime.js";

export {
  annotateStderrWithSandboxFailures,
  removeSandboxViolationTags,
  looksLikeSandboxViolation,
  hasSandboxViolationTag,
} from "./violations.js";

export type {
  SandboxSettings,
  SandboxProfile,
  SandboxCapability,
  SandboxBackend,
} from "./types.js";
