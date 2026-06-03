/**
 * Auto Mode runtime state — session-scoped, in-memory, reset on restart.
 *
 * Reference: claude-code-source-code/src/utils/permissions/denialTracking.ts
 * (consecutive/total denial limits) and autoModeState.ts (circuit breaker).
 *
 * Two independent safety mechanisms layer on top of the AI classifier:
 *
 *  1. Denial tracking — when the classifier blocks N actions in a row (or M
 *     total), stop silently denying and hand control back to the human (the
 *     decision degrades from `deny` to `ask`). "The classifier keeps blocking,
 *     let the user decide."
 *
 *  2. Circuit breaker — when the classifier *fails* (API/parse errors) N times
 *     in a row, disable it for the rest of the session and fall back to manual
 *     (default-mode) permission handling, notifying the user once.
 *
 * These are deliberately separate: a *denial* is a working classifier saying
 * "no"; a *failure* is the classifier being unusable.
 */

import { logWarn } from "../utils/log.js";

export const DENIAL_LIMITS = {
  maxConsecutive: 3,
  maxTotal: 20,
} as const;

/** Consecutive classifier failures that trip the circuit breaker. */
export const CLASSIFIER_FAILURE_LIMIT = 3;

interface AutoModeState {
  consecutiveDenials: number;
  totalDenials: number;
  consecutiveFailures: number;
  circuitBroken: boolean;
  circuitBreakNotified: boolean;
}

const state: AutoModeState = {
  consecutiveDenials: 0,
  totalDenials: 0,
  consecutiveFailures: 0,
  circuitBroken: false,
  circuitBreakNotified: false,
};

// ── Denial tracking ────────────────────────────────────────────────

/** Record a classifier block. */
export function recordClassifierDenial(): void {
  state.consecutiveDenials += 1;
  state.totalDenials += 1;
}

/** Record a classifier allow — clears the consecutive-denial streak. */
export function recordClassifierSuccess(): void {
  state.consecutiveDenials = 0;
  // A successful classification proves it's working again.
  state.consecutiveFailures = 0;
}

/**
 * True when the classifier has blocked enough actions that we should stop
 * auto-denying and ask the human instead.
 */
export function shouldFallbackToPrompting(): boolean {
  return (
    state.consecutiveDenials >= DENIAL_LIMITS.maxConsecutive ||
    state.totalDenials >= DENIAL_LIMITS.maxTotal
  );
}

// ── Circuit breaker ────────────────────────────────────────────────

/**
 * Record a classifier failure (API error / malformed verdict). Trips the
 * circuit breaker once failures pile up; once broken it stays broken for the
 * session (no mid-session flapping).
 */
export function recordClassifierFailure(): void {
  state.consecutiveFailures += 1;
  if (
    !state.circuitBroken &&
    state.consecutiveFailures >= CLASSIFIER_FAILURE_LIMIT
  ) {
    state.circuitBroken = true;
  }
}

export function isAutoModeCircuitBroken(): boolean {
  return state.circuitBroken;
}

/**
 * Emit the "classifier disabled, falling back to manual" warning exactly once
 * per session. Call this when a circuit-broken auto-mode check degrades to
 * default handling.
 */
export function notifyCircuitBreakOnce(): void {
  if (state.circuitBreakNotified) return;
  state.circuitBreakNotified = true;
  logWarn(
    "Auto Mode classifier disabled after repeated failures — falling back to manual confirmation for the rest of this session.",
  );
}

// ── Testing / lifecycle ────────────────────────────────────────────

export function resetAutoModeState(): void {
  state.consecutiveDenials = 0;
  state.totalDenials = 0;
  state.consecutiveFailures = 0;
  state.circuitBroken = false;
  state.circuitBreakNotified = false;
}

export function getAutoModeStateSnapshot(): Readonly<AutoModeState> {
  return { ...state };
}
