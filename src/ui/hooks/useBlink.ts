/**
 * Shared blink clock for in-flight tool dots.
 *
 * While a tool is unresolved its `●` status dot blinks. The catch (called
 * out in App.tsx) is that every independent setInterval triggers another
 * full terminal repaint, so instead of one timer per card we
 * keep a SINGLE module-level timer that many dots subscribe to via
 * useSyncExternalStore. The timer only runs while at least one dot is pending,
 * and stops itself when the last subscriber unmounts.
 */
import { useSyncExternalStore } from "react";

const BLINK_MS = 480;

let visible = true;
let timer: ReturnType<typeof setInterval> | null = null;
const subscribers = new Set<() => void>();

function start(): void {
  if (timer) return;
  timer = setInterval(() => {
    visible = !visible;
    for (const cb of subscribers) cb();
  }, BLINK_MS);
}

function stop(): void {
  if (subscribers.size === 0 && timer) {
    clearInterval(timer);
    timer = null;
    visible = true; // reset so the next pending dot starts solid
  }
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  start();
  return () => {
    subscribers.delete(cb);
    stop();
  };
}

const NOOP = () => () => {};

/**
 * Returns whether the dot should be drawn this frame. When `active` is false
 * (resolved tool) it always returns true (solid) and never subscribes, so
 * archived <Static> cards don't keep the timer alive.
 */
export function useBlink(active: boolean): boolean {
  return useSyncExternalStore(
    active ? subscribe : NOOP,
    () => (active ? visible : true),
    () => true,
  );
}
