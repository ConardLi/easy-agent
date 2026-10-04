/**
 * Keyboard + scroll state for the Ctrl+O transcript overlay.
 *
 * Owns the keyboard while the transcript is open (a pager: ↑/↓ line,
 * PgUp/PgDn page, g/G top/bottom, Esc / Ctrl+O / q to close). Returns the
 * current scroll offset, clamped to the content; the overlay slices the line
 * array at this offset to draw a window — that's the "virtual scrolling".
 *
 * Also drives incremental in-transcript search: `/` opens a query line, typing
 * jumps to the first match live, Enter locks it in, and n/N cycle matches.
 *
 * Mouse wheel: while open we enable SGR mouse tracking (DEC 1000/1006) so the
 * terminal routes wheel events to the app instead of its native scrollback —
 * otherwise the wheel "scrolls out" of the overlay and reveals the condensed
 * history underneath. Events are parsed off the same useInput stream and drive
 * the scroll, then tracking is disabled on close (and as an exit safety net).
 */
import { useEffect, useMemo, useState } from "react";
import { useInput, useStdout } from "ink";

// SGR mouse tracking: 1000 = button (incl. wheel) events, 1006 = extended
// coords so events arrive as `CSI < b ; x ; y (M|m)`. Enable/disable as a pair.
const MOUSE_ON = "\u001B[?1000h\u001B[?1006h";
const MOUSE_OFF = "\u001B[?1006l\u001B[?1000l";
// Ink strips the leading ESC before delivering an unrecognized CSI to useInput,
// so a wheel press reaches us as e.g. "[<64;10;20M" (M = press; we ignore the
// `m` release, which the wheel doesn't emit anyway).
const WHEEL_RE = /^\[<(\d+);\d+;\d+M$/;
const WHEEL_STEP = 3;

/**
 * Decode an Ink-delivered input string into a vertical scroll delta (rows).
 * Returns 0 for anything that isn't a vertical mouse-wheel press.
 *
 * SGR button codes: bit 6 (64) flags the wheel; the low two bits are the
 * button number (0 = wheel up, 1 = wheel down, 2/3 = horizontal wheel, which we
 * ignore). Modifier bits (shift/meta/ctrl) live higher up and are ignored, so
 * Shift+wheel etc. still scroll.
 */
export function wheelScrollDelta(input: string, step = WHEEL_STEP): number {
  const match = WHEEL_RE.exec(input);
  if (!match) return 0;
  const button = Number(match[1]);
  if ((button & 64) === 0) return 0;
  const direction = button & 3;
  if (direction === 0) return -step; // wheel up
  if (direction === 1) return step; // wheel down
  return 0; // horizontal wheel — no vertical movement
}

interface UseTranscriptOptions {
  open: boolean;
  /** The full transcript lines (used for scrolling bounds + search matching). */
  lines: string[];
  viewportHeight: number;
  onClose: () => void;
}

export interface TranscriptSearchState {
  /** True while the user is typing a query (`/` mode). */
  active: boolean;
  query: string;
  matchCount: number;
  /** 1-based index of the current match, or 0 when none. */
  matchOrdinal: number;
}

export interface UseTranscriptResult {
  scroll: number;
  search: TranscriptSearchState;
}

const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]|\u001b\]8;;[^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function computeMatches(lines: string[], query: string): number[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (
      stripAnsi(lines[i] ?? "")
        .toLowerCase()
        .includes(q)
    )
      out.push(i);
  }
  return out;
}

