import React from "react";
import { Box, Text } from "ink";
import { Markdown } from "../markdown/Markdown.js";
import { theme } from "../theme.js";

/**
 * Renders an extended-thinking block in the transcript.
 *
 * Mirrors source's AssistantThinkingMessage:
 *   - Non-verbose (default) → a single folded line "✻ Thinking…" (the
 *     reasoning body is hidden from the human view but stays in the
 *     conversation history sent to the model).
 *   - Verbose / transcript mode → the full reasoning rendered as Markdown
 *     under a "✻ Thinking" header.
 *
 * The glyph and muted styling deliberately match source's dim/italic
 * treatment so thinking reads as secondary to the assistant's answer.
 */
export function AssistantThinkingMessage({
  thinking,
  verbose = false,
}: {
  thinking: string;
  verbose?: boolean;
}): React.ReactNode {
  const trimmed = thinking.trim();
  if (!trimmed) return null;

  if (!verbose) {
    return (
      <Box marginTop={1}>
        <Text color={theme.muted}>{"✻ "}</Text>
        <Text color={theme.muted} italic>
          Thinking…
        </Text>
      </Box>
    );
  }

  return (
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Text color={theme.muted}>{"✻ "}</Text>
        <Text color={theme.muted} italic bold>
          Thinking
        </Text>
      </Box>
      <Box marginLeft={2}>
        <Markdown content={trimmed} />
      </Box>
    </Box>
  );
}

/**
 * Renders a redacted-thinking block — the model's internal reasoning was
 * withheld (encrypted). There is nothing human-readable to show, so we
 * render a non-expandable placeholder. Hidden entirely when not verbose.
 *
 * Mirrors source's AssistantRedactedThinkingMessage ("✻ Thinking…" stub).
 */
export function AssistantRedactedThinkingMessage({
  verbose = false,
}: {
  verbose?: boolean;
}): React.ReactNode {
  if (!verbose) return null;
  return (
    <Box marginTop={1}>
      <Text color={theme.muted}>{"✻ "}</Text>
      <Text color={theme.muted} italic>
        Thinking… (redacted)
      </Text>
    </Box>
  );
}
