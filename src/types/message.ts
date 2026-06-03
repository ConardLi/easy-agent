/**
 * Message types for the Easy Agent CLI.
 *
 * Maps closely to the Anthropic Messages API format.
 * Reference: claude-code-source-code/src/types/message.ts
 */

// ─── Content Block Types ───────────────────────────────────────────

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  /**
   * Gemini-3 emits an opaque `thoughtSignature` alongside each function call
   * and *requires* it to be echoed back on the functionCall part in subsequent
   * turns (otherwise it rejects the request). We capture it here so it rides
   * along in conversation history; it is ignored by every non-Gemini path.
   */
  thoughtSignature?: string;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

/**
 * Extended-thinking content block, as streamed by Anthropic (and
 * Anthropic-compatible endpoints like MiniMax) when a model returns
 * internal reasoning.  The `signature` field is required by the API
 * when we echo the message back on the next turn.
 */
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock;

// ─── Message Types ─────────────────────────────────────────────────

export interface UserMessage {
  role: "user";
  content: string | ContentBlock[];
}

export interface AssistantMessage {
  role: "assistant";
  content: string | ContentBlock[];
}

export type Message = UserMessage | AssistantMessage;

// ─── Usage Tracking ────────────────────────────────────────────────

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// ─── Stream Event Types ────────────────────────────────────────────

export interface StreamTextEvent {
  type: "text";
  text: string;
}

export interface StreamToolUseStartEvent {
  type: "tool_use_start";
  id: string;
  name: string;
}

export interface StreamToolUseInputEvent {
  type: "tool_use_input";
  id: string;
  partial_json: string;
}

export interface StreamMessageStartEvent {
  type: "message_start";
  messageId: string;
}

export interface StreamMessageDoneEvent {
  type: "message_done";
  stopReason: string;
  usage: Usage;
}

export interface StreamErrorEvent {
  type: "error";
  error: Error;
  /**
   * Stage 27: the classified category of the error (rate_limit,
   * prompt_too_long, auth_error, …). Lets the agentic loop decide on a
   * recovery path (e.g. reactive compact for prompt_too_long) instead of
   * re-parsing the error string. Optional so non-API errors stay simple.
   */
  category?: string;
}

/**
 * Stage 27: emitted by the retry wrapper while it is waiting to re-issue a
 * request after a transient failure (429 / 5xx / network). Carries enough for
 * the UI to show "Retrying in Xs… (attempt N/M)". Yielded BEFORE any content,
 * so it never interleaves with partial assistant text.
 */
export interface StreamRetryEvent {
  type: "retry";
  attempt: number;
  maxRetries: number;
  delayMs: number;
  errorMessage: string;
  category: string;
}

export type StreamEvent =
  | StreamTextEvent
  | StreamToolUseStartEvent
  | StreamToolUseInputEvent
  | StreamMessageStartEvent
  | StreamMessageDoneEvent
  | StreamErrorEvent
  | StreamRetryEvent;
