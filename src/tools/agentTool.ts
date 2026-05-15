/**
 * Agent tool — the model's "delegate to a sub-agent" handle.
 *
 * Reference: claude-code-source-code/src/tools/AgentTool/AgentTool.tsx.
 * The source's AgentTool input schema is huge (prompt, description,
 * subagent_type, model, run_in_background, name, team_name, mode,
 * isolation, cwd, …). Stage 19 implements just the four fields the
 * tutorial needs: prompt, description, subagent_type, model.
 *
 * Flow:
 *   1. Validate input + look up the AgentDefinition by name.
 *   2. Resolve the model (explicit override → agent default → parent's).
 *   3. Pull the parent's permission infrastructure off ToolContext (set
 *      by QueryEngine on the per-submit enriched context).
 *   4. Call runChildAgent — it runs an isolated agentic loop and returns
 *      the sub-agent's final text plus stats.
 *   5. Format the result so the parent model sees a structured summary.
 *
 * Plan-mode behavior: Agent declares `isReadOnly: true` (mirroring source
 * — the actual permission decisions happen on the sub-agent's individual
 * tool calls). However the permissions.ts plan-mode branch denies any
 * tool not in PLAN_ALLOWED_TOOLS, so Agent cannot be spawned during
 * planning anyway. This is intentional — sub-agents shouldn't run while
 * the user is iterating on a plan they haven't approved.
 */

import { findAgent, getAllAgents } from "../agents/registry.js";
import type { AgentIsolation, AgentRunResult } from "../agents/types.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { DEFAULT_MODEL } from "../services/api/client.js";
import type {
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PermissionRuleSet,
  PermissionSettings,
} from "../permissions/permissions.js";
import {
  completeSubAgentProgress,
  startSubAgentProgress,
  updateSubAgentProgress,
} from "../state/subAgentProgressStore.js";
import { registerAsyncAgent } from "../state/asyncAgentStore.js";
import { ensureTaskOutputFile } from "../utils/taskOutput.js";
import {
  createAgentWorktree,
  isInsideGitRepo,
  type WorktreeInfo,
} from "../utils/worktree.js";

// Stage 20: short id helper. Crypto-grade uniqueness isn't needed —
// agentIds are scoped to one CLI session and we use them as map keys.
function generateAgentId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// agentTool MUST avoid statically importing anything in the
// tools/* ↔ core/agenticLoop ↔ tools/* chain — otherwise the
// `tools/index.ts → BUILTIN_TOOLS includes agentTool → runAgent →
// agenticLoop → tools/index.ts` cycle hits a TDZ on `agentTool` itself
// before index.ts can finish initializing the BUILTIN_TOOLS array.
//
// Both helpers below dynamically import their dependencies at call-time,
// which breaks the cycle: by the time `agentTool.call()` runs, every
// module on the chain has finished evaluating its top-level code.
async function loadAllTools(): Promise<Tool[]> {
  const { getAllTools } = await import("./index.js");
  return getAllTools();
}

async function loadRunChildAgent(): Promise<
  typeof import("../agents/runAgent.js")["runChildAgent"]
> {
  const mod = await import("../agents/runAgent.js");
  return mod.runChildAgent;
}

async function loadRunAsyncAgentLifecycle(): Promise<
  typeof import("../agents/runAsyncAgent.js")["runAsyncAgentLifecycle"]
> {
  const mod = await import("../agents/runAsyncAgent.js");
  return mod.runAsyncAgentLifecycle;
}

interface AgentInput {
  prompt: string;
  description?: string;
  subagent_type?: string;
  model?: string;
  /** Stage 20: if true, return immediately and run the sub-agent in the background. */
  run_in_background?: boolean;
  /**
   * Stage 20: filesystem isolation level. Currently supports "worktree"
   * (creates a fresh `git worktree`) or "none". Per-call value overrides
   * the agent definition's `isolation` field.
   */
  isolation?: AgentIsolation;
}

