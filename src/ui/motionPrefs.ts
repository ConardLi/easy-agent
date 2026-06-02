/**
 * Reduced-motion preference (`prefersReducedMotion` setting).
 *
 * Animated UI (the spinner's breathing star + shimmer sweep) reads this through
 * a module-level flag rather than a setting read, because React render is sync
 * and frequent. The flag is snapshotted from settings at startup (see cli.ts).
 * When on, animated components render a calm static frame instead.
 */

let reducedMotion = false;

export function setReducedMotion(enabled: boolean): void {
  reducedMotion = enabled;
}

export function prefersReducedMotion(): boolean {
  return reducedMotion;
}
