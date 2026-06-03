import { useCallback, useRef, useState } from "react";
import type { Key } from "ink";

/**
 * useTextInput — a real terminal line editor.
 *
 * Owns a text buffer + cursor index and the full set of editing operations a
 * user expects from a shell prompt: insert / delete at an arbitrary cursor,
 * word- and line-wise navigation and kills, and multi-line support (the buffer
 * may contain `\n`, and ↑/↓ move between visual lines). This is the lower layer
 * the plan calls for — `usePromptInput` keeps the routing / suggestion logic
 * and delegates raw editing here.
 *
 * `handleKey(input, key)` returns true if it consumed the event so the caller
 * can let higher-priority handlers (command palette, mode selector) win first.
 */

export interface TextInputState {
  value: string;
  cursor: number;
}

export interface UseTextInputOptions {
  /**
   * Called when ↑ is pressed while the cursor sits on the FIRST line. Return
   * the previous history entry to load (cursor goes to end), or null for none.
   */
  onHistoryPrev?: (current: string) => string | null;
  /** Called when ↓ is pressed on the LAST line. Return entry / "" / null. */
  onHistoryNext?: (current: string) => string | null;
  /** Called when Enter submits. */
  onSubmit?: (value: string) => void;
}

function lineBounds(value: string, cursor: number): { lineStart: number; lineEnd: number } {
  let lineStart = cursor;
  while (lineStart > 0 && value[lineStart - 1] !== "\n") lineStart--;
  let lineEnd = cursor;
  while (lineEnd < value.length && value[lineEnd] !== "\n") lineEnd++;
  return { lineStart, lineEnd };
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /\S/.test(ch);
}

