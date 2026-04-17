import type { PermissionMode } from "../permissions/permissions.js";

export interface ToolCallInfo {
  /**
   * Unique tool_use id from the model's stream. MUST be used as the
   * identity of a tool-call card — matching by `name` alone breaks the
   * moment a single assistant turn invokes the same tool multiple times
   * in parallel (each `tool_use_done` would then collapse all pending
   * cards of that name onto the first completion).
   */
  id: string;
  name: string;
  displayName?: string;
  displayHint?: string;
  resultLength?: number;
  isError?: boolean;
  /** Short one-line summary of tool input (shown for debugging). */
  inputPreview?: string;
  /** Full error content from the tool (shown when isError). */
  errorMessage?: string;
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
