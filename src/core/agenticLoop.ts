/**
 * Agentic Loop — Core loop orchestration for one user query.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import {
  checkPermission,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRequest,
  type PermissionRuleSet,
  type PermissionSettings,
} from "../permissions/permissions.js";
import { streamMessage } from "../services/api/streaming.js";
import { ESCALATED_MAX_TOKENS, MAX_OUTPUT_TOKENS_RECOVERY_LIMIT } from "../services/api/client.js";
import type { QuerySource } from "../services/api/withRetry.js";
import { compactMessages } from "../context/compaction.js";
import { findToolByName } from "../tools/index.js";
import { truncateToolResult, type ToolContext, type ToolResult } from "../tools/Tool.js";
import { appendTextToContent, prependTextToContent } from "../tools/contentBlocks.js";
import {
  activateConditionalSkillsForPaths,
  extractToolFilePaths,
} from "../services/skills/conditional.js";
import { tokenCountWithEstimation } from "../utils/tokens.js";
import { fileHistoryTrackEdit } from "../session/fileHistory.js";
import { setToolStatus } from "../state/toolStatusStore.js";
import * as path from "node:path";
import { isAtBlockingLimit, calculateTokenWarningState, type TokenWarningResult } from "../context/autoCompact.js";
import type { ContentBlock, TextBlock, ToolUseBlock, Usage } from "../types/message.js";
import {
  runPreToolUseHooks,
  runPostToolUseHooks,
  runStopHooks,
  runSubagentStopHooks,
} from "../hooks/index.js";

export const MAX_TOOL_TURNS = 50;

/**
 * Stage 27: injected when output is truncated and the silent 64K escalation
 * already happened — the model is asked to resume from the cut point. Copied
 * verbatim from source (query.ts) because the wording is load-bearing: it
 * stops the model from apologizing / recapping (which would waste the very
 * tokens we're trying to conserve).
 */
const MAX_OUTPUT_TOKENS_RECOVERY_PROMPT =
  "Output token limit hit. Resume directly — no apology, no recap of what you were doing. " +
  "Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.";

export type LoopTerminationReason =
  | "completed"
  | "aborted"
  | "model_error"
  | "max_turns"
  | "blocking_limit";

export interface LoopState {
  messages: MessageParam[];
  turnCount: number;
  aborted: boolean;
}

export interface ToolExecutionResult {
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  result: ToolResult;
}

export type AgenticLoopEvent =
  | { type: "text"; text: string }
  | { type: "thinking_start" }
  | { type: "thinking_delta"; thinking: string }
  | { type: "thinking_done"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "permission_request"; request: PermissionRequest }
  | {
      type: "tool_use_done";
      id: string;
      name: string;
      input: Record<string, unknown>;
      result: ToolResult;
    }
  | { type: "assistant_message"; message: MessageParam }
  | { type: "tool_result_message"; message: MessageParam }
  | { type: "turn_complete"; reason: LoopTerminationReason; turnCount: number }
  | { type: "token_warning"; warning: TokenWarningResult }
  | {
      /**
       * Stage 27: surfaced while the API layer is backing off before
       * re-issuing a request after a transient failure (429 / 5xx / network).
       * Lets the UI show "Retrying in Xs… (attempt N/M)".
       */
      type: "api_retry";
      attempt: number;
      maxRetries: number;
      delayMs: number;
      message: string;
    }
  | {
      /**
       * Stage 27: the loop is about to re-run the current turn from scratch —
       * either after a silent max_tokens escalation to 64K, or after a
       * reactive compaction triggered by a prompt-too-long error. The UI uses
       * this to clear any partially-streamed text so the re-run renders
       * cleanly instead of concatenating onto the truncated output.
       */
      type: "stream_restart";
      reason: "max_tokens_escalation" | "reactive_compact";
    }
  | {
      /**
       * Emitted right after the per-turn streaming API call resolves and
       * the loop has folded the response usage into its running totals.
       * `turnUsage` is just this turn's usage; `cumulativeUsage` is
       * everything spent in this `query()` invocation so far.
       *
       * The parent QueryEngine has its own `usage_updated` event for the
       * top-level loop's bookkeeping; this one exists so sub-agent
       * runners (`runChildAgent`) can publish live token counts to the
       * UI store while the sub-agent is still mid-flight, mirroring
       * Claude Code's per-agent "28.0k tokens" line.
       */
      type: "turn_usage";
      turnUsage: Usage;
      cumulativeUsage: Usage;
      turnCount: number;
    }
  | { type: "error"; error: Error };

