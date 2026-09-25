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
import type { ContentBlock } from "../types/message.js";
import { areExperimentalBetasDisabled } from "../utils/experimentalBetas.js";

// ─── Interactive questions (AskUserQuestion) ───────────────────────

/** One selectable choice within a question. */
export interface UserQuestionOption {
  label: string;
  description?: string;
}

/** A single multiple-choice question to put to the user. */
export interface UserQuestion {
  /** Full question text, e.g. "Which date library should we use?". */
  question: string;
  /** Short chip/tag label, e.g. "Library". */
  header: string;
  /** 2–4 mutually-exclusive (or, if multiSelect, combinable) options. */
  options: UserQuestionOption[];
  /** Allow selecting more than one option. */
  multiSelect?: boolean;
}

export interface UserQuestionRequest {
  questions: UserQuestion[];
}

export interface UserQuestionResponse {
  /**
   * Map of question text → the chosen option label(s). For multi-select
   * questions the labels are joined with ", ".
   */
  answers: Record<string, string>;
}

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

  /**
   * Stage 26 — id of the active user turn. File-history snapshots bind to
   * this id; the agentic loop uses it to back up files before Edit/Write.
   * Set per-turn by the QueryEngine; tools themselves ignore it.
   */
  messageId?: string;

  /**
   * Stage 24 — interactive multiple-choice prompt. AskUserQuestion calls
   * this to surface questions to the user and await their selection. The
   * QueryEngine/UI wires it the same way as the permission prompt
   * (a promise resolved when the user answers). Resolves to `null` if the
   * user cancels or no interactive frontend is attached (headless). Tools
   * other than AskUserQuestion ignore it.
   */
  requestUserQuestion?: (
    request: UserQuestionRequest,
  ) => Promise<UserQuestionResponse | null>;

  // ─── Sub-agent spawning support (stage 19) ────────────────────────
  //
  // The Agent tool needs to give its sub-agent the same permission
  // infrastructure the parent loop has — settings file rules, session
  // allow/deny rules, and the prompt callback for ask-mode confirmations.
  // The QueryEngine populates these on the per-submit enriched context;
  // tools other than Agent ignore them. Typed as `unknown` to avoid a
  // circular type import with permissions.ts; agentTool casts at the
  // call site.

  /** Parent loop's loaded permission settings (PermissionSettings). */
  permissionSettings?: unknown;
  /** Parent loop's session-scoped allow/deny rules (PermissionRuleSet). */
  sessionPermissionRules?: unknown;
  /** Parent loop's permission-prompt callback. */
  onPermissionRequest?: unknown;
  /** Parent loop's active model name (sub-agents fall back to this). */
  defaultModel?: string;
  /**
   * The model-assigned `tool_use` id for THIS specific invocation. Set
   * fresh per call by `runTools()` in agenticLoop.ts. AgentTool uses it
   * as the key for publishing live sub-agent progress to the UI store
   * so the parent's tool-call card can be matched to the right sub-agent.
   */
  toolUseId?: string;
  /** Tool pool allowed for this invocation, including undiscovered tools. */
  availableTools?: readonly Tool[];

  /**
   * Identity of a named teammate run. Used for message routing and
   * shared-task ownership. The lead's tool calls leave this undefined.
   *
   * Typed at the call site (in SendMessage) rather than imported from
   * the team helpers module here, to avoid pulling teammate types into
   * Tool.ts's type-only surface area.
   */
  teammateIdentity?: {
    agentId: string;
    agentName: string;
    teamName: string;
    runId?: string;
  };
  /** Plain sub-agents keep session-scoped tasks even while the lead has a team. */
  taskScope?: "session" | "team";
}

// ─── Tool Result ───────────────────────────────────────────────────

/** The return value of a tool's `call()` method. */
export interface ToolResult {
  /**
   * Output sent back to the model. Usually a plain string, but tools that
   * produce multimodal output (e.g. `Read` on an image, MCP image results)
   * return an array of content blocks — text and/or image blocks — which is
   * forwarded verbatim into the `tool_result` block. The array form is what
   * lets the model actually *see* an image.
   */
  content: string | ContentBlock[];
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

