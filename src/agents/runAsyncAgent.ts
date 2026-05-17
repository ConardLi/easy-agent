/**
 * runAsyncAgentLifecycle — fire-and-forget background sub-agent runner.
 *
 * Reference: claude-code-source-code/src/tools/AgentTool/agentToolUtils.ts
 *   `runAsyncAgentLifecycle()` is the one source function whose contract
 *   the AgentTool calls into for backgrounded sub-agents. It runs the
 *   sub-agent's full agentic loop in the background, writes a transcript,
 *   and on termination publishes a `<task-notification>` so the parent
 *   conversation can pick it up at the next user submission.
 *
 * Stage 20 implementation:
 *   1. Subscribe to `runChildAgent`'s `onProgress` events and append each
 *      one to the .output JSONL file. This is what makes the file
 *      tail-able from the parent (`Read outputFile`).
 *   2. Mirror the same events into the asyncAgentStore so a future
 *      `/agents` UI panel can render live status.
 *   3. On any termination path (success, model error, abort), call
 *      `cleanupWorktreeIfNeeded` and then `enqueuePendingNotification`
 *      with the formatted `<task-notification>` block.
 *   4. Never throw — this function is invoked with `void runAsyncAgent
 *      Lifecycle(...)` so an unhandled rejection would land in the
 *      Node-level `unhandledRejection` channel and crash the CLI.
 */

import { runChildAgent } from "./runAgent.js";
import type { AgentDefinition } from "./types.js";
import {
  completeAsyncAgent,
  failAsyncAgent,
  updateAsyncAgentProgress,
  type AsyncAgentEntry,
} from "../state/asyncAgentStore.js";
import {
  enqueuePendingNotification,
  formatTaskNotification,
} from "../state/notificationStore.js";
import {
  appendTaskOutput,
  previewToolResult,
} from "../utils/taskOutput.js";
import {
  hasWorktreeChanges,
  removeAgentWorktree,
  type WorktreeInfo,
} from "../utils/worktree.js";
import type { Tool, ToolContext } from "../tools/Tool.js";
import type {
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PermissionRuleSet,
  PermissionSettings,
} from "../permissions/permissions.js";
import { setMemberActive } from "../utils/teamHelpers.js";

export interface RunAsyncAgentLifecycleParams {
  /** The freshly-registered store entry — its abortController is used for the run. */
  entry: AsyncAgentEntry;
  agentDefinition: AgentDefinition;
  prompt: string;
  description?: string;
  availableTools: Tool[];
  model: string;
  parentToolContext: ToolContext;
  permissionMode?: PermissionMode;
  permissionSettings?: PermissionSettings;
  sessionPermissionRules?: PermissionRuleSet;
  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionDecision>;
  /** Set when this run is using `isolation: "worktree"`. */
  worktreeInfo?: WorktreeInfo;
  /**
   * Stage 21 — when set, this background sub-agent is registered as a
   * named teammate. We propagate the identity into `runChildAgent` so
   * SendMessage sees the right `from`, and on termination we flip the
   * member's `isActive` flag to false in the team file (signal for
   * TeamDelete and for the lead to know the teammate is finished).
   */
  teammateIdentity?: {
    agentId: string;
    agentName: string;
    teamName: string;
  };
}

/**
 * Decide what to do with the worktree once the sub-agent terminates.
 *
 *   - No worktree → nothing to do.
 *   - Has uncommitted changes / new commits → keep, return path so the
 *     parent can show it in the notification.
 *   - Clean → `git worktree remove --force` + `git branch -D`.
 *
 * Returns the final worktree fields the notification should advertise
 * (path/branch are present *only* when we kept the worktree around).
 */
async function cleanupWorktreeIfNeeded(
  info: WorktreeInfo | undefined,
): Promise<{ worktreePath?: string; worktreeBranch?: string }> {
  if (!info) return {};
  let dirty = true; // fail-closed default
  try {
    dirty = await hasWorktreeChanges(info.worktreePath, info.headCommit);
  } catch {
    dirty = true;
  }
  if (dirty) {
    return { worktreePath: info.worktreePath, worktreeBranch: info.worktreeBranch };
  }
  // Clean → safe to remove. Best-effort: if removal fails we still
  // surface no worktree (the leftover is harmless and `git worktree
  // prune` will eventually clean it).
  await removeAgentWorktree(info);
  return {};
}

