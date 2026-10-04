/**
 * Extended-thinking utilities for Easy Agent.
 *
 *   - ThinkingConfig three-state union
 *   - Model capability detection (thinking / adaptive / interleaved)
 *   - shouldEnableThinkingByDefault
 *   - hasUltrathinkKeyword (whole-word /\bultrathink\b/i)
 *
 * The ultrathink keyword is always active. Capability detection uses pure
 * model-name heuristics + env vars (there is no per-model override table),
 * so all functions here are synchronous and safe to call from the
 * streaming hot path.
 *
 * Session-level thinking state (the `/think` and `/effort` commands, plus
 * the `alwaysThinkingEnabled` boot preference) lives in a small in-memory
 * store here, which the REPL mutates live. The CLI seeds it once at startup from
 * settings.json (see configureThinkingDefaults).
 */

// ─── ThinkingConfig three-state union ─────────────────────────────

/**
 * Three-state thinking configuration.
 *
 * - `adaptive`  — model decides how much to think (no budget cap); the
 *                 preferred setting for models that support it (Opus 4.6+,
 *                 Sonnet 4.6+).
 * - `enabled`   — thinking on with an explicit token budget; used when
 *                 the model does not support adaptive mode.
 * - `disabled`  — thinking off entirely.
 */
export type ThinkingConfig = { type: "adaptive" } | { type: "enabled"; budgetTokens: number } | { type: "disabled" };

// ─── Effort level ──────────────────────────────────────────────────

export type EffortLevel = "low" | "medium" | "high" | "max";

// ─── ultrathink keyword ────────────────────────────────────────────

/**
 * True when the text contains the whole-word keyword "ultrathink"
 * (case-insensitive). Note the word boundary anchors (\b) and the `i`
 * flag: "ultrathinking" does not trigger it.
 */
export function hasUltrathinkKeyword(text: string): boolean {
  return /\bultrathink\b/i.test(text);
}

// ─── Model capability detection ───────────────────────────────────

/**
 * Normalise a model string to a lowercase canonical form suitable
 * for containment checks. Strips vendor prefixes used by Bedrock /
 * Vertex (e.g. "anthropic.claude-opus-4-6-20251101-v1:0") and trims
 * whitespace.
 */
function getCanonicalName(model: string): string {
  // Bedrock format: "anthropic.claude-*" → "claude-*"
  // Vertex format: "publishers/anthropic/models/claude-*" → "claude-*"
  const lower = model.trim().toLowerCase();
  const afterDot = lower.split(".").pop() ?? lower;
  const lastSegment = afterDot.split("/").pop() ?? afterDot;
  return lastSegment;
}

