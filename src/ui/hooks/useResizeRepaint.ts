/**
 * Full repaint after the terminal width changes.
 *
 * Ink redraws the live frame by erasing as many rows as it last wrote. When
 * the window gets narrower, the terminal re-wraps the rows already on screen:
 * a full-width rule (the input box border) now spans two rows, so the frame
 * occupies more rows than Ink erases and its top rows (the token usage line)
 * are left behind as stale copies — one per resize. History printed through
 * <Static> is never repainted, so it keeps the old width as well.
 *
 * On a width change we wipe the screen and scrollback, then return a new
 * epoch that App uses as the <Static> key: the remounted <Static> prints the
 * whole history again at the new width, and Ink draws the live frame below
 * it. Drag-resizing emits a burst of events, so the repaint waits until the
 * size settles; returning to the original width mid-burst still repaints,
 * because the intermediate narrow frames already left rows behind.
 */
import { useEffect, useState } from "react";
import { useStdout } from "ink";
import { CLEAR_TERMINAL } from "./useAgentSession/notices.js";

export const RESIZE_SETTLE_MS = 120;

export function useResizeRepaint(): number {
  const { stdout, write } = useStdout();
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    if (!stdout.isTTY) return;
    let columns = stdout.columns;
    let widthChanged = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onResize = () => {
      if (stdout.columns !== columns) {
        columns = stdout.columns;
        widthChanged = true;
      }
      if (!widthChanged) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        widthChanged = false;
        // Ink's write() erases the live frame, emits the escape, then draws
        // the frame again at the top; the <Static> remount below lands above it.
        write(CLEAR_TERMINAL);
        setEpoch((n) => n + 1);
      }, RESIZE_SETTLE_MS);
    };

    stdout.on("resize", onResize);
    return () => {
      clearTimeout(timer);
      stdout.off("resize", onResize);
    };
  }, [stdout, write]);

  return epoch;
}
