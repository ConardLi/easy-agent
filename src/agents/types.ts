/**
 * AgentDefinition — describes one sub-agent the model can spawn via the
 * `Agent` tool. Per-agent `mcpServers`, `hooks`, `memory`, and `effort`
 * are not supported.
 *
 * Sources, in priority order:
 *   1. project — `<cwd>/.easy-agent/agents/*.md`   (highest)
 *   2. user    — `~/.easy-agent/agents/*.md`
 *   3. plugin  — `agents/` of an enabled plugin
 *   4. built-in — hard-coded in `src/agents/builtIn/`
 *
 * Collisions are resolved by name: a project-scope `Explore.md` overrides
 * the built-in Explore agent, and so on.
 */

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { LoopTerminationReason } from "../core/agenticLoop.js";

export type AgentSource = "built-in" | "user" | "project" | "plugin";

export type AgentPermissionMode = "default" | "plan" | "auto";

/**
 * How the sub-agent's filesystem is sandboxed.
 *  - "none"     : default — runs in the parent's cwd.
 *  - "worktree" : runs inside a fresh `git worktree` so its
 *                 file edits don't touch the main working copy until
 *                 the user reviews them.
 */
export type AgentIsolation = "none" | "worktree";

export interface AgentDefinition {
  /** Unique identifier — also the value passed as `subagent_type`. */
  agentType: string;

  /** Human-readable description shown in the system prompt to help the
   * model pick the right agent. */
  whenToUse: string;

  /**
   * Optional explicit allow-list of tool names the agent may use.
   * - Undefined / `['*']` → wildcard (everything except Agent itself).
   * - Otherwise → only listed names (intersected with the parent's pool).
   */
  tools?: string[];

  /** Tool names that are stripped even when `tools` is wildcard. */
  disallowedTools?: string[];

  /** Optional model override (e.g. `claude-haiku-4-...`). Falls back to
   * the parent's current model when omitted. */
  model?: string;

  /** Hard cap on the sub-agent's loop iterations. Defaults to
   * DEFAULT_AGENT_MAX_TURNS in runAgent.ts. */
  maxTurns?: number;

  /** Sub-agent's permission mode. Defaults to inheriting the parent's. */
  permissionMode?: AgentPermissionMode;

  /**
   * Default filesystem isolation level. The model can override per-call
   * via the `Agent` tool's `isolation` parameter; this field is the
   * fallback used when the call doesn't specify.
   */
  isolation?: AgentIsolation;

  /** Where this definition came from. */
  source: AgentSource;

  /** Owning plugin id (`name@marketplace`) when source is "plugin". */
  pluginId?: string;
  /** Owning plugin root directory, for provenance / reload / unload. */
  pluginRoot?: string;

  /** Absolute path to the source `.md` file (custom agents only). */
  filePath?: string;

  /**
   * Returns the system prompt for this agent. A function (not a string)
   * so built-ins can compose their prompt from helpers at call time.
   */
  getSystemPrompt(): string;
}

/** Result returned by `runChildAgent`. */
export interface AgentRunResult {
  agentType: string;
  /** The sub-agent's final text message — what the parent will see. */
  finalText: string;
  /** Full message history of the sub-agent's loop (for debugging / tests). */
  messages: MessageParam[];
  totalToolUseCount: number;
  totalDurationMs: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  turnCount: number;
  reason: LoopTerminationReason;
  /** Non-fatal warnings collected during the run (e.g. unknown tool
   * names referenced in the agent's `tools:` field). */
  warnings?: string[];
}
