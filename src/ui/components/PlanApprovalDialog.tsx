/**
 * PlanApprovalDialog — rich exit-plan-mode approval UI.
 *
 * Shows the plan content as a preview, then presents a select menu:
 *   1. Yes, auto-accept edits (clear context) — auto-approve writes, fresh start
 *   2. Yes, auto-accept edits (keep context) — auto-approve writes, keep conversation
 *   3. Yes, manually approve edits — each write requires y/n approval
 *   4. No, keep planning — with feedback input
 *
 * Arrow keys navigate, Enter confirms. When option 3 is focused the
 * user can type feedback text that gets passed back through the
 * permission decision.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { PermissionDecision } from "../../permissions/permissions.js";

interface PlanApprovalDialogProps {
  planContent?: string;
  planFilePath?: string;
  summary: string;
  onDecision: (decision: PermissionDecision, feedback?: string) => void;
}

const OPTIONS = [
  { label: "Yes, auto-accept edits (clear context)", hint: "auto-approve writes, fresh start" },
  { label: "Yes, auto-accept edits (keep context)", hint: "auto-approve writes, keep conversation" },
  { label: "Yes, manually approve edits", hint: "each write requires y/n approval" },
  { label: "No, keep planning", hint: "type feedback below" },
] as const;

export function PlanApprovalDialog({
  planContent,
  planFilePath,
  summary,
  onDecision,
}: PlanApprovalDialogProps): React.ReactNode {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [feedback, setFeedback] = useState("");

  useInput((input, key) => {
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(OPTIONS.length - 1, prev + 1));
      return;
    }

    if (key.return) {
      if (selectedIndex === 0) {
        onDecision("allow_clear_context");
      } else if (selectedIndex === 1) {
        onDecision("allow_accept_edits");
      } else if (selectedIndex === 2) {
        onDecision("allow_once");
      } else {
        const trimmed = feedback.trim();
        if (!trimmed) return;
        onDecision("deny", trimmed);
      }
      return;
    }

    // Only allow typing when "No, keep planning" is selected
    if (selectedIndex === 3) {
      if (key.backspace || key.delete) {
        setFeedback((prev) => prev.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setFeedback((prev) => prev + input);
      }
    }
  });

  // Truncate long plan content for display
  const displayPlan = planContent
    ? planContent.length > 2000
      ? planContent.slice(0, 2000) + "\n\n... (truncated, see full plan file)"
      : planContent
    : "(No plan content)";

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Header */}
      <Box borderStyle="round" borderColor="green" paddingX={1} flexDirection="column">
        <Text color="green" bold>Ready to code?</Text>
        <Text dimColor>Here is the plan:</Text>
      </Box>

      {/* Plan preview */}
      <Box marginLeft={2} marginTop={1} flexDirection="column">
        <Text dimColor>{"─".repeat(60)}</Text>
        <Text>{displayPlan}</Text>
        <Text dimColor>{"─".repeat(60)}</Text>
      </Box>

      {planFilePath && (
        <Box marginLeft={2} marginTop={0}>
          <Text dimColor>Plan file: {planFilePath}</Text>
        </Box>
      )}

      {/* Select menu */}
      <Box marginTop={1} flexDirection="column" marginLeft={2}>
        {OPTIONS.map((opt, i) => {
          const isFocused = i === selectedIndex;
          return (
            <Box key={i}>
              <Text color={isFocused ? "cyan" : undefined}>
                {isFocused ? "> " : "  "}
                {opt.label}
              </Text>
              <Text dimColor>{"  "}{opt.hint}</Text>
            </Box>
          );
        })}
      </Box>

      {/* Feedback input (visible when option 3 is selected) */}
      {selectedIndex === 3 && (
        <Box marginTop={1} marginLeft={4}>
          <Text color="yellow">Tell the agent what to change: </Text>
          <Text>{feedback || ""}</Text>
          <Text dimColor>{feedback ? "" : "(type your feedback, Enter to send)"}</Text>
        </Box>
      )}
    </Box>
  );
}
