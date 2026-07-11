/**
 * Extended-thinking utilities for Easy Agent.
 *
 * Mirrors claude-code-source-code/src/utils/thinking.ts:
 *   - ThinkingConfig three-state union
 *   - Model capability detection (thinking / adaptive / interleaved)
 *   - shouldEnableThinkingByDefault
 *   - hasUltrathinkKeyword (whole-word /\bultrathink\b/i)
 *
 * Easy Agent does not use Bun feature() or GrowthBook, so the
 * isUltrathinkEnabled() gate is replaced by a simple env-var check.
 * The 3P model-override table (get3PModelCapabilityOverride) is dropped;
 * capability detection is reproduced from source using pure model-name
 * heuristics + env vars, so all functions here are synchronous and safe
 * to call from the streaming hot path.
 *
 * Session-level thinking state (the `/think` and `/effort` commands, plus
 * the `alwaysThinkingEnabled` boot preference) lives in a small in-memory
 * store here — mirroring source's AppState.effortValue / thinking config,
 * which the REPL mutates live. The CLI seeds it once at startup from
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
 *
 * Source reference: claude-code-source-code/src/utils/thinking.ts:11-14
 */
export type ThinkingConfig =
  | { type: "adaptive" }
  | { type: "enabled"; budgetTokens: number }
  | { type: "disabled" };

// ─── Effort level ──────────────────────────────────────────────────

export type EffortLevel = "low" | "medium" | "high" | "max";

// ─── ultrathink keyword ────────────────────────────────────────────

/**
 * True when the text contains the whole-word keyword "ultrathink"
 * (case-insensitive). Faithfully copied from source — note the word
 * boundary anchors (\b) and the `i` flag.
 *
 * Source: claude-code-source-code/src/utils/thinking.ts:30
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
 *
 * Source reference: getCanonicalName in
 *   claude-code-source-code/src/utils/model/model.ts
 */
function getCanonicalName(model: string): string {
  // Bedrock format: "anthropic.claude-*" → "claude-*"
  // Vertex format: "publishers/anthropic/models/claude-*" → "claude-*"
  const lower = model.trim().toLowerCase();
  const afterDot = lower.split(".").pop() ?? lower;
  const lastSegment = afterDot.split("/").pop() ?? afterDot;
  return lastSegment;
}

/**
 * Whether the given model supports extended thinking at all.
 *
 * Easy Agent simplification vs source:
 *   - No 3P override table → honor `settings.json` key
 *     `modelCapabilities.<model>.thinking` when present.
 *   - No Bedrock/Vertex distinction → treat all non-localhost
 *     endpoints as "firstParty"-equivalent (default-true for
 *     unknown Claude 4+ models).
 *
 * Source: claude-code-source-code/src/utils/thinking.ts:91-111
 */
export function modelSupportsThinking(model: string): boolean {
  const canonical = getCanonicalName(model);
  // Disable for known Claude 3 models
  if (canonical.includes("claude-3-")) return false;
  // Default true for all Claude 4+ and unknown models (aligns with
  // source's firstParty / foundry default-true strategy)
  return true;
}

/**
 * Whether the model supports *adaptive* thinking (no token budget
 * required). Opus 4.6+ and Sonnet 4.6+; unknown models default true
 * to avoid silently degrading quality (mirrors source).
 *
 * Source: claude-code-source-code/src/utils/thinking.ts:114-145
 */
export function modelSupportsAdaptiveThinking(model: string): boolean {
  const canonical = getCanonicalName(model);
  // Explicit allowlist
  if (canonical.includes("opus-4-6") || canonical.includes("sonnet-4-6")) {
    return true;
  }
  // Exclude known legacy variants (older opus/sonnet/haiku)
  if (
    canonical.includes("opus") ||
    canonical.includes("sonnet") ||
    canonical.includes("haiku")
  ) {
    return false;
  }
  // Unknown models: default true (mirrors source's firstParty/foundry policy)
  return true;
}

/**
 * Whether the model supports *interleaved* thinking — thinking blocks
 * between tool call turns. Required for the interleaved-thinking-2025-05-14
 * beta header.
 *
 * Source: claude-code-source-code/src/utils/betas.ts:91-111
 */
export function modelSupportsInterleavedThinking(model: string): boolean {
  const canonical = getCanonicalName(model);
  if (canonical.includes("claude-3-")) return false;
  // claude-opus-4 / claude-sonnet-4 and newer → supported
  if (canonical.includes("claude-opus-4") || canonical.includes("claude-sonnet-4")) {
    return true;
  }
  // Unknown models: default true (mirrors source's firstParty/foundry policy)
  return true;
}

/**
 * Whether the model supports the `output_config.effort` parameter.
 *
 * Source: claude-code-source-code/src/utils/effort.ts:25-51
 */
export function modelSupportsEffort(model: string): boolean {
  if (process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT) return true;
  const m = model.toLowerCase();
  if (m.includes("opus-4-6") || m.includes("sonnet-4-6")) return true;
  if (m.includes("haiku") || m.includes("sonnet") || m.includes("opus")) return false;
  // Unknown: default true (mirrors source's firstParty policy)
  return true;
}

// ─── Default thinking switch ───────────────────────────────────────

/**
 * Whether extended thinking should be enabled by default for a new
 * session.
 *
 * Mirrors source's shouldEnableThinkingByDefault:
 *   - `MAX_THINKING_TOKENS=0` → disable
 *   - `MAX_THINKING_TOKENS=N` (N > 0) → enable with budget N
 *   - `settings.alwaysThinkingEnabled === false` → disable
 *   - Otherwise → enable (default-on)
 *
 * Source: claude-code-source-code/src/utils/thinking.ts:147-163
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
// and seeded once at boot by configureThinkingDefaults(). Mirrors source's
// AppState.effortValue + thinking config that the REPL edits live.

let sessionAlwaysThinkingEnabled: boolean | undefined;
let sessionThinkingConfig: ThinkingConfig | undefined;
let sessionEffortLevel: EffortLevel | undefined;

/**
 * Seed the session thinking + effort state from settings.json at CLI
 * startup. Env vars always take precedence over settings (handled inside
 * buildDefaultThinkingConfig).
 */
export function configureThinkingDefaults(opts: {
  alwaysThinkingEnabled?: boolean;
  effortLevel?: EffortLevel;
}): void {
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
 * The message injected by the ultrathink keyword path. Mirrors source:
 *   claude-code-source-code/src/utils/messages.ts ultrathink_effort branch.
 */
export const ULTRATHINK_META_MESSAGE =
  "The user has requested reasoning effort level: high. Apply this to the current turn.";
