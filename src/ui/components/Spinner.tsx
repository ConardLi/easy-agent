/**
 * Spinner — Animated loading indicator using React/Ink.
 *
 * Replaces the raw ANSI escape code spinner from Phase 2.
 * Ink handles cursor management and re-rendering automatically.
 */

import React, { useState, useEffect } from "react";
import { Text } from "ink";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface SpinnerProps {
  label?: string;
}

export function Spinner({ label = "Thinking" }: SpinnerProps): React.ReactNode {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  return (
    <Text dimColor>
      {FRAMES[frameIndex]} {label}…
    </Text>
  );
}