export async function runAsyncAgentLifecycle(
  params: RunAsyncAgentLifecycleParams,
): Promise<void> {
  const { entry } = params;
  const startTime = Date.now();

  // Header record — makes it obvious from a tail what kicked off this run.
  await appendTaskOutput(entry.outputFile, {
    type: "started",
    agentType: entry.agentType,
    ...(entry.description ? { description: entry.description } : {}),
    prompt: params.prompt,
  });

  try {
    const result = await runChildAgent({
      agentDefinition: params.agentDefinition,
      prompt: params.prompt,
      availableTools: params.availableTools,
      model: params.model,
      parentToolContext: params.parentToolContext,
      ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
      ...(params.permissionSettings ? { permissionSettings: params.permissionSettings } : {}),
      ...(params.sessionPermissionRules
        ? { sessionPermissionRules: params.sessionPermissionRules }
        : {}),
      ...(params.onPermissionRequest
        ? { onPermissionRequest: params.onPermissionRequest }
        : {}),
      // Headless mode for backgrounded sub-agents (source-aligned).
      // The agentic loop honours this by short-circuiting any "ask"
      // permission decision into an auto-deny with workaround
      // guidance, instead of bubbling a prompt up to the parent UI
      // (which would clobber the parent's permissionResolverRef and
      // freeze the user's input). See:
      //   - core/agenticLoop.ts → buildHeadlessDenialMessage
      //   - claude-code-source-code/src/tools/AgentTool/runAgent.ts:436-451
      //     (`isAsync → toolPermissionContext.shouldAvoidPermissionPrompts`)
      shouldAvoidPermissionPrompts: true,
      // Background path uses its OWN AbortController — pressing ESC on
      // the parent must not interrupt a backgrounded sub-agent.
      abortSignal: entry.abortController.signal,
      // Stage 20: route the worktree path into the sub-agent's tool
      // context if isolation is on.
      ...(params.worktreeInfo
        ? { cwdOverride: params.worktreeInfo.worktreePath }
        : {}),
      // Pin the sub-session-id to the public agentId so on-disk
      // transcripts and TodoWrite scopes are addressable by the same
      // string the model gets back in `async_launched`.
      sessionIdOverride: entry.agentId,
      // Stage 21: forward teammate identity so SendMessage's `from`
      // resolves correctly inside this sub-agent, and so the pre-loop
      // mailbox drain in runChildAgent picks up any pending messages.
      ...(params.teammateIdentity
        ? { teammateIdentity: params.teammateIdentity }
        : {}),

      onProgress: (event) => {
        // Mirror progress to BOTH the JSONL output file (for the parent's
        // Read tool) and the in-memory store (for any future UI).
        switch (event.type) {
          case "tool_use_start":
            void appendTaskOutput(entry.outputFile, {
              type: "tool_use",
              toolName: event.toolName,
            });
            updateAsyncAgentProgress(entry.agentId, {
              lastToolName: event.toolName,
            });
            break;
          case "tool_use_done": {
            const cur = entry.toolUseCount;
            const next = cur + 1;
            void appendTaskOutput(entry.outputFile, {
              type: "tool_result",
              toolName: event.toolName,
              isError: event.isError === true,
              preview: "(tool result truncated — see parent transcript)",
            });
            updateAsyncAgentProgress(entry.agentId, {
              toolUseCount: next,
              lastToolName: event.toolName,
            });
            // Local mirror so subsequent in-flight events see the bumped count.
            entry.toolUseCount = next;
            break;
          }
          case "text":
            void appendTaskOutput(entry.outputFile, {
              type: "text",
              text: event.text,
            });
            break;
          case "turn_usage": {
            const u = event.cumulativeUsage;
            const total =
              u.input_tokens +
              u.output_tokens +
              (u.cache_creation_input_tokens ?? 0) +
              (u.cache_read_input_tokens ?? 0);
            void appendTaskOutput(entry.outputFile, {
              type: "turn_usage",
              inputTokens: u.input_tokens,
              outputTokens: u.output_tokens,
              totalTokens: total,
              turn: event.turnCount,
            });
            updateAsyncAgentProgress(entry.agentId, {
              inputTokens: u.input_tokens,
              outputTokens: u.output_tokens,
              totalTokens: total,
              turnCount: event.turnCount,
            });
            break;
          }
          default:
            break;
        }
      },
    });

    const worktreeFinal = await cleanupWorktreeIfNeeded(params.worktreeInfo);

    const durationMs = Date.now() - startTime;
    await appendTaskOutput(entry.outputFile, {
      type: "completed",
      reason: result.reason,
      finalText: result.finalText,
      durationMs,
      totalTokens: result.totalTokens,
      toolUseCount: result.totalToolUseCount,
    });

    completeAsyncAgent(entry.agentId, result, worktreeFinal);

    // Killed sub-agents have reason: "aborted" and surface a slightly
    // different status in the notification so the parent doesn't
    // mistake an ESC'd run for a successful completion.
    const status: "completed" | "killed" =
      result.reason === "aborted" ? "killed" : "completed";

    enqueuePendingNotification({
      mode: "task-notification",
      text: formatTaskNotification({
        agentId: entry.agentId,
        agentType: entry.agentType,
        status,
        ...(entry.description ? { description: entry.description } : {}),
        outputFile: entry.outputFile,
        finalText: result.finalText,
        durationMs,
        totalTokens: result.totalTokens,
        toolUseCount: result.totalToolUseCount,
        ...worktreeFinal,
      }),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const durationMs = Date.now() - startTime;

    // Cleanup worktree even on failure — but with the same dirty-check
    // so we never delete in-progress edits.
    const worktreeFinal = await cleanupWorktreeIfNeeded(params.worktreeInfo);

    await appendTaskOutput(entry.outputFile, {
      type: "failed",
      error: message,
      durationMs,
    });

    failAsyncAgent(entry.agentId, message, durationMs);

    enqueuePendingNotification({
      mode: "task-notification",
      text: formatTaskNotification({
        agentId: entry.agentId,
        agentType: entry.agentType,
        status: "failed",
        ...(entry.description ? { description: entry.description } : {}),
        outputFile: entry.outputFile,
        error: message,
        durationMs,
        ...worktreeFinal,
      }),
    });
  } finally {
    // Stage 21: regardless of how this lifecycle ended (success,
    // failure, abort), flip the team-file member's isActive flag.
    // TeamDelete consults this flag to refuse deletion while any
    // teammate is still working, and SendMessage uses it to warn the
    // model about "offline" recipients. Best-effort — a stale flag
    // doesn't break correctness, just nags TeamDelete to refuse once.
    if (params.teammateIdentity) {
      try {
        await setMemberActive(
          params.teammateIdentity.teamName,
          params.teammateIdentity.agentName,
          false,
        );
      } catch {
        // Best-effort.
      }
    }
  }
}
