/**
 * runChildAgent — execute one sub-agent invocation end-to-end.
 *
 * Reference: claude-code-source-code/src/tools/AgentTool/runAgent.ts.
 * The source's runAgent is ~600 lines and handles fork mode, async tasks,
 * worktree isolation, MCP setup, plugin loading, etc. Stage 19 keeps the
 * core slice: build the sub-agent's tool pool, set up its system prompt,
 * run an isolated agentic loop with its own message history, and pull
 * the final text back as the result the parent will see.
 *
 * What this DOES:
 *   - Filter the parent's tool pool through resolveAgentTools.
 *   - Build a fresh `MessageParam[]` containing only the prompt as the
 *     opening user message (no parent history → context isolation).
 *   - Run the same `query()` loop the parent uses, with its own maxTurns.
 *   - Share the parent's permission infrastructure (settings + session
 *     rules + onPermissionRequest) so an "allow_always" decision in the
 *     sub-agent persists across the whole turn.
 *
 * What this DOESN'T:
 *   - Fork mode (inherit parent context) — deferred per §19.7.
 *   - Background / async execution — stage 20.
 *   - Worktree isolation — stage 20.
 *   - Resume / persisted sub-agent sessions — deferred.
 */

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { query, type LoopTerminationReason } from "../core/agenticLoop.js";
import { toolToApiParam, type Tool, type ToolContext } from "../tools/Tool.js";
import type {
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PermissionRuleSet,
  PermissionSettings,
} from "../permissions/permissions.js";
import { resolveAgentTools } from "./resolveAgentTools.js";
import type { AgentDefinition, AgentRunResult } from "./types.js";
import type { ContentBlock, Usage } from "../types/message.js";
import {
  drainUnreadMessages,
  formatMailboxAttachment,
} from "../utils/teammateMailbox.js";

export const DEFAULT_AGENT_MAX_TURNS = 30;

/** Streamed progress events forwarded to the parent's onProgress callback. */
export type AgentProgressEvent =
  | { type: "tool_use_start"; toolName: string }
  | { type: "tool_use_done"; toolName: string; isError?: boolean }
  | { type: "text"; text: string }
  | { type: "error"; text: string }
  | { type: "turn_complete"; reason: LoopTerminationReason }
  | {
      /**
       * Per-turn usage delta forwarded out of the inner agentic loop.
       * `cumulativeUsage` is everything the sub-agent has spent so far
       * (input + output + cache). The parent's AgentTool publishes this
       * to subAgentProgressStore so the SubAgentCard can show "28.0k
       * tokens" updating LIVE while the sub-agent is still working —
       * matching the per-agent token line in Claude Code's UI.
       */
      type: "turn_usage";
      cumulativeUsage: Usage;
      turnCount: number;
    };

export interface RunChildAgentParams {
  agentDefinition: AgentDefinition;
  /** Self-contained task description — becomes the sub-agent's first user message. */
  prompt: string;
  /** The parent's full tool pool (will be filtered by resolveAgentTools). */
  availableTools: Tool[];
  /** Resolved model name for this sub-agent. */
  model: string;
  /** Parent's tool context — used for cwd + sessionId base + abort signal. */
  parentToolContext: ToolContext;
  permissionMode?: PermissionMode;
  permissionSettings?: PermissionSettings;
  sessionPermissionRules?: PermissionRuleSet;
  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionDecision>;
  /**
   * Headless flag — see RunQueryParams.shouldAvoidPermissionPrompts in
   * core/agenticLoop.ts. Set by `runAsyncAgentLifecycle` for backgrounded
   * sub-agents so any "ask" decision is auto-denied with a workaround
   * message instead of bubbling up to the parent UI. Mirrors source's
   * `isAsync → shouldAvoidPermissionPrompts: true` wiring in
   * claude-code-source-code/src/tools/AgentTool/runAgent.ts:436-451.
   */
  shouldAvoidPermissionPrompts?: boolean;
  abortSignal?: AbortSignal;
  /** Optional progress callback for surface in the UI. */
  onProgress?: (event: AgentProgressEvent) => void;
  /**
   * Override the working directory used by every sub-agent tool call
   * (Read/Write/Edit/Bash all resolve paths from `context.cwd`).
   * Stage 20 sets this to the worktree path when `isolation: "worktree"`
   * is requested. Falls back to the parent's cwd when omitted.
   */
  cwdOverride?: string;
  /**
   * Optional sub-session-id override. Stage 20's async path threads its
   * `agentId` through here so transcript files / TodoWrite scopes line
   * up with the public id the parent agent sees in the
   * `<task-notification>`.
   */
  sessionIdOverride?: string;
  /**
   * Stage 21 — Agent Teams identity. When set, this sub-agent runs as a
   * named teammate:
   *   1. Its tool context exposes the identity so SendMessage's `from`
   *      field reflects the teammate's name (not "team-lead").
   *   2. Any unread mailbox messages for this teammate are drained and
   *      injected ahead of the opening user prompt — the teammate sees
   *      pending coordination notes the moment it starts thinking.
   *
   * Undefined when the sub-agent is a regular (un-named) Agent call —
   * stage 19/20 paths stay byte-identical.
   */
  teammateIdentity?: {
    agentId: string;
    agentName: string;
    teamName: string;
  };
}

