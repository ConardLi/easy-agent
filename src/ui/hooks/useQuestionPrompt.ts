/**
 * Keyboard state machine for the AskUserQuestion dialog.
 *
 * Layout:
 *   - the model's options are a numbered list,
 *   - followed by a free-text "Type something" row (the user can type their
 *     own answer instead of picking),
 *   - followed by a "Chat about this instead" row that cancels the dialog so
 *     the user can reply normally.
 *
 * Keys:
 *   ↑/↓        move the highlight across all rows
 *   1-9        jump to that numbered option (option rows only)
 *   Space      toggle the highlighted option (multi-select only)
 *   <type>     when the "Type something" row is focused, edit the free text
 *   Enter      confirm → advance, or finish on the last question
 *   Esc        cancel the whole interaction (resolve null)
 */
import { useEffect, useRef, useState } from "react";
import { useInput } from "ink";
import type { UserQuestionRequest, UserQuestionResponse } from "../../tools/Tool.js";

interface UseQuestionPromptOptions {
  request: UserQuestionRequest | null;
  onResolve: (response: UserQuestionResponse | null) => void;
}

export interface QuestionPromptView {
  questionIndex: number;
  /** Highlighted row: 0..N-1 options, N = text input, N+1 = "chat instead". */
  highlight: number;
  /** Selected option indices (multi-select only). */
  selected: ReadonlySet<number>;
  /** Current free-text buffer for the "Type something" row. */
  textInput: string;
}

export function useQuestionPrompt({
  request,
  onResolve,
}: UseQuestionPromptOptions): QuestionPromptView {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [textInput, setTextInput] = useState("");
  const answersRef = useRef<Record<string, string>>({});

  const active = request !== null;

  // Reset everything when a fresh batch of questions arrives.
  useEffect(() => {
    setQuestionIndex(0);
    setHighlight(0);
    setSelected(new Set());
    setTextInput("");
    answersRef.current = {};
  }, [request]);

  useInput(
    (input, key) => {
      if (!request) return;
      const question = request.questions[questionIndex];
      if (!question) return;

      const optionCount = question.options.length;
      const inputRow = optionCount; // "Type something"
      const chatRow = optionCount + 1; // "Chat about this instead"
      const rowCount = optionCount + 2;

      if (key.escape) {
        onResolve(null);
        return;
      }
      if (key.upArrow) {
        setHighlight((h) => (h <= 0 ? rowCount - 1 : h - 1));
        return;
      }
      if (key.downArrow) {
        setHighlight((h) => (h >= rowCount - 1 ? 0 : h + 1));
        return;
      }

      const advance = (answer: string) => {
        answersRef.current[question.question] = answer;
        if (questionIndex >= request.questions.length - 1) {
          onResolve({ answers: { ...answersRef.current } });
        } else {
          setQuestionIndex((q) => q + 1);
          setHighlight(0);
          setSelected(new Set());
          setTextInput("");
        }
      };

      // ── "Chat about this instead" row ──────────────────────────────
      if (highlight === chatRow) {
        if (key.return) onResolve(null);
        return;
      }

      // ── Free-text input row ────────────────────────────────────────
      if (highlight === inputRow) {
        if (key.return) {
          const text = textInput.trim();
          if (text) advance(text);
          return;
        }
        if (key.backspace || key.delete) {
          setTextInput((t) => t.slice(0, -1));
          return;
        }
        if (input && !key.ctrl && !key.meta && !key.tab) {
          setTextInput((t) => t + input);
        }
        return;
      }

      // ── A numbered option row ──────────────────────────────────────
      const digit = Number(input);
      if (Number.isInteger(digit) && digit >= 1 && digit <= optionCount) {
        setHighlight(digit - 1);
        return;
      }

      if (question.multiSelect && input === " ") {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(highlight)) next.delete(highlight);
          else next.add(highlight);
          return next;
        });
        return;
      }

      if (key.return) {
        if (question.multiSelect) {
          const labels = [...selected].sort((a, b) => a - b).map((i) => question.options[i]!.label);
          if (textInput.trim()) labels.push(textInput.trim());
          if (labels.length === 0) labels.push(question.options[highlight]!.label);
          advance(labels.join(", "));
        } else {
          advance(question.options[highlight]!.label);
        }
      }
    },
    { isActive: active },
  );

  return { questionIndex, highlight, selected, textInput };
}
