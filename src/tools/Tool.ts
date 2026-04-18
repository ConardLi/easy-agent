/**
 * Tool interface definition — The abstraction for all agent tools.
 *
 * Reference: claude-code-source-code/src/Tool.ts
 * The original has ~800 lines covering permissions, React rendering,
 * MCP, Zod schemas, concurrency safety, etc. We extract the core:
 *
 *   name + description + inputSchema + call() + isReadOnly() + isEnabled()
 *
 * The `call()` method returns a `ToolResult` that gets converted into
 * a `tool_result` content block and sent back to the API.
 */

import type Anthropic from "@anthropic-ai/sdk";

// ─── Tool Context ──────────────────────────────────────────────────

/** Runtime context passed to every tool invocation. */
export interface ToolContext {
  /** Current working directory */
  cwd: string;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Callback to switch permission mode at runtime (set by QueryEngine). */
  setPermissionMode?: (mode: string) => void;
  /** Callback to get the current permission mode. */
  getPermissionMode?: () => string;
  /** Callback to add session-level allow rules (for allowedPrompts on plan exit). */
  addSessionAllowRules?: (rules: string[]) => void;
  /**
   * Current session id. Used by session-scoped tools (e.g. TodoWrite) to
   * key their in-memory state — mirrors source code's
   * `agentId ?? getSessionId()` lookup pattern in `appState.todos[todoKey]`.
   */
  sessionId?: string;
}

// ─── Tool Result ───────────────────────────────────────────────────

/** The return value of a tool's `call()` method. */
export interface ToolResult {
  /** Human-readable text output sent back to the model. */
  content: string;
  /** Whether this call produced an error. */
  isError?: boolean;
}

// ─── Tool Interface ────────────────────────────────────────────────

/**
 * The core tool abstraction. Every tool implements this interface.
 *
 * Generic parameters are intentionally omitted — we use `Record<string, unknown>`
 * for input to keep the interface simple and avoid Zod dependency at this stage.
 */
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 100_000;

export interface Tool {
  /** Unique tool name, sent to the API and used for lookup. */
  readonly name: string;

  /** Human-readable description shown to the model. */
  readonly description: string;

  /**
   * JSON Schema describing the tool's input parameters.
   * This is sent directly to the Anthropic API as `input_schema`.
   */
  readonly inputSchema: Anthropic.Tool["input_schema"];

  /**
   * Maximum character count for the tool result content.
   * Results exceeding this limit will be truncated.
   * Defaults to DEFAULT_MAX_RESULT_SIZE_CHARS (100K).
   */
  readonly maxResultSizeChars?: number;

  /**
   * Execute the tool with the given input.
   * The model provides `input` as a parsed JSON object.
   */
  call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;

  /** Whether this tool only reads data (no side effects). */
  isReadOnly(): boolean;

  /** Whether this tool is available in the current environment. */
  isEnabled(): boolean;
}

/** Truncate tool result content to the specified max size. */
export function truncateToolResult(content: string, maxChars?: number): string {
  const limit = maxChars ?? DEFAULT_MAX_RESULT_SIZE_CHARS;
  if (content.length <= limit) return content;
  const truncated = content.slice(0, limit);
  return `${truncated}\n\n[Output truncated: ${content.length} chars total, showing first ${limit}]`;
}

// ─── Helpers ───────────────────────────────────────────────────────

/** Convert a Tool to the Anthropic API `tools` parameter format. */
export function toolToApiParam(tool: Tool): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}