  /**
   * Whether this tool is safe to run concurrently with other instances of
   * itself or with other concurrency-safe tools. The agentic loop uses
   * this to partition a single assistant turn's tool_use blocks into
   * batches: consecutive concurrency-safe tools form one parallel batch
   * (run via `Promise.all`); anything else runs serially in its own
   * singleton batch. Mirrors source's `isConcurrencySafe(input)` flag in
   * claude-code-source-code/src/tools/AgentTool/AgentTool.tsx.
   *
   * Optional — defaults to `false` for safety. Tools that mutate the
   * filesystem (Write/Edit/Bash/MemoryWrite), the session (TodoWrite,
   * Skill), or interact with the user (ExitPlanMode) MUST stay false to
   * avoid interleaving writes or duplicate prompts. Read-only search /
   * inspection tools (Read/Grep/Glob) and the Agent tool itself (each
   * sub-agent runs in an isolated context) can opt in to true.
   */
  isConcurrencySafe?(input?: Record<string, unknown>): boolean;

  // ─── ToolSearch metadata ─────────────────────────────────────────
  //
  // When tool search is active, "deferred" tools are not sent with their
  // full schema on every request. The model sees only their names (in an
  // <available-deferred-tools> list) and must call ToolSearch to load a
  // schema before invoking the tool. `isDeferredTool()` in
  // utils/toolSearch.ts combines the flags below in a fixed order:
  //   alwaysLoad → isMcp → (ToolSearch itself) → shouldDefer

  /**
   * When true, this tool is deferred (sent with `defer_loading: true`) and
   * requires ToolSearch to be used before it can be called.
   */
  readonly shouldDefer?: boolean;

  /**
   * When true, this tool is never deferred — its full schema appears in the
   * initial prompt even when ToolSearch is enabled. For MCP tools, set via
   * `_meta['anthropic/alwaysLoad']`. Use for tools the model must see on
   * turn 1 without a ToolSearch round-trip.
   */
  readonly alwaysLoad?: boolean;

  /** True for tools adapted from an MCP server. MCP tools are deferred by default. */
  readonly isMcp?: boolean;

  /**
   * One-line capability phrase used by ToolSearch for keyword matching.
   * Helps the model find this tool via keyword search when it's deferred.
   * 3–10 words, no trailing period. Prefer terms not already in the tool
   * name (e.g. 'jupyter' for NotebookEdit). For MCP tools, set via
   * `_meta['anthropic/searchHint']`.
   */
  readonly searchHint?: string;
}

/** Truncate tool result content to the specified max size. */
export function truncateToolResult(
  content: string | ContentBlock[],
  maxChars?: number,
): string | ContentBlock[] {
  const limit = maxChars ?? DEFAULT_MAX_RESULT_SIZE_CHARS;
  // Array content (multimodal results): only truncate text blocks; never
  // touch image blocks — slicing base64 would corrupt the image and the
  // byte budget for images is handled separately (size guard in the tool).
  if (Array.isArray(content)) {
    return content.map((block) =>
      block.type === "text"
        ? { ...block, text: truncateToolResult(block.text, maxChars) as string }
        : block,
    );
  }
  if (content.length <= limit) return content;
  const truncated = content.slice(0, limit);
  return `${truncated}\n\n[Output truncated: ${content.length} chars total, showing first ${limit}]`;
}

/**
 * Flatten a tool result's content to a plain string for UI summaries,
 * logging, persistence, and any consumer that only deals in text. Image
 * blocks collapse to a `[image]` marker.
 */
export function toolResultText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "image") return "[image]";
      if (block.type === "tool_reference") return `[tool loaded: ${block.tool_name}]`;
      return "";
    })
    .join("");
}

// ─── Helpers ───────────────────────────────────────────────────────

/**
 * Anthropic `tools[]` entry plus the tool-search beta field. `defer_loading`
 * tells the API to keep the definition out of the prompt until a
 * `tool_reference` in the conversation pulls it in. Non-Anthropic
 * translators strip it before sending.
 */
export type ApiToolParam = Anthropic.Tool & { defer_loading?: boolean };

/** Convert a Tool to the Anthropic API `tools` parameter format. */
export function toolToApiParam(tool: Tool, options: { deferLoading?: boolean } = {}): ApiToolParam {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    ...(options.deferLoading && !areExperimentalBetasDisabled() ? { defer_loading: true } : {}),
  };
}