/** Parse the major/minor pair from names such as `claude-opus-4-7`. */
function getClaudeVersion(model: string): { major: number; minor: number } | null {
  const canonical = getCanonicalName(model);
  const match = canonical.match(/claude-(?:opus|sonnet|haiku)-(\d+)-(\d+)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function isClaudeVersionAtLeast(model: string, major: number, minor: number): boolean {
  const version = getClaudeVersion(model);
  return version !== null && (version.major > major || (version.major === major && version.minor >= minor));
}

/**
 * Whether the given model supports extended thinking at all.
 *
 * Known Claude 3 models are excluded; every other model (Claude 4+ and
 * unknown names) defaults to true. There is no per-endpoint distinction.
 */
export function modelSupportsThinking(model: string): boolean {
  const canonical = getCanonicalName(model);
  // Disable for known Claude 3 models
  if (canonical.includes("claude-3-")) return false;
  // Default true for all Claude 4+ and unknown models
  return true;
}

/**
 * Whether the model supports *adaptive* thinking (no token budget
 * required). Opus 4.6+ and Sonnet 4.6+; unknown models default true
 * to avoid silently degrading quality.
 */
export function modelSupportsAdaptiveThinking(model: string): boolean {
  const canonical = getCanonicalName(model);
  // Opus/Sonnet 4.6 and newer support adaptive thinking. Use a version
  // comparison instead of pinning the allowlist to exactly 4.6, otherwise a
  // newer model such as claude-opus-4-7 incorrectly falls back to budget mode.
  if ((canonical.includes("opus") || canonical.includes("sonnet")) && isClaudeVersionAtLeast(model, 4, 6)) {
    return true;
  }
  // Exclude known legacy variants (older opus/sonnet/haiku)
  if (canonical.includes("opus") || canonical.includes("sonnet") || canonical.includes("haiku")) {
    return false;
  }
  // Unknown models: default true
  return true;
}

/**
 * Whether the model supports *interleaved* thinking — thinking blocks
 * between tool call turns. Required for the interleaved-thinking-2025-05-14
 * beta header.
 */
export function modelSupportsInterleavedThinking(model: string): boolean {
  const canonical = getCanonicalName(model);
  if (canonical.includes("claude-3-")) return false;
  // claude-opus-4 / claude-sonnet-4 and newer → supported
  if (canonical.includes("claude-opus-4") || canonical.includes("claude-sonnet-4")) {
    return true;
  }
  // Unknown models: default true
  return true;
}

/**
 * Whether the model supports the `output_config.effort` parameter.
 */
export function modelSupportsEffort(model: string): boolean {
  if (process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT) return true;
  const m = model.toLowerCase();
  if ((m.includes("opus") || m.includes("sonnet")) && isClaudeVersionAtLeast(model, 4, 6)) return true;
  if (m.includes("haiku") || m.includes("sonnet") || m.includes("opus")) return false;
  // Unknown: default true
  return true;
}

// ─── Default thinking switch ───────────────────────────────────────

/**
 * Whether extended thinking should be enabled by default for a new
 * session.
 *
 * Rules:
 *   - `MAX_THINKING_TOKENS=0` → disable
 *   - `MAX_THINKING_TOKENS=N` (N > 0) → enable with budget N
 *   - `settings.alwaysThinkingEnabled === false` → disable
 *   - Otherwise → enable (default-on)
 */
export function shouldEnableThinkingByDefault(): boolean {
  const env = process.env.MAX_THINKING_TOKENS;
  if (env !== undefined) {
    return parseInt(env, 10) > 0;
  }
  if (sessionAlwaysThinkingEnabled === false) {
    return false;
  }
  return true;
}

// ─── Session-level thinking + effort state ─────────────────────────
//
// In-memory session state mutated by the `/think` and `/effort` commands
// and seeded once at boot by configureThinkingDefaults().

let sessionAlwaysThinkingEnabled: boolean | undefined;
let sessionThinkingConfig: ThinkingConfig | undefined;
let sessionEffortLevel: EffortLevel | undefined;

/**
 * Seed the session thinking + effort state from settings.json at CLI
 * startup. Env vars always take precedence over settings (handled inside
 * buildDefaultThinkingConfig).
 */
export function configureThinkingDefaults(opts: { alwaysThinkingEnabled?: boolean; effortLevel?: EffortLevel }): void {
  if (opts.alwaysThinkingEnabled !== undefined) {
    sessionAlwaysThinkingEnabled = opts.alwaysThinkingEnabled;
  }
  if (opts.effortLevel !== undefined) {
    sessionEffortLevel = opts.effortLevel;
  }
}

/** The effort level to apply this session (undefined = model default). */
export function getSessionEffortLevel(): EffortLevel | undefined {
  return sessionEffortLevel;
}

/** Set the session effort level (from the `/effort` command). */
export function setSessionEffortLevel(level: EffortLevel | undefined): void {
  sessionEffortLevel = level;
}

/** Set the session thinking config (from the `/think` command). */
export function setSessionThinkingConfig(cfg: ThinkingConfig | undefined): void {
  sessionThinkingConfig = cfg;
}

/** The active session thinking config, if the user overrode it. */
export function getSessionThinkingConfig(): ThinkingConfig | undefined {
  return sessionThinkingConfig;
}

/**
 * Build the initial ThinkingConfig for a request.
 *
 * Precedence (highest first):
 *   1. `MAX_THINKING_TOKENS` env var (N>0 → enabled+budget, 0 → disabled)
 *   2. Session override set by the `/think` command
 *   3. `alwaysThinkingEnabled === false` (settings) → disabled
 *   4. Default → adaptive (model decides)
 */
export function buildDefaultThinkingConfig(): ThinkingConfig {
  const env = process.env.MAX_THINKING_TOKENS;
  if (env !== undefined) {
    const n = parseInt(env, 10);
    if (n <= 0) return { type: "disabled" };
    return { type: "enabled", budgetTokens: n };
  }
  if (sessionThinkingConfig) {
    return sessionThinkingConfig;
  }
  if (sessionAlwaysThinkingEnabled === false) {
    return { type: "disabled" };
  }
  return { type: "adaptive" };
}

// ─── ultrathink meta-message ───────────────────────────────────────

/**
 * The message injected by the ultrathink keyword path. It raises effort
 * for the current turn only; the thinking budget is unchanged.
 */
export const ULTRATHINK_META_MESSAGE =
  "The user has requested reasoning effort level: high. Apply this to the current turn.";
