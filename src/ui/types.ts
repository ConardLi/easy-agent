import type { PermissionMode } from "../permissions/permissions.js";
import type { SubAgentProgress } from "../state/subAgentProgressStore.js";
import type { BashProgress } from "../state/bashProgressStore.js";
import type { ToolStatus } from "../state/toolStatusStore.js";
import type { McpProgress } from "../state/mcpProgressStore.js";

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
  /**
   * Live execution phase, mirrored from `toolStatusStore` while the tool is
   * in flight. Absent → the card is queued (model emitted the tool_use but
   * the loop hasn't started it). Ignored once `resultLength` is set (done).
   */
  status?: ToolStatus;
  /** Short one-line summary of tool input (shown for debugging). */
  inputPreview?: string;
  /**
   * Raw tool input args, captured at tool_use_done. Lets the live card show
   * the same descriptor as the historical card (e.g. Edit's `+N -N`, derived
   * from old_string/new_string) without re-querying anything.
   */
  input?: Record<string, unknown>;
  /** Full error content from the tool (shown when isError). */
  errorMessage?: string;
  /**
   * For Agent tool calls: live snapshot from `subAgentProgressStore`,
   * mirrored into the card via the useAgentSession hook. Undefined
   * for non-Agent tools (and for Agent calls before the first
   * progress event arrives — though we seed it at tool_use_start so
   * this should be very brief).
   *
   * Mirrored into ToolCallInfo (rather than queried at render time)
   * so re-renders can be driven by setState in one place.
   */
  subAgentProgress?: SubAgentProgress;
  /**
   * For Bash tool calls: live stdout/stderr tail from `bashProgressStore`,
   * mirrored into the card while the command runs so the user sees progress
   * on long commands (installs, test runs) instead of a frozen spinner.
   */
  bashProgress?: BashProgress;
  mcpProgress?: McpProgress;
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
  /** Raw tool input — drives the file diff / new-file preview for Edit/Write. */
  input?: Record<string, unknown>;
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
  /** Scope tag shown after the name, e.g. "local" (project cmd) or "skill". */
  tag?: string;
  /**
   * Selecting this row should complete the input and continue to its next
   * argument level instead of executing immediately.
   */
  completionOnly?: boolean;
}

/** A `@`-typeahead candidate: a file or directory under the working dir. */
export interface FileSuggestion {
  /** Path as it will be inserted (relative, dirs end with "/"). */
  path: string;
  isDirectory: boolean;
  isSelected?: boolean;
}

export interface SystemNotice {
  tone: "info" | "error";
  title: string;
  body: string;
  /**
   * When true the notice is a slash-command result panel: it pins above the
   * input, blocks typing, and is dismissed with Esc (mirrors Claude's
   * `shouldHidePromptInput` local-jsx commands). Transient notices leave it
   * unset and don't block input.
   */
  dismissable?: boolean;
}

export interface SessionViewState {
  permissionMode: PermissionMode;
}