function readInput(raw: Record<string, unknown>): AgentInput {
  const prompt = typeof raw["prompt"] === "string" ? raw["prompt"] : "";
  const description = typeof raw["description"] === "string" ? raw["description"] : undefined;
  const subagent_type =
    typeof raw["subagent_type"] === "string" ? raw["subagent_type"].trim() : undefined;
  const model = typeof raw["model"] === "string" ? raw["model"].trim() : undefined;
  const run_in_background =
    typeof raw["run_in_background"] === "boolean" ? raw["run_in_background"] : undefined;
  const rawIsolation = raw["isolation"];
  const isolation: AgentIsolation | undefined =
    rawIsolation === "worktree" || rawIsolation === "none" ? rawIsolation : undefined;
  return {
    prompt,
    description,
    subagent_type,
    model,
    ...(run_in_background !== undefined ? { run_in_background } : {}),
    ...(isolation !== undefined ? { isolation } : {}),
  };
}

function formatResult(args: {
  agentType: string;
  description?: string;
  result: AgentRunResult;
}): string {
  const { agentType, description, result } = args;
  const headerLines = [
    `Sub-agent '${agentType}' completed.`,
    description ? `task: ${description}` : "",
    `turns: ${result.turnCount} | tools used: ${result.totalToolUseCount} | duration: ${result.totalDurationMs}ms`,
    `tokens: ${result.totalTokens} (input ${result.inputTokens}, output ${result.outputTokens})`,
    result.reason !== "completed" ? `stop reason: ${result.reason}` : "",
    result.warnings && result.warnings.length > 0
      ? `warnings:\n${result.warnings.map((w) => `  - ${w}`).join("\n")}`
      : "",
  ].filter(Boolean);

  return [
    headerLines.join("\n"),
    "",
    "<sub_agent_result>",
    result.finalText,
    "</sub_agent_result>",
  ].join("\n");
}