function normalizeInsertedText(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function useTextInput(options: UseTextInputOptions = {}) {
  const { onHistoryPrev, onHistoryNext, onSubmit } = options;
  const [value, setValueRaw] = useState("");
  const [cursor, setCursor] = useState(0);

  // Ref mirrors so functional updates / event handlers always read the latest
  // value+cursor without a stale closure. Updated on every render (cheap) so a
  // read inside the same tick as a setState is still coherent.
  const valueRef = useRef(value);
  const cursorRef = useRef(cursor);
  valueRef.current = value;
  cursorRef.current = cursor;

  /** Apply a coherent (value, cursor) transform in one shot. */
  const apply = useCallback((fn: (s: TextInputState) => TextInputState) => {
    const next = fn({ value: valueRef.current, cursor: cursorRef.current });
    valueRef.current = next.value;
    cursorRef.current = next.cursor;
    setValueRaw(next.value);
    setCursor(next.cursor);
  }, []);

  const setValue = useCallback((next: string, cursorToEnd = true) => {
    valueRef.current = next;
    const c = cursorToEnd ? next.length : Math.min(cursorRef.current, next.length);
    cursorRef.current = c;
    setValueRaw(next);
    setCursor(c);
  }, []);

  /** Replace the buffer and place the cursor at an explicit offset. */
  const setValueAndCursor = useCallback((next: string, cursorAt: number) => {
    const c = Math.max(0, Math.min(cursorAt, next.length));
    valueRef.current = next;
    cursorRef.current = c;
    setValueRaw(next);
    setCursor(c);
  }, []);

  const clear = useCallback(() => {
    valueRef.current = "";
    cursorRef.current = 0;
    setValueRaw("");
    setCursor(0);
  }, []);

  const insertNewline = useCallback(() => {
    apply((s) => ({
      value: s.value.slice(0, s.cursor) + "\n" + s.value.slice(s.cursor),
      cursor: s.cursor + 1,
    }));
  }, [apply]);

  const handleKey = useCallback(
    (input: string, key: Key): boolean => {
      // ── Submit / newline ─────────────────────────────────────────────
      if (key.return) {
        // Option/Alt+Enter inserts a newline.
        if (key.meta) {
          insertNewline();
          return true;
        }
        // A trailing backslash is a line-continuation: drop it, add newline.
        if (valueRef.current.endsWith("\\")) {
          apply((s) => {
            const trimmed = s.value.slice(0, -1) + "\n";
            return { value: trimmed, cursor: trimmed.length };
          });
          return true;
        }
        onSubmit?.(valueRef.current);
        return true;
      }
      if (key.ctrl && input === "j") {
        insertNewline();
        return true;
      }

      // ── Deletion ─────────────────────────────────────────────────────
      if (key.backspace || (key.delete && !key.meta)) {
        apply((s) =>
          s.cursor === 0
            ? s
            : { value: s.value.slice(0, s.cursor - 1) + s.value.slice(s.cursor), cursor: s.cursor - 1 },
        );
        return true;
      }
      if (key.ctrl && input === "w") {
        apply((s) => {
          let i = s.cursor;
          while (i > 0 && !isWordChar(s.value[i - 1])) i--;
          while (i > 0 && isWordChar(s.value[i - 1])) i--;
          return { value: s.value.slice(0, i) + s.value.slice(s.cursor), cursor: i };
        });
        return true;
      }
      if (key.ctrl && input === "u") {
        apply((s) => {
          const { lineStart } = lineBounds(s.value, s.cursor);
          return { value: s.value.slice(0, lineStart) + s.value.slice(s.cursor), cursor: lineStart };
        });
        return true;
      }
      if (key.ctrl && input === "k") {
        apply((s) => {
          const { lineEnd } = lineBounds(s.value, s.cursor);
          return { value: s.value.slice(0, s.cursor) + s.value.slice(lineEnd), cursor: s.cursor };
        });
        return true;
      }

      // ── Horizontal navigation ────────────────────────────────────────
      if (key.leftArrow) {
        if (key.meta || key.ctrl) {
          apply((s) => {
            let i = s.cursor;
            while (i > 0 && !isWordChar(s.value[i - 1])) i--;
            while (i > 0 && isWordChar(s.value[i - 1])) i--;
            return { ...s, cursor: i };
          });
        } else {
          apply((s) => ({ ...s, cursor: Math.max(0, s.cursor - 1) }));
        }
        return true;
      }
      if (key.rightArrow) {
        if (key.meta || key.ctrl) {
          apply((s) => {
            let i = s.cursor;
            while (i < s.value.length && !isWordChar(s.value[i])) i++;
            while (i < s.value.length && isWordChar(s.value[i])) i++;
            return { ...s, cursor: i };
          });
        } else {
          apply((s) => ({ ...s, cursor: Math.min(s.value.length, s.cursor + 1) }));
        }
        return true;
      }
      if (key.ctrl && input === "a") {
        apply((s) => ({ ...s, cursor: lineBounds(s.value, s.cursor).lineStart }));
        return true;
      }
      if (key.ctrl && input === "e") {
        apply((s) => ({ ...s, cursor: lineBounds(s.value, s.cursor).lineEnd }));
        return true;
      }

      // ── Vertical navigation / history ────────────────────────────────
      if (key.upArrow) {
        const { lineStart } = lineBounds(valueRef.current, cursorRef.current);
        if (lineStart === 0) {
          const entry = onHistoryPrev?.(valueRef.current);
          if (entry != null) setValue(entry, true);
          return true;
        }
        apply((s) => {
          const { lineStart: ls } = lineBounds(s.value, s.cursor);
          const col = s.cursor - ls;
          const prevEnd = ls - 1;
          const { lineStart: prevStart } = lineBounds(s.value, prevEnd);
          const prevLen = prevEnd - prevStart;
          return { ...s, cursor: prevStart + Math.min(col, prevLen) };
        });
        return true;
      }
      if (key.downArrow) {
        const { lineEnd } = lineBounds(valueRef.current, cursorRef.current);
        if (lineEnd === valueRef.current.length) {
          const entry = onHistoryNext?.(valueRef.current);
          if (entry != null) setValue(entry, true);
          return true;
        }
        apply((s) => {
          const { lineStart: ls, lineEnd: le } = lineBounds(s.value, s.cursor);
          const col = s.cursor - ls;
          const nextStart = le + 1;
          const { lineEnd: nextEnd } = lineBounds(s.value, nextStart);
          const nextLen = nextEnd - nextStart;
          return { ...s, cursor: nextStart + Math.min(col, nextLen) };
        });
        return true;
      }

      // ── Printable insertion (handles pasted multi-char chunks too) ────
      if (input && !key.ctrl && !key.meta) {
        const inserted = normalizeInsertedText(input);
        apply((s) => ({
          value: s.value.slice(0, s.cursor) + inserted + s.value.slice(s.cursor),
          cursor: s.cursor + inserted.length,
        }));
        return true;
      }

      return false;
    },
    [apply, insertNewline, setValue, onHistoryPrev, onHistoryNext, onSubmit],
  );

  return { value, cursor, setValue, setValueAndCursor, clear, handleKey };
}