/**
 * Walk back through assistant messages to find the most recent one with
 * actual text content. Mirrors source code's `finalizeAgentTool` fallback:
 * if the loop terminated mid-tool-call, the very last assistant message
 * may be a pure tool_use block — we want the last *textual* response.
 */
function extractFinalAssistantText(messages: MessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const content = m.content;
    if (typeof content === "string") {
      const trimmed = content.trim();
      if (trimmed) return trimmed;
      continue;
    }
    const textBlocks = (content as ContentBlock[]).filter(
      (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
    );
    const joined = textBlocks.map((b) => b.text).join("\n").trim();
    if (joined) return joined;
  }
  return "(Sub-agent completed but produced no text output.)";
}

function countToolUses(messages: MessageParam[]): number {
  let count = 0;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const content = m.content;
    if (typeof content === "string") continue;
    for (const block of content as ContentBlock[]) {
      if (block.type === "tool_use") count++;
    }
  }
  return count;
}

export async function runChildAgent(params: RunChildAgentParams): Promise<AgentRunResult> {
  const startTime = Date.now();
  const def = params.agentDefinition;
  const resolved = resolveAgentTools(def, params.availableTools);
  const toolApiParams = resolved.resolvedTools.map(toolToApiParam);

  // Sub-agent gets its own session id so its TodoWrite / Task state
  // doesn't pollute the parent's. Format keeps the parent's id as a
  // prefix for grep-ability when debugging from a session transcript.
  // Stage 20 lets the caller override this so the public agentId in
  // the <task-notification> matches the on-disk session scope.
  const subSessionId =
    params.sessionIdOverride ??
    (params.parentToolContext.sessionId
      ? `${params.parentToolContext.sessionId}/agent-${def.agentType}-${Date.now().toString(36)}`
      : `agent-${def.agentType}-${Date.now().toString(36)}`);

  const subPermissionMode: PermissionMode =
    def.permissionMode ?? params.permissionMode ?? "default";

  const subToolContext: ToolContext = {
    // Stage 20: when isolation: "worktree" is requested, the AgentTool
    // passes the worktree path here so EVERY sub-agent tool call
    // (Read/Write/Edit/Bash) resolves against the isolated tree.
    cwd: params.cwdOverride ?? params.parentToolContext.cwd,
    abortSignal: params.abortSignal,
    sessionId: subSessionId,
    // Sub-agent reads its own mode — isolating plan-mode transitions
    // (Enter/ExitPlanMode) from the parent's mode state.
    getPermissionMode: () => subPermissionMode,
    // Stage 21: thread teammate identity into the sub-agent's tool
    // context so SendMessage's `from` resolves correctly.
    ...(params.teammateIdentity
      ? { teammateIdentity: params.teammateIdentity }
      : {}),
  };

  // Stage 21: pre-loop mailbox drain.
  //
  // If this sub-agent is a named teammate, we read its inbox right
  // before kicking off the loop and prepend any unread messages as a
  // <teammate-messages> attachment in the opening user turn. This
  // mirrors source's `getTeammateMailboxAttachments` call inside
  // inProcessRunner.ts — the in-process teammate path always picks up
  // pending mailbox traffic before its first model call.
  //
  // Why prepend (vs separate first message): two distinct user-role
  // messages with no assistant in between would surface as a single
  // doubled-up prompt to the API anyway. Combining them keeps the
  // conversation shape simple and saves us a round trip.
  const initialMessages: MessageParam[] = [];
  if (params.teammateIdentity) {
    const unread = await drainUnreadMessages(
      params.teammateIdentity.agentName,
      params.teammateIdentity.teamName,
    );
    if (unread.length > 0) {
      initialMessages.push({
        role: "user",
        content: `${formatMailboxAttachment(unread)}\n\n${params.prompt}`,
      });
    } else {
      initialMessages.push({ role: "user", content: params.prompt });
    }
  } else {
    initialMessages.push({ role: "user", content: params.prompt });
  }

  // Stage 22: id we'll use for SubagentStop hooks. Sync sub-agents
  // don't have a persistent agent id (only async/background ones do),
  // so we mint a per-invocation one here. Hook authors can match on
  // `agent_type` for type-level rules.
  const agentIdForHooks = params.teammateIdentity?.agentName
    ? `teammate:${params.teammateIdentity.teamName}:${params.teammateIdentity.agentName}`
    : `${def.agentType}:${Date.now()}`;

  const loop = query({
    messages: initialMessages,
    systemPrompt: def.getSystemPrompt(),
    tools: toolApiParams,
    model: params.model,
    abortSignal: params.abortSignal,
    toolContext: subToolContext,
    maxTurns: def.maxTurns ?? DEFAULT_AGENT_MAX_TURNS,
    permissionMode: subPermissionMode,
    permissionSettings: params.permissionSettings,
    sessionPermissionRules: params.sessionPermissionRules,
    onPermissionRequest: params.onPermissionRequest,
    shouldAvoidPermissionPrompts: params.shouldAvoidPermissionPrompts,
    subagentInfo: { agentId: agentIdForHooks, agentType: def.agentType },
    // Stage 27: a backgrounded sub-agent has no one waiting on its result, so
    // a 529 capacity overload should fail fast rather than amplify load.
    // Interactive sub-agents stay foreground (retry 529).
    querySource: params.shouldAvoidPermissionPrompts ? "background" : "foreground",
  });

  let finalMessages: MessageParam[] = [];
  let totalUsage: Usage = { input_tokens: 0, output_tokens: 0 };
  let turnCount = 0;
  let reason: LoopTerminationReason = "completed";

  while (true) {
    const { value, done } = await loop.next();
    if (done) {
      finalMessages = value.state.messages;
      totalUsage = value.usage;
      turnCount = value.state.turnCount;
      reason = value.reason;
      break;
    }
    if (params.onProgress) {
      switch (value.type) {
        case "tool_use_start":
          params.onProgress({ type: "tool_use_start", toolName: value.name });
          break;
        case "tool_use_done":
          params.onProgress({
            type: "tool_use_done",
            toolName: value.name,
            isError: value.result.isError,
          });
          break;
        case "text":
          params.onProgress({ type: "text", text: value.text });
          break;
        case "error":
          params.onProgress({ type: "error", text: value.error.message });
          break;
        case "turn_complete":
          params.onProgress({ type: "turn_complete", reason: value.reason });
          break;
        case "turn_usage":
          params.onProgress({
            type: "turn_usage",
            cumulativeUsage: value.cumulativeUsage,
            turnCount: value.turnCount,
          });
          break;
        default:
          break;
      }
    }
  }

  const totalToolUseCount = countToolUses(finalMessages);
  const finalText = extractFinalAssistantText(finalMessages);
  const totalDurationMs = Date.now() - startTime;
  const totalTokens = (totalUsage.input_tokens ?? 0) + (totalUsage.output_tokens ?? 0);

  const warnings: string[] = [];
  if (resolved.invalidTools.length > 0) {
    warnings.push(
      `Agent '${def.agentType}' references unknown tools that were ignored: ${resolved.invalidTools.join(", ")}`,
    );
  }

  return {
    agentType: def.agentType,
    finalText,
    messages: finalMessages,
    totalToolUseCount,
    totalDurationMs,
    totalTokens,
    inputTokens: totalUsage.input_tokens ?? 0,
    outputTokens: totalUsage.output_tokens ?? 0,
    turnCount,
    reason,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
