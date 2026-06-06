/**
 * useMemoryPicker — keyboard handler for the `/memory` picker overlay (↑/↓ to
 * move, 1-9 to quick-pick, Enter to open in $EDITOR, Esc to cancel).
 *
 * Mounted in App.tsx alongside the other overlay hooks. It owns the keyboard
 * only while the picker is open; usePromptInput is told (via the combined
 * overlay flag) to swallow keystrokes so nothing leaks into the prompt buffer.
 *
 * Selection doesn't open the editor directly — it calls back into the agent
 * session, which re-invokes `/memory edit <n>` through the engine so the
 * existing $EDITOR launch (open_editor) does the real work.
 */

import { useCallback } from "react";
import { useInput } from "ink";
import type { MemoryPickerItem } from "../../core/queryEngine.js";

interface UseMemoryPickerParams {
  /** The open picker's items, or null when no picker is showing. */
  items: MemoryPickerItem[] | null;
  /** Current cursor position into `items`. */
  index: number;
  /** Higher-priority handler active (permission/question prompt) → stand down. */
  disabled: boolean;
  /** Move the cursor to `nextIndex`. */
  onMove: (nextIndex: number) => void;
  /** Open the item at `pickIndex` in $EDITOR. */
  onSelect: (pickIndex: number) => void;
  /** Dismiss the picker without opening anything. */
  onCancel: () => void;
}

export function useMemoryPicker({
  items,
  index,
  disabled,
  onMove,
  onSelect,
  onCancel,
}: UseMemoryPickerParams): void {
  const active = !disabled && !!items && items.length > 0;

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
      if (!active || !items) return;
      if (key.ctrl || key.meta) return;

      if (key.escape) {
        onCancel();
        return;
      }
      if (key.upArrow) {
        onMove((index - 1 + items.length) % items.length);
        return;
      }
      if (key.downArrow) {
        onMove((index + 1) % items.length);
        return;
      }
      if (key.return) {
        onSelect(index);
        return;
      }
      if (/^[1-9]$/.test(input)) {
        const pick = Number(input) - 1;
        if (pick < items.length) onSelect(pick);
      }
    },
    [active, items, index, onMove, onSelect, onCancel],
  );

  useInput(handleInput, { isActive: active });
}
