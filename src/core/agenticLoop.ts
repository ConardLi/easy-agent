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
}

export interface RunToolsOptions {
  permissionMode?: PermissionMode;
  permissionSettings?: PermissionSettings;
  sessionPermissionRules?: PermissionRuleSet;
  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionDecision>;
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

  const toolResults: Array<{
    type: "tool_result";
    tool_use_id: string;
    content: string;
    is_error?: boolean;
  }> = [];
  const executions: ToolExecutionResult[] = [];
  const permissionRequests: PermissionRequest[] = [];

  for (const block of toolUseBlocks) {
    const toolInput = (block.input as Record<string, unknown>) ?? {};
    const tool = findToolByName(block.name);
    if (!tool) {
      const result: ToolResult = {
        content: `Error: Unknown tool "${block.name}"`,
        isError: true,
      };
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result.content,
        is_error: true,
      });
      executions.push({ toolUseId: block.id, toolName: block.name, toolInput, result });
      continue;
    }

    try {
      // Read live permission mode from tool context (updated by Enter/ExitPlanMode)
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
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result.content,
          is_error: true,
        });
        executions.push({ toolUseId: block.id, toolName: block.name, toolInput, result });
        continue;
      }

      if (permission.behavior === "ask") {
        permissionRequests.push(permission.request);
        const decision = options.onPermissionRequest
          ? await options.onPermissionRequest(permission.request)
          : "deny";

        if (decision === "deny") {
          const result: ToolResult = {
            content: `Permission denied for ${block.name}: user rejected the request`,
            isError: true,
          };
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result.content,
            is_error: true,
          });
          executions.push({ toolUseId: block.id, toolName: block.name, toolInput, result });
          continue;
        }

        if (decision === "allow_always") {
          const allowRules = options.sessionPermissionRules?.allow;
          if (allowRules && !allowRules.includes(permission.request.ruleHint)) {
            allowRules.push(permission.request.ruleHint);
          }
        }
      }

      const rawResult = await tool.call(toolInput, context);
      const result: ToolResult = {
        ...rawResult,
        content: truncateToolResult(rawResult.content, tool.maxResultSizeChars),
      };
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result.content,
        ...(result.isError && { is_error: true }),
      });
      executions.push({ toolUseId: block.id, toolName: block.name, toolInput, result });

      // Promote any conditional skills whose `paths` patterns match the
      // file the model just touched. The activation is sticky for the
      // remainder of the session — the new skill will appear in the next
      // system prompt rebuild (next user submit).
      if (!result.isError) {
        const filePaths = extractToolFilePaths(block.name, toolInput);
        if (filePaths.length > 0) {
          activateConditionalSkillsForPaths(filePaths, context.cwd);
        }
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error
        ? (error.stack ?? error.message)
        : String(error);
      const result: ToolResult = {
        content: `Error: ${errorMessage}`,
        isError: true,
      };
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result.content,
        is_error: true,
      });
      executions.push({ toolUseId: block.id, toolName: block.name, toolInput, result });
    }
  }

  return {
    toolResultsMessage: { role: "user", content: toolResults as any },
    executions,
    permissionRequests,
  };
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
