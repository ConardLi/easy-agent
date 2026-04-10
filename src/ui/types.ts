import type { PermissionMode } from "../permissions/permissions.js";

export interface ToolCallInfo {
  name: string;
  resultLength?: number;
  isError?: boolean;
}

export interface UsageSummary {
  input: number;
  output: number;
}

export interface PermissionPromptState {
  toolName: string;
  summary: string;
  risk: string;
  ruleHint: string;
}

export interface CommandSuggestion {
  name: string;
  description: string;
}

export interface SystemNotice {
  tone: "info" | "error";
  title: string;
  body: string;
}

export interface SessionViewState {
  permissionMode: PermissionMode;
}
