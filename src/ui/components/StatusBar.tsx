import React from "react";
import { Box, Text } from "ink";
import { Spinner } from "./Spinner.js";
import { StreamingMarkdown } from "../markdown/Markdown.js";
import { PlanApprovalDialog } from "./PlanApprovalDialog.js";
import { PermissionRequestCard } from "./PermissionRequestCard.js";
import { theme, glyph } from "../theme.js";
import type { PermissionDecision } from "../../permissions/permissions.js";
import type { PermissionPromptState, UsageSummary } from "../types.js";

interface StatusBarProps {
  isLoading: boolean;
  spinnerLabel: string;
  streamingText: string;
  lastUsage: UsageSummary | null;
  permissionPrompt: PermissionPromptState | null;
  permissionOptionIndex?: number;
  onPlanDecision?: (decision: PermissionDecision, feedback?: string) => void;
}

export function StatusBar({
  isLoading,
  spinnerLabel,
  streamingText,
  lastUsage,
  permissionPrompt,
  permissionOptionIndex = 0,
  onPlanDecision,
}: StatusBarProps): React.ReactNode {
  return (
    <>
      {permissionPrompt && permissionPrompt.isPlanExit && onPlanDecision && (
        <PlanApprovalDialog
          planContent={permissionPrompt.planContent}
          planFilePath={permissionPrompt.planFilePath}
          summary={permissionPrompt.summary}
          onDecision={onPlanDecision}
        />
      )}

      {permissionPrompt && !permissionPrompt.isPlanExit && (
        <PermissionRequestCard prompt={permissionPrompt} selectedOptionIndex={permissionOptionIndex} />
      )}

      {isLoading && !streamingText && !permissionPrompt && (
        <Box marginTop={1}>
          <Spinner label={spinnerLabel} />
        </Box>
      )}

      {isLoading && streamingText && !permissionPrompt && (
        <Box marginTop={1}>
          <Text color={theme.assistant}>{`${glyph.assistant} `}</Text>
          <StreamingMarkdown content={streamingText} />
        </Box>
      )}

      {lastUsage && !isLoading && (
        <Box marginTop={1}>
          <Text color={theme.muted}>
            {`${lastUsage.input + lastUsage.output} tokens`}
            {` (${lastUsage.input} in / ${lastUsage.output} out)`}
            {typeof lastUsage.contextPercent === "number"
              ? `  ${glyph.bullet}  context ${lastUsage.contextPercent}%`
              : ""}
          </Text>
        </Box>
      )}
    </>
  );
}
