/**
 * useResumePicker — keyboard handler for the `/resume` session picker overlay
 * (↑/↓ to move, 1-9 to quick-pick, Enter to resume, Esc to cancel).
 *
 * Mounted once in App.tsx alongside useTeammateNavigation. It owns the keyboard
 * only while a picker is open; usePromptInput is told (via `hasResumePicker`) to
 * swallow keystrokes so nothing leaks into the hidden prompt buffer behind it.
 *
 * Selection doesn't switch the session directly here — it calls back into the
 * agent session, which re-invokes `/resume <id>` through the engine so the
 * existing in-process switch (session_switched) does the real work.
 */

import { useCallback } from "react";
import { useInput } from "ink";
import type { ResumeSessionInfo } from "../../core/queryEngine.js";

interface UseResumePickerParams {
  /** The open picker's sessions, or null when no picker is showing. */
  sessions: ResumeSessionInfo[] | null;
  /** Current cursor position into `sessions`. */
  index: number;
  /** Higher-priority handler active (permission/question prompt) → stand down. */
  disabled: boolean;
  /** Move the cursor by `delta` (clamped by the caller's setter). */
  onMove: (nextIndex: number) => void;
  /** Resume the session at `pickIndex`. */
  onSelect: (pickIndex: number) => void;
  /** Dismiss the picker without switching. */
  onCancel: () => void;
}

export function useResumePicker({
  sessions,
  index,
  disabled,
  onMove,
  onSelect,
  onCancel,
}: UseResumePickerParams): void {
  const active = !disabled && !!sessions && sessions.length > 0;

  const handleInput = useCallback(
    (
      input: string,
      key: {
        upArrow?: boolean;
        downArrow?: boolean;
        return?: boolean;
        escape?: boolean;
        ctrl?: boolean;
        meta?: boolean;
      },
    ) => {
      if (!active || !sessions) return;
      if (key.ctrl || key.meta) return;

      if (key.escape) {
        onCancel();
        return;
      }
      if (key.upArrow) {
        onMove((index - 1 + sessions.length) % sessions.length);
        return;
      }
      if (key.downArrow) {
        onMove((index + 1) % sessions.length);
        return;
      }
      if (key.return) {
        onSelect(index);
        return;
      }
      // 1-9 quick-pick: jump straight to that row and resume it.
      if (/^[1-9]$/.test(input)) {
        const pick = Number(input) - 1;
        if (pick < sessions.length) onSelect(pick);
      }
    },
    [active, sessions, index, onMove, onSelect, onCancel],
  );

  useInput(handleInput, { isActive: active });
}