export interface AgenticLoopResult {
  state: LoopState;
  usage: Usage;
  lastCallUsage: Usage;
  reason: LoopTerminationReason;
}

export interface QueryParams {
  messages: MessageParam[];
  systemPrompt?: string;
  tools?: Anthropic.Tool[];
  /** Dynamic tool list getter — called on each API iteration to reflect mode changes. */
  getTools?: () => Anthropic.Tool[];
  model: string;
  abortSignal?: AbortSignal;
  toolContext: ToolContext;
  maxTurns?: number;
  /**
   * Stage 27: foreground (user waiting) vs background (sub-agent / summary).
   * Threaded into the streaming layer so 529 capacity overloads are retried
   * for foreground turns and dropped fast for background ones. Defaults to
   * foreground when unset.
   */
  querySource?: QuerySource;
  permissionMode?: PermissionMode;
  permissionSettings?: PermissionSettings;
  sessionPermissionRules?: PermissionRuleSet;
  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionDecision>;
  /**
   * Headless flag — mirrors source's
   * `toolPermissionContext.shouldAvoidPermissionPrompts` from
   * claude-code-source-code/src/tools/AgentTool/runAgent.ts:436-451.
   *
   * When true, any tool call that resolves to `behavior: "ask"` is
   * auto-denied WITHOUT invoking `onPermissionRequest`. We keep
   * `onPermissionRequest` plumbed through (parity with source's
   * `canUseTool` forwarding) but the agentic loop short-circuits
   * before it can fire, with a richer denial message that gives the
   * model workaround guidance instead of "user rejected".
   *
   * Set to true for backgrounded sub-agents (no UI to ask), or any
   * future "non-interactive" execution context.
   */
  shouldAvoidPermissionPrompts?: boolean;
  /**
   * Stage 22: when set, the loop fires SubagentStop hooks (with the
   * supplied id + type) instead of Stop hooks at the end of the
   * conversation. Mirrors source's
   *   `const hookEvent = subagentId ? 'SubagentStop' : 'Stop'`
   * in utils/hooks.ts:executeStopHooks. The top-level main agent
   * leaves this undefined; runChildAgent + runAsyncAgent pass their
   * own id + type so SubagentStop hooks fire per-agent.
   */
  subagentInfo?: { agentId: string; agentType: string };
}

export interface RunToolsOptions {
  permissionMode?: PermissionMode;
  permissionSettings?: PermissionSettings;
  sessionPermissionRules?: PermissionRuleSet;
  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionDecision>;
  /** See RunQueryParams.shouldAvoidPermissionPrompts. */
  shouldAvoidPermissionPrompts?: boolean;
  /**
   * Conversation so far (before the current tool-use action). Threaded into
   * `checkPermission` so the Auto Mode classifier can infer user intent.
   * Stage 1: passed through but not yet consumed by the permission engine.
   */
  conversationMessages?: MessageParam[];
  /** Active model handle, forwarded to the Auto Mode classifier. */
  model?: string;
}

/**
 * Maximum number of concurrency-safe tools to run in parallel within a
 * single batch. Mirrors source's `getMaxToolUseConcurrency()` (default
 * 10) — high enough to amortize a fan-out across many sub-agents,
 * low enough that the OS doesn't choke on subprocess explosions.
 */
const MAX_TOOL_USE_CONCURRENCY = 10;

/**
 * Extract the joined plain-text from an assistant message's content
 * blocks. Used as the `last_assistant_message` payload for Stop /
 * SubagentStop hooks. Returns `undefined` when there's no text at
 * all (e.g. a turn whose entire output is tool_use blocks).
 */
