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
   * Execute the tool with the given input.
   * The model provides `input` as a parsed JSON object.
   */
  call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;

  /** Whether this tool only reads data (no side effects). */
  isReadOnly(): boolean;

  /** Whether this tool is available in the current environment. */
  isEnabled(): boolean;
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