export const agentTool: Tool = {
  name: "Agent",
  description:
    "Delegate a focused subtask to a specialized sub-agent. The sub-agent runs in its own context window with its own tool set, completes the task, and returns a concise summary. " +
    "Use this when the subtask requires multiple tool calls (search, read many files, etc.) and you want to keep the main conversation context clean. " +
    "Choose `subagent_type` based on the available sub-agent definitions listed in the system prompt's <system-reminder> block. Defaults to 'general-purpose' if omitted. " +
    "The sub-agent does NOT see the main conversation history — write a self-contained `prompt`.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "Self-contained task description for the sub-agent. The sub-agent has no access to the main conversation, so include all the context it needs.",
      },
      description: {
        type: "string",
        description: "A short (3-5 word) name for the task, shown in the UI.",
      },
      subagent_type: {
        type: "string",
        description:
          "Which sub-agent definition to use (e.g. 'general-purpose', 'Explore', or a custom name from .easy-agent/agents/). Defaults to 'general-purpose'.",
      },
      model: {
        type: "string",
        description:
          "Optional model override for this sub-agent. If omitted, the agent definition's `model` is used; if that is also omitted, the parent's model is used.",
      },
      run_in_background: {
        type: "boolean",
        description:
          "If true, the sub-agent runs in the background. The tool call returns immediately with `{ status: 'async_launched', agent_id, output_file }`. " +
          "You will be automatically notified via a `<task-notification>` user message when the sub-agent finishes — do NOT sleep, poll, or proactively check on its progress. " +
          "Use foreground (default) when you need the agent's results before you can proceed; use background only when you have independent work to do in parallel.",
      },
      isolation: {
        type: "string",
        enum: ["none", "worktree"],
        description:
          "Filesystem isolation level. 'worktree' runs the sub-agent inside a fresh `git worktree` so its file edits don't touch the main working copy until you review them. " +
          "When omitted, falls back to the agent definition's `isolation` field, then to 'none'. " +
          "Setting this explicitly OVERRIDES the agent definition — pass 'none' only when you have a strong reason to bypass an agent that was defined with worktree isolation. " +
          "Worktree isolation requires the working directory to be inside a git repository; otherwise the sub-agent runs without isolation and a warning is returned alongside the result.",
      },
    },
    required: ["prompt", "description"],
    additionalProperties: false,
  },

  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const {
      prompt,
      description,
      subagent_type,
      model,
      run_in_background,
      isolation,
    } = readInput(input);

    if (!prompt || !prompt.trim()) {
      return {
        content: "Error: 'prompt' is required and must be a non-empty string.",
        isError: true,
      };
    }

    const agentType = subagent_type || "general-purpose";
    const def = findAgent(agentType);
    if (!def) {
      const available = getAllAgents()
        .map((a) => a.agentType)
        .join(", ");
      return {
        content: `Error: sub-agent type '${agentType}' is not registered. Available types: ${available || "(none)"}.`,
        isError: true,
      };
    }

    // Sub-agent's tool pool is filtered from the parent's full pool.
    // resolveAgentTools (called inside runChildAgent) strips the Agent
    // tool itself and applies the agent's allow/deny lists. Loaded
    // lazily to avoid the tools/index.ts ↔ tools/agentTool.ts cycle.
    const allTools = await loadAllTools();

    // Model resolution (most specific wins):
    //   1. Per-call override (input.model)
    //   2. Agent definition's `model` field
    //   3. Parent's active model (set by QueryEngine on the context)
    //   4. DEFAULT_MODEL (env or hard-coded fallback)
    const resolvedModel =
      model || def.model || context.defaultModel || DEFAULT_MODEL;

    const permissionMode = context.getPermissionMode?.() as PermissionMode | undefined;
    const permissionSettings = context.permissionSettings as PermissionSettings | undefined;
    const sessionPermissionRules = context.sessionPermissionRules as
      | PermissionRuleSet
      | undefined;
    const onPermissionRequest = context.onPermissionRequest as
      | ((request: PermissionRequest) => Promise<PermissionDecision>)
      | undefined;

    // Stage 20: resolve isolation. Per-call > definition > "none".
    //
    // This precedence is intentional and mirrors source
    // (claude-code-source-code/src/tools/AgentTool/AgentTool.tsx:663:
    //   `const effectiveIsolation = isolation ?? selectedAgent.isolation`).
    // The agent definition's `isolation` field acts as a DEFAULT, not a
    // hard floor — the model can override per-call. Users who want a
    // strict guarantee that "this agent always runs in a worktree"
    // should rely on:
    //   - the schema description (telling the model not to override
    //     without a strong reason), and
    //   - downstream review of the worktree path the tool result
    //     surfaces (an empty `worktree:` line in the result is a
    //     visible signal that isolation was skipped).
    // We could enforce a strict floor here, but diverging from source's
    // semantics would surprise readers cross-referencing the two repos.
    const effectiveIsolation: AgentIsolation =
      isolation ?? def.isolation ?? "none";

    let worktreeInfo: WorktreeInfo | undefined;
    let isolationWarning: string | undefined;
    if (effectiveIsolation === "worktree") {
      // Try to set up a worktree. If the cwd isn't a git repo, fall
      // back to no isolation but warn — the source's behaviour is
      // similar (it logs and continues with cwd).
      const inRepo = await isInsideGitRepo(context.cwd);
      if (!inRepo) {
        isolationWarning =
          "Worktree isolation requested but the working directory is not inside a git repository. Falling back to no isolation.";
      } else {
        try {
          // Slug the agent type so the dir/branch name is human-readable.
          const slug = `agent-${agentType.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-")}-${Date.now().toString(36)}`;
          worktreeInfo = await createAgentWorktree(slug, context.cwd);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          isolationWarning = `Failed to create worktree (${msg}). Falling back to no isolation.`;
        }
      }
    }

    // ─── Stage 20: async (run_in_background) branch ─────────────────
    //
    // When the model asks for backgrounding, we:
    //   1. Generate an agentId + ensure its .output JSONL file exists.
    //   2. registerAsyncAgent — gets us an independent AbortController
    //      and an entry in the in-memory store.
    //   3. Fire `runAsyncAgentLifecycle(...)` without await — the parent
    //      tool call returns IMMEDIATELY with `async_launched`.
    //   4. The lifecycle wrapper handles transcript writing, worktree
    //      cleanup, store completion, and notification enqueue.
    //
    // We never publish to subAgentProgressStore in the async path
    // because that store is keyed to the parent's tool_use card which
    // disappears as soon as we return. The async store + the
    // <task-notification> at the next user submit are the proper
    // surfaces for backgrounded progress.
    if (run_in_background === true) {
      const agentId = generateAgentId();
      const sessionIdForOutput = context.sessionId ?? "default";
      const outputFile = await ensureTaskOutputFile(sessionIdForOutput, agentId);

      const entry = registerAsyncAgent({
        agentId,
        agentType,
        ...(description ? { description } : {}),
        prompt,
        outputFile,
        isolated: !!worktreeInfo,
        ...(worktreeInfo ? { worktreePath: worktreeInfo.worktreePath } : {}),
        ...(worktreeInfo ? { worktreeBranch: worktreeInfo.worktreeBranch } : {}),
      });

      // Headless permission policy for background sub-agents.
      //
      // Architecture mirrors source — see
      // claude-code-source-code/src/tools/AgentTool/runAgent.ts:436-451
      // (`isAsync → toolPermissionContext.shouldAvoidPermissionPrompts`).
      // Source forwards canUseTool down to the sub-agent unchanged but
      // gates ask-prompt behaviour via a flag on the permission context.
      //
      // We do the same: forward the parent's `onPermissionRequest` as
      // usual (kept symmetric with the synchronous path), and rely on
      // `shouldAvoidPermissionPrompts: true` (set inside
      // runAsyncAgentLifecycle) to make the agentic loop short-circuit
      // any "ask" decision into an auto-deny with a workaround message.
      // Without this gating, a backgrounded sub-agent would:
      //
      //   1. clobber the single-slot permissionResolverRef in
      //      useAgentSession, deadlocking any foreground prompt;
      //   2. surface a prompt with no agentId, so the user has no way
      //      to know whose tool call they're approving;
      //   3. freeze InputPrompt (`Boolean(state.permissionPrompt)` is
      //      its disabled-flag), locking the user out of the main
      //      conversation while they're doing unrelated work.
      //
      // The denial trail (and any blocked tool the model fell back on)
      // is visible to the user in the .output JSONL and in the eventual
      // <task-notification>.
      const runAsyncLifecycle = await loadRunAsyncAgentLifecycle();
      // fire-and-forget — never awaited; rejections are swallowed by
      // the lifecycle's own try/catch.
      void runAsyncLifecycle({
        entry,
        agentDefinition: def,
        prompt,
        ...(description ? { description } : {}),
        availableTools: allTools,
        model: resolvedModel,
        parentToolContext: context,
        ...(permissionMode ? { permissionMode } : {}),
        ...(permissionSettings ? { permissionSettings } : {}),
        ...(sessionPermissionRules ? { sessionPermissionRules } : {}),
        ...(onPermissionRequest ? { onPermissionRequest } : {}),
        ...(worktreeInfo ? { worktreeInfo } : {}),
      });

      // Tool-result text the model sees after launching a background
      // sub-agent. Wording is taken almost verbatim from source's
      // claude-code-source-code/src/tools/AgentTool/AgentTool.tsx:1748-1753
      // ("Async agent launched successfully. … Work on non-overlapping
      // tasks, or briefly tell the user what you launched and end your
      // response. … If asked, you can check progress before completion
      // by using FileRead or Bash tail on the output file."), with two
      // very deliberate copy choices that we should NOT drift from:
      //
      //   1. The two follow-on options ("work on non-overlapping tasks"
      //      vs "briefly tell the user and end your response") are
      //      presented as equal alternatives joined by "or" — neither
      //      capitalised, neither emphasised. Earlier drafts of mine
      //      ALL-CAPSed "END YOUR RESPONSE" and the model dutifully
      //      stopped working entirely. Don't bias it.
      //
      //   2. The output_file check is gated by "If asked" — meaning
      //      the model is explicitly allowed to Read it when the user
      //      requests an update, but should NOT do so preemptively
      //      (which leads to the sleep+read loop the user reported).
      const summary = [
        `Async sub-agent '${agentType}' launched successfully.`,
        `agent_id: ${agentId} (internal — do not mention to the user)`,
        `output_file: ${outputFile}`,
        worktreeInfo
          ? `worktree: ${worktreeInfo.worktreePath} (branch: ${worktreeInfo.worktreeBranch})`
          : "",
        isolationWarning ? `warning: ${isolationWarning}` : "",
        "",
        "The agent is working in the background. You will be notified automatically via a `<task-notification>` user message when it completes.",
        "do NOT sleep, poll, or proactively check on its progress.",
        "Do not duplicate this agent's work — avoid working with the same files or topics it is using.",
        "Work on non-overlapping tasks (which may include launching MORE background agents in parallel for genuinely independent subtasks), or briefly tell the user what you launched and end your response. Either is fine; pick whichever fits the conversation.",
        "If the user explicitly asks for progress before completion, you may Read the output_file once or run `tail` on it.",
        "Do NOT spawn a duplicate sub-agent for the same task while this one is running.",
      ]
        .filter(Boolean)
        .join("\n");

      return {
        content: [
          summary,
          "",
          "<async_launched>",
          `  <agent_id>${agentId}</agent_id>`,
          `  <agent_type>${agentType}</agent_type>`,
          `  <output_file>${outputFile}</output_file>`,
          worktreeInfo ? `  <worktree_path>${worktreeInfo.worktreePath}</worktree_path>` : "",
          worktreeInfo ? `  <worktree_branch>${worktreeInfo.worktreeBranch}</worktree_branch>` : "",
          "</async_launched>",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }

    // ─── Synchronous branch (the original stage 19 flow) ────────────

    // The parent's tool_use id is our key into the sub-agent progress
    // store. UI subscribes to that store and merges live updates into
    // the matching ToolCallInfo. Without an id we can't correlate, so
    // we silently fall back to "no progress UI" — the tool still works.
    const progressKey = context.toolUseId;
    if (progressKey) {
      startSubAgentProgress(progressKey, {
        agentType,
        ...(description ? { description } : {}),
      });
    }

    // Map AgentProgressEvent (from the sub-agent's own loop) onto the
    // store's update API. We track tool count via tool_use_done (not
    // _start) to mirror the source's behavior of only counting completed
    // calls — avoids an inflated mid-call number flickering on the UI.
    const onProgress = progressKey
      ? (event: import("../agents/runAgent.js").AgentProgressEvent): void => {
          switch (event.type) {
            case "tool_use_start":
              // Optimistic update — show "running: <toolName>" the
              // moment the model emits the call, even before it
              // resolves. Count is incremented at done so it matches
              // the final tool-use total.
              updateSubAgentProgress(progressKey, {
                lastToolName: event.toolName,
                lastToolIsError: false,
              });
              break;
            case "tool_use_done":
              updateSubAgentProgress(progressKey, {
                lastToolName: event.toolName,
                lastToolIsError: event.isError === true,
              });
              break;
            case "turn_usage": {
              // Push the running token total to the store so the
              // SubAgentCard can render "28.0k tokens" live (matches
              // Claude Code's per-agent token line). We surface the
              // FULL accumulated cost — input + output + cache reads
              // + cache creation — because that's what the user
              // pays for and what the source counts in
              // calculateAgentStats (UI.tsx).
              const u = event.cumulativeUsage;
              const totalTokens =
                u.input_tokens +
                u.output_tokens +
                (u.cache_creation_input_tokens ?? 0) +
                (u.cache_read_input_tokens ?? 0);
              updateSubAgentProgress(progressKey, {
                inputTokens: u.input_tokens,
                outputTokens: u.output_tokens,
                totalTokens,
              });
              break;
            }
            default:
              break;
          }
        }
      : undefined;

    try {
      const runChildAgent = await loadRunChildAgent();
      const result = await runChildAgent({
        agentDefinition: def,
        prompt,
        availableTools: allTools,
        model: resolvedModel,
        parentToolContext: context,
        ...(permissionMode ? { permissionMode } : {}),
        ...(permissionSettings ? { permissionSettings } : {}),
        ...(sessionPermissionRules ? { sessionPermissionRules } : {}),
        ...(onPermissionRequest ? { onPermissionRequest } : {}),
        ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
        ...(onProgress ? { onProgress } : {}),
        // Stage 20: worktree-isolated runs override the cwd so every
        // file tool resolves against the worktree path.
        ...(worktreeInfo ? { cwdOverride: worktreeInfo.worktreePath } : {}),
      });

      // Stage 20: post-run worktree cleanup. Same dirty-check as the
      // async path — keep when there are uncommitted changes / new
      // commits, remove when clean. The path is appended to the result
      // payload so the model knows where the work landed.
      let worktreeFinal: { worktreePath?: string; worktreeBranch?: string } = {};
      if (worktreeInfo) {
        const { hasWorktreeChanges, removeAgentWorktree } = await import(
          "../utils/worktree.js"
        );
        let dirty = true;
        try {
          dirty = await hasWorktreeChanges(
            worktreeInfo.worktreePath,
            worktreeInfo.headCommit,
          );
        } catch {
          dirty = true;
        }
        if (dirty) {
          worktreeFinal = {
            worktreePath: worktreeInfo.worktreePath,
            worktreeBranch: worktreeInfo.worktreeBranch,
          };
        } else {
          await removeAgentWorktree(worktreeInfo);
        }
      }

      if (progressKey) {
        completeSubAgentProgress(progressKey, {
          reason: result.reason,
          durationMs: result.totalDurationMs,
          totalTokens: result.totalTokens,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          toolUseCount: result.totalToolUseCount,
        });
      }

      const formatted = formatResult({ agentType, description, result });
      const extras: string[] = [];
      if (isolationWarning) extras.push(`warning: ${isolationWarning}`);
      if (worktreeFinal.worktreePath) {
        extras.push(
          `worktree: ${worktreeFinal.worktreePath} (branch: ${worktreeFinal.worktreeBranch}) — uncommitted changes preserved.`,
        );
      }
      return {
        content:
          extras.length > 0 ? `${formatted}\n\n${extras.join("\n")}` : formatted,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);

      // Stage 20: even on failure, run the same cleanup pass. If the
      // sub-agent crashed mid-edit we want to keep the worktree.
      if (worktreeInfo) {
        const { hasWorktreeChanges, removeAgentWorktree } = await import(
          "../utils/worktree.js"
        );
        let dirty = true;
        try {
          dirty = await hasWorktreeChanges(
            worktreeInfo.worktreePath,
            worktreeInfo.headCommit,
          );
        } catch {
          dirty = true;
        }
        if (!dirty) {
          await removeAgentWorktree(worktreeInfo);
        }
      }

      if (progressKey) {
        // model_error is the closest LoopTerminationReason for "the
        // sub-agent threw" — runChildAgent itself didn't return because
        // the agentic loop crashed. The store maps this (with isError
        // also set) onto status: "error" for the UI.
        completeSubAgentProgress(progressKey, {
          reason: "model_error",
          durationMs: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          toolUseCount: 0,
          isError: true,
        });
      }
      return {
        content: `Error: sub-agent '${agentType}' failed to complete: ${msg}`,
        isError: true,
      };
    }
  },

  isReadOnly(): boolean {
    // Mirrors source: the Agent tool itself has no side effects — its
    // sub-agent's individual tool calls each go through their own
    // permission checks. Plan-mode still rejects Agent because plan
    // mode's allow-list only contains Read/Grep/Glob.
    return true;
  },

  isEnabled(): boolean {
    return true;
  },

  /**
   * Mirrors source (`AgentTool.tsx → isConcurrencySafe()` returns true).
   * Each sub-agent runs in its own isolated context and the only shared
   * state it touches — the parent's permission settings + session rules
   * + the per-call entry in subAgentProgressStore — is keyed by the
   * tool_use id, so two concurrent Agent invocations cannot collide.
   * This is the change that lets the model fan out N independent
   * sub-agents in a single assistant turn (e.g. "review code" + "audit
   * security" in parallel) instead of waiting on each one in series.
   */
  isConcurrencySafe(): boolean {
    return true;
  },
};
