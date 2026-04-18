// Spinner — breathing star + reverse-sweep shimmer.
// Mirrors Claude Code's `SpinnerAnimationRow` + `GlimmerMessage` + `SpinnerGlyph`:
//   - 50ms master clock, 120ms star frame, 200ms shimmer step
//   - Star cycles forward then reverse: · ✢ ✳ ✶ ✻ ✽ ✽ ✻ ✶ ✳ ✢ ·
//   - Shimmer is a 3-char window of `claudeShimmer` color sweeping right-to-left
//     across a `claude` orange base; window rests off-screen 10 ticks each end
//   - Verb is sampled once per mount from SPINNER_VERBS (overridable via prop)
//   - Suffix is a static U+2026 ellipsis (no animated dots — that's BriefSpinner)

import React, { useEffect, useState } from "react";
import { Text } from "ink";
import { sampleSpinnerVerb } from "../../constants/spinnerVerbs.js";

const STAR_CHARS = ["·", "✢", "✳", "✶", "✻", "✽"];
const SPINNER_FRAMES = [...STAR_CHARS, ...[...STAR_CHARS].reverse()];

const TICK_MS = 50;
const STAR_FRAME_MS = 120;
// Source uses 200ms for steady modes and 50ms for `requesting`. We pick
// 80ms — fast enough to read as a clear sweep, slow enough to stay calm.
const SHIMMER_STEP_MS = 80;
const SHIMMER_HALF_WIDTH = 1; // 3-char window: [glimmer-1, glimmer+1]
const REST_PADDING = 10;      // ticks the shimmer rests off each side

// Theme colors (utils/theme.ts → dark theme `claude` / `claudeShimmer`).
const COLOR_BASE = "#D77757";
const COLOR_SHIMMER = "#F59575";

// Sentinel: callers that pass "Thinking" want the random-verb behavior.
const DEFAULT_LABEL_SENTINEL = "Thinking";

interface SpinnerProps {
  label?: string;
}

export function Spinner({ label }: SpinnerProps): React.ReactNode {
  const [randomVerb] = useState(sampleSpinnerVerb);
  const verb = !label || label === DEFAULT_LABEL_SENTINEL ? randomVerb : label;
  const message = `${verb}\u2026`;

  const [time, setTime] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const timer = setInterval(() => setTime(Date.now() - start), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const starIndex = Math.floor(time / STAR_FRAME_MS) % SPINNER_FRAMES.length;
  const star = SPINNER_FRAMES[starIndex];

  const { before, shimmer, after } = sliceShimmer(message, time);

  return (
    <Text>
      <Text color={COLOR_BASE}>{star} </Text>
      {before ? <Text color={COLOR_BASE}>{before}</Text> : null}
      {shimmer ? <Text color={COLOR_SHIMMER}>{shimmer}</Text> : null}
      {after ? <Text color={COLOR_BASE}>{after}</Text> : null}
    </Text>
  );
}

// Right-to-left sweep, source `bridgeStatusUtil.ts::computeGlimmerIndex`:
//   cycleLength  = len + 2 * REST_PADDING
//   glimmerIndex = len + REST_PADDING - (tick % cycleLength)
function sliceShimmer(
  text: string,
  time: number,
): { before: string; shimmer: string; after: string } {
  const len = text.length;
  if (len === 0) return { before: "", shimmer: "", after: "" };

  const tick = Math.floor(time / SHIMMER_STEP_MS);
  const cycleLength = len + REST_PADDING * 2;
  const glimmerIndex = len + REST_PADDING - (tick % cycleLength);
  const start = glimmerIndex - SHIMMER_HALF_WIDTH;
  const endExcl = glimmerIndex + SHIMMER_HALF_WIDTH + 1;

  if (start >= len || endExcl <= 0) {
    return { before: text, shimmer: "", after: "" };
  }
  const s = Math.max(0, start);
  const e = Math.min(len, endExcl);
  return {
    before: text.slice(0, s),
    shimmer: text.slice(s, e),
    after: text.slice(e),
  };
}