function extractLastAssistantText(content: ContentBlock[]): string | undefined {
  const text = content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Build the denial message used when a backgrounded sub-agent (or any
 * other headless context) hits an "ask" rule. The body mirrors source's
 * `DONT_ASK_REJECT_MESSAGE` + `DENIAL_WORKAROUND_GUIDANCE` from
 * claude-code-source-code/src/utils/messages.ts:227-240:
 *
 *   - Tell the model WHY it was denied (no UI), so it doesn't keep
 *     retrying with the same tool.
 *   - Tell it what it CAN do (try alternative tools) — but not in
 *     malicious / bypass-the-intent ways.
 *   - Tell it to STOP and report back when the capability is essential.
 *
 * Compressed to a couple of sentences to keep the tool_result lean —
 * source's message is verbose because it has to cover hooks, classifier
 * fallback, and policy escalation paths we don't have here.
 */
function buildHeadlessDenialMessage(toolName: string): string {
  return (
    `Permission to use ${toolName} has been denied: this sub-agent is ` +
    `running in the background and cannot prompt the user for approval. ` +
    `You may attempt to accomplish this action with other tools that don't ` +
    `require approval, but do NOT try to bypass the denial in ways that ` +
    `defeat its intent. If this capability is essential to complete the ` +
    `task, STOP and report the blocked action in your final summary so the ` +
    `user can either pre-approve the tool or run the task in the foreground.`
  );
}

interface ToolBatch {
  isConcurrencySafe: boolean;
  blocks: ToolUseBlock[];
}

/**
 * Partition the assistant's tool_use blocks into ordered batches.
 *
 * Mirrors source's `partitionToolCalls` in
 * claude-code-source-code/src/services/tools/toolOrchestration.ts:91 —
 * consecutive concurrency-safe blocks coalesce into one parallel
 * batch; everything else becomes its own singleton batch (which the
 * runner will execute serially).
 *
 * Crucially we MUST keep the original block order across batches so
 * the `executions` array we hand back, and therefore the
 * `tool_use_done` events the agentic loop yields, line up with the
 * order the model's tool_use blocks appeared in the assistant message
 * (the API also requires tool_results to follow that order).
 */
function partitionToolCalls(blocks: ToolUseBlock[]): ToolBatch[] {
  const batches: ToolBatch[] = [];
  for (const block of blocks) {
    const tool = findToolByName(block.name);
    const safe = !!tool?.isConcurrencySafe?.(
      (block.input as Record<string, unknown>) ?? {},
    );
    const last = batches[batches.length - 1];
    if (safe && last?.isConcurrencySafe) {
      last.blocks.push(block);
    } else {
      batches.push({ isConcurrencySafe: safe, blocks: [block] });
    }
  }
  return batches;
}

interface RunOneToolReturn {
  execution: ToolExecutionResult;
  permissionRequest?: PermissionRequest;
}

/**
 * Run one tool_use block end-to-end: name lookup, permission check,
 * the actual `tool.call()`, and result truncation. Pure of any
 * mutation outside its return value — the caller is responsible for
 * stitching the per-block results into the final `executions` /
 * `toolResults` / `permissionRequests` arrays in the correct order.
 *
 * Extracted from the old monolithic `runTools` body so that batches
 * of concurrency-safe blocks can be fanned out via `Promise.all`
 * without duplicating the permission + truncation + activation logic.
 */
async function runOneToolBlock(
  block: ToolUseBlock,
  context: ToolContext,
  options: RunToolsOptions,
): Promise<RunOneToolReturn> {
  const toolInput = (block.input as Record<string, unknown>) ?? {};
  const tool = findToolByName(block.name);
  if (!tool) {
    const result: ToolResult = {
      content: `Error: Unknown tool "${block.name}"`,
      isError: true,
    };
    return {
      execution: { toolUseId: block.id, toolName: block.name, toolInput, result },
    };
  }

  try {
    // ─── Stage 22: PreToolUse hooks ────────────────────────────────
    // Fire user-defined PreToolUse hooks BEFORE the permission check.
    // A hook can:
    //   - veto the tool call (blockingError → result becomes an error)
    //   - override the permission decision (allow / ask / deny)
    //   - inject additionalContext that we prepend to the tool_result
    //
    // Mirrors source's order in
    //   claude-code-source-code/src/services/tools/toolHooks.ts:runPreToolUseHooks
    // which is called from `runToolWithPermissions` BEFORE `checkPermission`.
    const preOutcome = await runPreToolUseHooks({
      toolName: block.name,
      toolInput,
      toolUseId: block.id,
      cwd: context.cwd,
      signal: context.abortSignal,
    });

    if (preOutcome.blockingError) {
      const reason = preOutcome.blockingError;
      const result: ToolResult = {
        content: `Blocked by PreToolUse hook: ${reason}`,
        isError: true,
      };
      return {
        execution: { toolUseId: block.id, toolName: block.name, toolInput, result },
      };
    }

    const liveMode = context.getPermissionMode?.() as PermissionMode | undefined;
    const effectiveMode = liveMode ?? options.permissionMode;
    // Auto mode runs the safety classifier INSIDE checkPermission — surface
    // that to the card as "classifier checking…" while it's in flight.
    if (effectiveMode === "auto") {
      setToolStatus(block.id, "classifier");
    }
    let permission = await checkPermission({
      tool,
      input: toolInput,
      cwd: context.cwd,
      mode: effectiveMode,
      settings: options.permissionSettings,
      sessionRules: options.sessionPermissionRules,
      messages: options.conversationMessages,
      model: options.model,
    });

    // PreToolUse hook can override the rule-based decision (source's
    // `permissionBehavior` from `processHookJSONOutput`). `deny` we
    // handle above as `blockingError`; `allow` short-circuits the
    // permission flow; `ask` upgrades a would-be `allow` into a prompt.
    if (preOutcome.permissionBehavior === "allow") {
      permission = {
        ...permission,
        behavior: "allow",
        reason: preOutcome.permissionDecisionReason || "Allowed by PreToolUse hook",
      };
    } else if (preOutcome.permissionBehavior === "ask" && permission.behavior !== "deny") {
      permission = {
        ...permission,
        behavior: "ask",
        reason: preOutcome.permissionDecisionReason || "PreToolUse hook requested approval",
      };
    }

    if (permission.behavior === "deny") {
      const result: ToolResult = {
        content: `Permission denied for ${block.name}: ${permission.reason}`,
        isError: true,
      };
      return {
        execution: { toolUseId: block.id, toolName: block.name, toolInput, result },
      };
    }

    let surfacedRequest: PermissionRequest | undefined;
    if (permission.behavior === "ask") {
      surfacedRequest = permission.request;

      // Headless short-circuit (source-aligned):
      //   claude-code-source-code/src/utils/permissions/permissions.ts:929-940
      //   When toolPermissionContext.shouldAvoidPermissionPrompts is on,
      //   the source skips the user prompt and auto-denies (after running
      //   permission hooks if any are configured). Easy Agent has no
      //   hooks system, so we go straight to deny — but with a richer
      //   message modelled on source's DONT_ASK_REJECT_MESSAGE so the
      //   model knows WHY and what to do next.
      //
      // We deliberately do NOT call options.onPermissionRequest here.
      // It may still be plumbed through (parity with source's canUseTool
      // forwarding) but invoking it from a backgrounded sub-agent would
      // pop a prompt in the parent's UI — see agentTool.ts for the long
      // list of failure modes that causes.
      let decision: PermissionDecision;
      if (options.shouldAvoidPermissionPrompts === true) {
        decision = "deny";
      } else {
        // Mark this specific card as blocked on the user's approval so the
        // UI can show "Waiting for permission…" on it (not just the prompt).
        setToolStatus(block.id, "waiting-permission");
        decision = options.onPermissionRequest
          ? await options.onPermissionRequest(permission.request)
          : "deny";
      }

      if (decision === "deny") {
        const denialMessage = options.shouldAvoidPermissionPrompts === true
          ? buildHeadlessDenialMessage(block.name)
          : `Permission denied for ${block.name}.`;
        const result: ToolResult = {
          content: denialMessage,
          isError: true,
        };
        return {
          execution: { toolUseId: block.id, toolName: block.name, toolInput, result },
          permissionRequest: surfacedRequest,
        };
      }

      if (decision === "allow_always") {
        const allowRules = options.sessionPermissionRules?.allow;
        if (allowRules && !allowRules.includes(permission.request.ruleHint)) {
          allowRules.push(permission.request.ruleHint);
        }
      }
    }

    // Stamp the tool_use id onto the per-call context so tools that
    // need to publish out-of-band updates (currently just AgentTool's
    // sub-agent progress store) can correlate their events back to
    // the right tool-call card in the UI.
    const callContext: ToolContext = { ...context, toolUseId: block.id };

    // ─── Stage 26: file-history track-edit (before the mutation) ──────
    // Back up the pre-edit content of any file Write/Edit is about to
    // change, so /rewind can restore it. Runs before tool.call so the
    // backup reflects the original content. Best-effort & non-blocking on
    // failure (handled inside fileHistoryTrackEdit).
    if (
      context.messageId &&
      (block.name === "Write" || block.name === "Edit" || block.name === "MultiEdit")
    ) {
      const fp = toolInput["file_path"];
      if (typeof fp === "string" && fp) {
        const absPath = path.isAbsolute(fp) ? fp : path.resolve(context.cwd, fp);
        await fileHistoryTrackEdit(absPath, context.messageId);
      }
    }

    // Permission cleared (or never needed) — the tool is now executing.
    setToolStatus(block.id, "running");
    const rawResult = await tool.call(toolInput, callContext);
    let result: ToolResult = {
      ...rawResult,
      content: truncateToolResult(rawResult.content, tool.maxResultSizeChars),
    };

    // ─── Stage 22: PostToolUse hooks ─────────────────────────────────
    // Fire AFTER the tool executes. Two effects:
    //   - additionalContext  → appended to the tool_result the model sees
    //   - blockingError      → wraps the result with an error attachment
    //
    // We pass the raw (untruncated) response so hooks can introspect it;
    // the truncation applied above is purely for the model's prompt size.
    const postOutcome = await runPostToolUseHooks({
      toolName: block.name,
      toolInput,
      toolResponse: rawResult,
      toolUseId: block.id,
      cwd: context.cwd,
      signal: context.abortSignal,
    });
    if (postOutcome.additionalContext) {
      const sep = "\n\n[PostToolUse hook]\n";
      result = {
        ...result,
        content: appendTextToContent(result.content, sep + postOutcome.additionalContext),
      };
    }
    if (postOutcome.blockingError) {
      const blocked = `[PostToolUse hook blocked]\n${postOutcome.blockingError}`;
      result = {
        ...result,
        // On an already-errored result we append the block reason; on a
        // previously-successful result the block reason replaces the output.
        content: result.isError
          ? appendTextToContent(result.content, `\n\n${blocked}`)
          : blocked,
        isError: true,
      };
    }

    if (!result.isError) {
      const filePaths = extractToolFilePaths(block.name, toolInput);
      if (filePaths.length > 0) {
        activateConditionalSkillsForPaths(filePaths, context.cwd);
      }
    }

    if (preOutcome.additionalContext) {
      const sep = "\n\n[PreToolUse hook]\n";
      result = {
        ...result,
        content: prependTextToContent(result.content, preOutcome.additionalContext + sep),
      };
    }

    return {
      execution: { toolUseId: block.id, toolName: block.name, toolInput, result },
      ...(surfacedRequest ? { permissionRequest: surfacedRequest } : {}),
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error
      ? (error.stack ?? error.message)
      : String(error);
    const result: ToolResult = {
      content: `Error: ${errorMessage}`,
      isError: true,
    };
    return {
      execution: { toolUseId: block.id, toolName: block.name, toolInput, result },
    };
  }
}

/**
 * Run an array of concurrency-safe blocks in parallel, capped at
 * `MAX_TOOL_USE_CONCURRENCY` simultaneous invocations. Promise.all
 * preserves input order in the resolved array, so the caller can
 * re-thread the results into the global `executions` order without
 * extra bookkeeping.
 *
 * For batches smaller than the cap we just `Promise.all`; only the
 * (rare) overflow case spins through chunks. This avoids a surprise
 * dependency on `p-limit` for the common path.
 */
async function runBlocksConcurrently(
  blocks: ToolUseBlock[],
  context: ToolContext,
  options: RunToolsOptions,
): Promise<RunOneToolReturn[]> {
  if (blocks.length <= MAX_TOOL_USE_CONCURRENCY) {
    return Promise.all(blocks.map((b) => runOneToolBlock(b, context, options)));
  }
  const out: RunOneToolReturn[] = [];
  for (let i = 0; i < blocks.length; i += MAX_TOOL_USE_CONCURRENCY) {
    const chunk = blocks.slice(i, i + MAX_TOOL_USE_CONCURRENCY);
    const settled = await Promise.all(
      chunk.map((b) => runOneToolBlock(b, context, options)),
    );
    out.push(...settled);
  }
  return out;
}

export async function runTools(
  contentBlocks: ContentBlock[],
  context: ToolContext,
  options: RunToolsOptions = {},
): Promise<{
  toolResultsMessage: MessageParam;
  executions: ToolExecutionResult[];
  permissionRequests: PermissionRequest[];
}> {
  const toolUseBlocks = contentBlocks.filter(
    (block): block is ToolUseBlock => block.type === "tool_use",
  );

  const executions: ToolExecutionResult[] = [];
  const permissionRequests: PermissionRequest[] = [];

  for (const batch of partitionToolCalls(toolUseBlocks)) {
    const results = batch.isConcurrencySafe && batch.blocks.length > 1
      ? await runBlocksConcurrently(batch.blocks, context, options)
      : await runBlocksSerially(batch.blocks, context, options);
    for (const r of results) {
      executions.push(r.execution);
      if (r.permissionRequest) permissionRequests.push(r.permissionRequest);
    }
  }

  // Build the final tool_results message in the same order as the
  // original tool_use blocks — the API requires this strict pairing.
  const toolResults = executions.map((e) => ({
    type: "tool_result" as const,
    tool_use_id: e.toolUseId,
    content: e.result.content,
    ...(e.result.isError ? { is_error: true } : {}),
  }));

  return {
    toolResultsMessage: { role: "user", content: toolResults as any },
    executions,
    permissionRequests,
  };
}

/**
 * Run blocks one-after-the-other. Used for unsafe batches (Write/Edit/
 * Bash/etc.) where interleaving could corrupt shared state, or for
 * any singleton batch that didn't qualify for parallel execution.
 */
async function runBlocksSerially(
  blocks: ToolUseBlock[],
  context: ToolContext,
  options: RunToolsOptions,
): Promise<RunOneToolReturn[]> {
  const out: RunOneToolReturn[] = [];
  for (const b of blocks) {
    out.push(await runOneToolBlock(b, context, options));
  }
  return out;
}

export async function* query(
  params: QueryParams,
): AsyncGenerator<AgenticLoopEvent, AgenticLoopResult> {
  const maxTurns = params.maxTurns ?? MAX_TOOL_TURNS;
  let state: LoopState = {
    messages: [...params.messages],
    turnCount: 0,
    aborted: false,
  };
  const totalUsage: Usage = {
    input_tokens: 0,
    output_tokens: 0,
  };
  let lastCallUsage: Usage = {
    input_tokens: 0,
    output_tokens: 0,
  };

  // Stop-hook re-entry guard — see the call site below for context.
  let stopHookFired = false;

  // ─── Stage 27: recovery state ────────────────────────────────────
  // `maxOutputTokensOverride`: while set, the next API call uses this higher
  //   max_tokens (the silent 64K escalation). Reset to undefined after a
  //   normal turn or once multi-turn recovery takes over.
  // `maxOutputTokensRecoveryCount`: how many continuation prompts we've
  //   injected after the escalation still hit the cap (bounded by the limit).
  // `hasAttemptedReactiveCompact`: one-shot guard so a prompt-too-long error
  //   triggers compaction at most once — without it, "compact → still too
  //   long → compact" would loop forever burning API calls.
  let maxOutputTokensOverride: number | undefined = undefined;
  let maxOutputTokensRecoveryCount = 0;
  let hasAttemptedReactiveCompact = false;

  while (state.turnCount < maxTurns) {
    if (params.abortSignal?.aborted) {
      const abortedState = { ...state, aborted: true };
      yield { type: "turn_complete", reason: "aborted", turnCount: state.turnCount };
      return { state: abortedState, usage: totalUsage, lastCallUsage, reason: "aborted" };
    }

    const nextTurnCount = state.turnCount + 1;

    // Token budget check before API call (skip first turn — let the API decide)
    if (state.turnCount > 0) {
      const estimatedTokens = tokenCountWithEstimation(state.messages, {
        usage: lastCallUsage.input_tokens > 0 ? lastCallUsage : undefined,
        usageAnchorIndex: lastCallUsage.input_tokens > 0 ? state.messages.length - 1 : undefined,
        systemPrompt: params.systemPrompt,
      });
      const warningState = calculateTokenWarningState(estimatedTokens, params.model);

      if (warningState.state !== "normal") {
        yield { type: "token_warning", warning: warningState };
      }

      if (warningState.state === "blocking") {
        yield {
          type: "error",
          error: new Error(
            `Context window limit reached (${estimatedTokens} tokens estimated, blocking limit ${warningState.blockingLimit}, window ${warningState.contextWindow}). ` +
            `Use /compact to free space.`,
          ),
        };
        yield { type: "turn_complete", reason: "blocking_limit", turnCount: nextTurnCount };
        return { state: { ...state, turnCount: nextTurnCount }, usage: totalUsage, lastCallUsage, reason: "blocking_limit" };
      }
    }

    const currentTools = params.getTools ? params.getTools() : params.tools;
    const stream = streamMessage({
      messages: [...state.messages],
      model: params.model,
      system: params.systemPrompt,
      tools: currentTools && currentTools.length > 0 ? currentTools : undefined,
      signal: params.abortSignal,
      // Stage 27: silent 64K escalation override (undefined → default cap).
      ...(maxOutputTokensOverride !== undefined ? { maxTokens: maxOutputTokensOverride } : {}),
      querySource: params.querySource,
    });

    let assistantContent: ContentBlock[] = [];
    let stopReason = "";
    // Stage 27: capture a surfaced stream error so the outer scope can decide
    // on a recovery path (reactive compact) instead of failing inline.
    let streamError: { error: Error; category?: string } | undefined;

    while (true) {
      const { value, done } = await stream.next();
      if (done) {
        const streamResult = value;
        if (!streamResult) {
          yield { type: "turn_complete", reason: "model_error", turnCount: nextTurnCount };
          return {
            state: { ...state, turnCount: nextTurnCount },
            usage: totalUsage,
            lastCallUsage,
            reason: "model_error",
          };
        }

        lastCallUsage = { ...streamResult.usage };
        totalUsage.input_tokens += streamResult.usage.input_tokens;
        totalUsage.output_tokens += streamResult.usage.output_tokens;
        totalUsage.cache_creation_input_tokens =
          (totalUsage.cache_creation_input_tokens ?? 0) + (streamResult.usage.cache_creation_input_tokens ?? 0);
        totalUsage.cache_read_input_tokens =
          (totalUsage.cache_read_input_tokens ?? 0) + (streamResult.usage.cache_read_input_tokens ?? 0);
        assistantContent = streamResult.assistantMessage.content as ContentBlock[];
        stopReason = streamResult.stopReason;
        break;
      }

      switch (value.type) {
        case "text":
          yield value;
          break;
        case "thinking_start":
        case "thinking_delta":
        case "thinking_done":
        case "redacted_thinking":
          yield value;
          break;
        case "tool_use_start":
          yield value;
          break;
        case "retry":
          // The API layer is backing off before re-issuing the request.
          // Surface it so the UI can show the countdown; no content was
          // streamed yet, so nothing needs clearing.
          yield {
            type: "api_retry",
            attempt: value.attempt,
            maxRetries: value.maxRetries,
            delayMs: value.delayMs,
            message: value.errorMessage,
          };
          break;
        case "error":
          // Capture and break; the post-stream block decides whether to
          // recover (reactive compact) or surface the error.
          streamError = { error: value.error, category: value.category };
          break;
      }
      if (streamError) break;
    }

    // ─── Stage 27: stream error handling (reactive compact) ──────────
    if (streamError) {
      // Prompt-too-long → summarize the history once and retry the turn.
      // Guarded by hasAttemptedReactiveCompact so we never loop on it.
      if (
        streamError.category === "prompt_too_long" &&
        !hasAttemptedReactiveCompact &&
        state.messages.length > 0
      ) {
        hasAttemptedReactiveCompact = true;
        try {
          const compactResult = await compactMessages(state.messages, undefined, {
            systemPrompt: params.systemPrompt,
            model: params.model,
            force: true,
          });
          if (compactResult.didCompact) {
            state = {
              messages: [...compactResult.messages],
              turnCount: state.turnCount,
              aborted: false,
            };
            // Clear any partially-streamed text and reset token override.
            maxOutputTokensOverride = undefined;
            yield { type: "stream_restart", reason: "reactive_compact" };
            continue;
          }
        } catch {
          // Compaction itself failed — fall through and surface the original.
        }
      }

      yield { type: "error", error: streamError.error };
      yield { type: "turn_complete", reason: "model_error", turnCount: nextTurnCount };
      return {
        state: { ...state, turnCount: nextTurnCount },
        usage: totalUsage,
        lastCallUsage,
        reason: "model_error",
      };
    }

    // ─── Stage 27: max_output_tokens two-phase recovery ──────────────
    if (stopReason === "max_tokens") {
      // Phase 1 — silent escalation: retry the SAME request at 64K without
      // touching the message history. Fires once per truncation episode.
      if (maxOutputTokensOverride === undefined) {
        maxOutputTokensOverride = ESCALATED_MAX_TOKENS;
        yield { type: "stream_restart", reason: "max_tokens_escalation" };
        continue; // turnCount unchanged — same turn, higher cap
      }

      // Phase 2 — multi-turn continuation: commit the (truncated) assistant
      // output, then inject a recovery prompt asking the model to resume.
      if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
        const truncatedAssistant: MessageParam = {
          role: "assistant",
          content: assistantContent as any,
        };
        state = {
          messages: [...state.messages, truncatedAssistant],
          turnCount: nextTurnCount,
          aborted: false,
        };
        yield { type: "assistant_message", message: truncatedAssistant };
        yield {
          type: "turn_usage",
          turnUsage: { ...lastCallUsage },
          cumulativeUsage: { ...totalUsage },
          turnCount: state.turnCount,
        };

        const recoveryMessage: MessageParam = {
          role: "user",
          content: MAX_OUTPUT_TOKENS_RECOVERY_PROMPT,
        };
        state = {
          messages: [...state.messages, recoveryMessage],
          turnCount: state.turnCount,
          aborted: false,
        };
        yield { type: "tool_result_message", message: recoveryMessage };

        maxOutputTokensRecoveryCount++;
        maxOutputTokensOverride = undefined; // let next attempt re-escalate
        continue;
      }
      // Recovery exhausted — fall through and treat the partial output as a
      // normal completed turn.
    }

    // Reset the escalation override before a normal (non-truncated) turn so
    // the next turn starts from the default cap.
    maxOutputTokensOverride = undefined;

    const assistantMessage: MessageParam = {
      role: "assistant",
      content: assistantContent as any,
    };
    const messagesWithAssistant = [...state.messages, assistantMessage];
    state = {
      messages: messagesWithAssistant,
      turnCount: nextTurnCount,
      aborted: false,
    };
    yield { type: "assistant_message", message: assistantMessage };
    // Per-turn usage event — let downstream consumers (notably
    // runChildAgent → subAgentProgressStore) update live counters
    // without having to wait for the loop's final return value.
    yield {
      type: "turn_usage",
      turnUsage: { ...lastCallUsage },
      cumulativeUsage: { ...totalUsage },
      turnCount: state.turnCount,
    };

    if (stopReason !== "tool_use") {
      // ─── Stage 22: Stop hook ──────────────────────────────────────
      // Fire user-defined Stop hooks before the loop returns. A hook
      // can inject extra context that becomes a user message and
      // continues the loop ("not done yet — keep going"), or it can
      // just observe the final assistant message and emit telemetry.
      //
      // `stopHookFired` is the local equivalent of source's
      // `stop_hook_active` flag — once a Stop hook has caused us to
      // re-enter the loop, we skip the hook on the second pass so
      // misbehaving hooks can't trigger an infinite re-prompt cycle.
      //
      // Mirror: claude-code-source-code/src/utils/hooks.ts:executeStopHooks
      if (!stopHookFired) {
        const lastAssistantText = extractLastAssistantText(assistantContent);
        const stopOutcome = params.subagentInfo
          ? await runSubagentStopHooks({
              agentId: params.subagentInfo.agentId,
              agentType: params.subagentInfo.agentType,
              lastAssistantMessage: lastAssistantText,
              cwd: params.toolContext.cwd,
              signal: params.abortSignal,
            })
          : await runStopHooks({
              lastAssistantMessage: lastAssistantText,
              cwd: params.toolContext.cwd,
              signal: params.abortSignal,
            });

        const continuationText =
          stopOutcome.blockingError || stopOutcome.additionalContext;
        if (continuationText) {
          stopHookFired = true;
          const continuationMessage: MessageParam = {
            role: "user",
            content: `[stop-hook]\n${continuationText}`,
          };
          state = {
            messages: [...state.messages, continuationMessage],
            turnCount: state.turnCount,
            aborted: false,
          };
          yield { type: "tool_result_message", message: continuationMessage };
          continue;
        }
      }

      yield { type: "turn_complete", reason: "completed", turnCount: state.turnCount };
      return { state, usage: totalUsage, lastCallUsage, reason: "completed" };
    }

    const { toolResultsMessage, executions, permissionRequests } = await runTools(
      assistantContent,
      {
        ...params.toolContext,
        abortSignal: params.abortSignal,
      },
      {
        permissionMode: params.permissionMode,
        permissionSettings: params.permissionSettings,
        sessionPermissionRules: params.sessionPermissionRules,
        onPermissionRequest: params.onPermissionRequest,
        shouldAvoidPermissionPrompts: params.shouldAvoidPermissionPrompts,
        conversationMessages: state.messages,
        model: params.model,
      },
    );

    for (const request of permissionRequests) {
      yield { type: "permission_request", request };
    }

    for (const execution of executions) {
      yield {
        type: "tool_use_done",
        id: execution.toolUseId,
        name: execution.toolName,
        input: execution.toolInput,
        result: execution.result,
      };
    }

    state = {
      messages: [...state.messages, toolResultsMessage],
      turnCount: state.turnCount,
      aborted: false,
    };
    yield { type: "tool_result_message", message: toolResultsMessage };
  }

  yield { type: "turn_complete", reason: "max_turns", turnCount: state.turnCount };
  return {
    state,
    usage: totalUsage,
    lastCallUsage,
    reason: "max_turns",
  };
}
