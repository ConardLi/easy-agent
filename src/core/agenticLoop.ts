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
import { findToolByName } from "../tools/index.js";
import { truncateToolResult, type ToolContext, type ToolResult } from "../tools/Tool.js";
import {
  activateConditionalSkillsForPaths,
  extractToolFilePaths,
} from "../services/skills/conditional.js";
import { tokenCountWithEstimation } from "../utils/tokens.js";
import { isAtBlockingLimit, calculateTokenWarningState, type TokenWarningResult } from "../context/autoCompact.js";
import type { ContentBlock, ToolUseBlock, Usage } from "../types/message.js";

export const MAX_TOOL_TURNS = 50;

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
}

export interface RunToolsOptions {
  permissionMode?: PermissionMode;
  permissionSettings?: PermissionSettings;
  sessionPermissionRules?: PermissionRuleSet;
  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionDecision>;
  /** See RunQueryParams.shouldAvoidPermissionPrompts. */
  shouldAvoidPermissionPrompts?: boolean;
}

/**
 * Maximum number of concurrency-safe tools to run in parallel within a
 * single batch. Mirrors source's `getMaxToolUseConcurrency()` (default
 * 10) — high enough to amortize a fan-out across many sub-agents,
 * low enough that the OS doesn't choke on subprocess explosions.
 */
const MAX_TOOL_USE_CONCURRENCY = 10;

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
    const liveMode = context.getPermissionMode?.() as PermissionMode | undefined;
    const permission = await checkPermission({
      tool,
      input: toolInput,
      cwd: context.cwd,
      mode: liveMode ?? options.permissionMode,
      settings: options.permissionSettings,
      sessionRules: options.sessionPermissionRules,
    });

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
    const rawResult = await tool.call(toolInput, callContext);
    const result: ToolResult = {
      ...rawResult,
      content: truncateToolResult(rawResult.content, tool.maxResultSizeChars),
    };

    if (!result.isError) {
      const filePaths = extractToolFilePaths(block.name, toolInput);
      if (filePaths.length > 0) {
        activateConditionalSkillsForPaths(filePaths, context.cwd);
      }
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
    });

    let assistantContent: ContentBlock[] = [];
    let stopReason = "";

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
        case "tool_use_start":
          yield value;
          break;
        case "error":
          yield { type: "error", error: value.error };
          yield { type: "turn_complete", reason: "model_error", turnCount: nextTurnCount };
          return {
            state: { ...state, turnCount: nextTurnCount },
            usage: totalUsage,
            lastCallUsage,
            reason: "model_error",
          };
      }
    }

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
