import { isMac } from "../../design/primitives";

/**
 * Room for the traffic lights macOS draws here (`trafficLightPosition` in
 * main/window.ts). Windows and Linux draw their buttons at the right end of
 * the top bar instead.
 */
export function WindowControls() {
  if (!isMac) return null;
  return <div data-visual-mask className="no-drag h-3 w-14 shrink-0" />;
}
