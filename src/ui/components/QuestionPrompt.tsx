/**
 * Interactive multiple-choice dialog for the AskUserQuestion tool.
 *
 * Renders ONE question at a time:
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  Library   question 1/2                                   │  ← header chip
 *   │                                                           │
 *   │  Which date library should we use?                        │  ← question (wraps)
 *   │                                                           │
 *   │  › 1. date-fns                                            │  ← highlighted
 *   │       Tree-shakeable, modern; great for new code          │  ← description (wraps)
 *   │    2. dayjs                                               │
 *   │       Tiny, Moment-compatible API                         │
 *   │  ──────────────────────────────────────────────────────  │
 *   │    3. Type something.                                     │  ← free-text input
 *   │    4. Chat about this instead                             │  ← cancel / reply normally
 *   │                                                           │
 *   │  Enter to select · ↑/↓ to navigate · Esc to cancel        │
 *   └──────────────────────────────────────────────────────────┘
 *
 * The keyboard state machine lives in `useQuestionPrompt`; this component is
 * purely presentational and reads the current selection state from props.
 * Descriptions live on their own line and wrap within the dialog width.
 */
import type React from "react";
import { Box, Text, useStdout } from "ink";
import { theme } from "../theme.js";
import type { UserQuestion } from "../../tools/Tool.js";

interface QuestionPromptProps {
  questions: UserQuestion[];
  /** Index of the question currently shown. */
  questionIndex: number;
  /** Highlighted row: 0..N-1 options, N = text input, N+1 = "chat instead". */
  highlight: number;
  /** Selected option indices (multi-select); single-select ignores this. */
  selected: ReadonlySet<number>;
  /** Current free-text buffer for the "Type something" row. */
  textInput: string;
}

function Row({
  highlighted,
  children,
}: {
  highlighted: boolean;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <Box>
      <Text color={theme.brand}>{highlighted ? "› " : "  "}</Text>
      {children}
    </Box>
  );
}

export function QuestionPrompt({
  questions,
  questionIndex,
  highlight,
  selected,
  textInput,
}: QuestionPromptProps): React.ReactNode {
  const { stdout } = useStdout();
  const question = questions[questionIndex];
  if (!question) return null;

  const columns = stdout?.columns ?? 80;
  // Leave room for the root paddingX (1*2). Border + own paddingX is handled
  // by Ink inside this width, so descriptions wrap a couple cols short of it.
  const width = Math.max(40, Math.min(columns - 2, 100));

  const multi = question.multiSelect === true;
  const total = questions.length;
  const optionCount = question.options.length;
  const inputRow = optionCount;
  const chatRow = optionCount + 1;

  const hint = multi
    ? "Space to toggle · Enter to confirm · ↑/↓ to navigate · Esc to cancel"
    : "Enter to select · ↑/↓ to navigate · Esc to cancel";

  return (
    <Box
      marginTop={1}
      width={width}
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.brand}
      paddingX={1}
    >
      <Box>
        <Text backgroundColor={theme.userBarBg} color={theme.brandLight}>
          {` ${question.header} `}
        </Text>
        {total > 1 ? (
          <Text color={theme.muted}>{`  question ${questionIndex + 1}/${total}`}</Text>
        ) : null}
        {multi ? <Text color={theme.muted}>{"  (multi-select)"}</Text> : null}
      </Box>

      <Box marginTop={1}>
        <Text bold>{question.question}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {question.options.map((opt, i) => {
          const isHighlighted = i === highlight;
          const isChosen = multi && selected.has(i);
          const box = multi ? (isChosen ? "[x] " : "[ ] ") : "";
          const labelColor = isHighlighted ? theme.brandLight : undefined;
          return (
            <Box key={i} flexDirection="column">
              <Row highlighted={isHighlighted}>
                {multi ? (
                  <Text color={isChosen ? theme.brand : theme.muted}>{box}</Text>
                ) : null}
                <Text color={labelColor} bold={isHighlighted}>
                  {`${i + 1}. ${opt.label}`}
                </Text>
              </Row>
              {opt.description ? (
                <Box marginLeft={multi ? 6 : 5}>
                  <Text color={theme.muted}>{opt.description}</Text>
                </Box>
              ) : null}
            </Box>
          );
        })}

        {/* Free-text input row — the user types their own answer here. */}
        <Row highlighted={highlight === inputRow}>
          <Text color={highlight === inputRow ? theme.brandLight : undefined}>
            {`${inputRow + 1}. `}
          </Text>
          {textInput ? (
            <Text>
              {textInput}
              {highlight === inputRow ? <Text color={theme.brand}>█</Text> : null}
            </Text>
          ) : (
            <Text color={theme.muted}>
              Type something{highlight === inputRow ? <Text color={theme.brand}>█</Text> : null}
            </Text>
          )}
        </Row>

        {/* Bail-out row — cancel the dialog and reply to the model normally. */}
        <Row highlighted={highlight === chatRow}>
          <Text color={highlight === chatRow ? theme.brandLight : undefined}>
            {`${chatRow + 1}. Chat about this instead`}
          </Text>
        </Row>
      </Box>

      <Box marginTop={1}>
        <Text color={theme.muted} dimColor>
          {hint}
        </Text>
      </Box>
    </Box>
  );
}
