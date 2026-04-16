import type { PermissionMode } from "../permissions/permissions.js";

export interface ToolCallInfo {
  name: string;
  displayName?: string;
  displayHint?: string;
  resultLength?: number;
  isError?: boolean;
}

export interface UsageSummary {
  input: number;
  output: number;
  contextTokens?: number;
  contextPercent?: number;
}

export interface PermissionPromptState {
  toolName: string;
  summary: string;
  risk: string;
  ruleHint: string;
  /** For ExitPlanMode: enables the richer plan approval prompt. */
  isPlanExit?: boolean;
  /** Plan file content for preview in the exit dialog. */
  planContent?: string;
  /** Plan file path. */
  planFilePath?: string;
}

export interface CommandSuggestion {
  name: string;
  description: string;
  isSelected?: boolean;
}

export interface SystemNotice {
  tone: "info" | "error";
  title: string;
  body: string;
}

export interface SessionViewState {
  permissionMode: PermissionMode;
}