export function useTranscript({ open, lines, viewportHeight, onClose }: UseTranscriptOptions): UseTranscriptResult {
  const { stdout } = useStdout();
  const totalLines = lines.length;
  const maxScroll = Math.max(0, totalLines - viewportHeight);
  const [scroll, setScroll] = useState(0);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);

  const clamp = (n: number) => Math.max(0, Math.min(maxScroll, n));
  // Position a matched line a couple rows below the header for context.
  const scrollToLine = (line: number) => setScroll(clamp(line - 2));

  const matches = useMemo(() => computeMatches(lines, query), [lines, query]);

  // Capture the mouse wheel while open: enable SGR tracking so wheel events go
  // to the app (not native scrollback), and disable on close. We write the mode
  // escapes straight to the stream — they produce no visible output, so they
  // don't disturb Ink's frame. A one-shot process-exit handler is the safety
  // net so a crash/SIGINT can't strand the terminal in mouse-reporting mode.
  useEffect(() => {
    if (!open || !stdout?.isTTY) return;
    const restore = () => {
      try {
        stdout.write(MOUSE_OFF);
      } catch {
        // stream may already be torn down during shutdown — best effort.
      }
    };
    stdout.write(MOUSE_ON);
    process.once("exit", restore);
    return () => {
      process.removeListener("exit", restore);
      restore();
    };
  }, [open, stdout]);

  // Open at the bottom (most recent) — that's where the user just was. Also
  // resets any prior search so each open starts clean.
  useEffect(() => {
    if (open) {
      setScroll(Math.max(0, totalLines - viewportHeight));
      setSearching(false);
      setQuery("");
      setMatchIdx(0);
    }
  }, [open, totalLines, viewportHeight]);

  // Incremental jump: as the query changes, hop to the first match.
  useEffect(() => {
    if (!query || matches.length === 0) return;
    setMatchIdx(0);
    scrollToLine(matches[0] ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches]);

  useInput(
    (input, key) => {
      // ── Mouse wheel ────────────────────────────────────────────────────
      // Handled first so wheel bytes are consumed before the search/pager
      // branches (otherwise the raw sequence would be typed into a query).
      if (WHEEL_RE.test(input)) {
        const delta = wheelScrollDelta(input);
        if (delta !== 0) setScroll((s) => clamp(s + delta));
        return;
      }

      // ── Search-entry mode: keystrokes build the query ──────────────────
      if (searching) {
        if (key.escape) {
          setSearching(false);
          setQuery("");
          setMatchIdx(0);
          return;
        }
        if (key.return) {
          // Lock in the query; n/N now cycle. Keep matches highlighted.
          setSearching(false);
          return;
        }
        if (key.backspace || key.delete) {
          setQuery((q) => q.slice(0, -1));
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          setQuery((q) => q + input);
          return;
        }
        return;
      }

      // ── Pager mode ─────────────────────────────────────────────────────
      if (key.escape || (key.ctrl && input === "o") || input === "\x0f" || input === "q") {
        onClose();
        return;
      }
      if (input === "/") {
        setSearching(true);
        setQuery("");
        setMatchIdx(0);
        return;
      }
      if (input === "n" && matches.length > 0) {
        const ni = (matchIdx + 1) % matches.length;
        setMatchIdx(ni);
        scrollToLine(matches[ni] ?? 0);
        return;
      }
      if (input === "N" && matches.length > 0) {
        const ni = (matchIdx - 1 + matches.length) % matches.length;
        setMatchIdx(ni);
        scrollToLine(matches[ni] ?? 0);
        return;
      }
      if (key.upArrow || input === "k") {
        setScroll((s) => clamp(s - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setScroll((s) => clamp(s + 1));
        return;
      }
      if (key.pageUp || (key.ctrl && input === "b")) {
        setScroll((s) => clamp(s - viewportHeight));
        return;
      }
      if (key.pageDown || (key.ctrl && input === "f") || input === " ") {
        setScroll((s) => clamp(s + viewportHeight));
        return;
      }
      if (input === "g") {
        setScroll(0);
        return;
      }
      if (input === "G") {
        setScroll(maxScroll);
      }
    },
    { isActive: open },
  );

  return {
    scroll: clamp(scroll),
    search: {
      active: searching,
      query,
      matchCount: matches.length,
      matchOrdinal: matches.length > 0 ? matchIdx + 1 : 0,
    },
  };
}
