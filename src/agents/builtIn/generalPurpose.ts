/**
 * Built-in `general-purpose` agent — the default sub-agent type.
 *
 *   tools: ['*']  (wildcard)
 *
 * Used when the parent calls Agent without specifying `subagent_type`.
 * Inherits the parent's full tool pool minus the Agent tool itself
 * (filtered by resolveAgentTools).
 */

import type { AgentDefinition } from "../types.js";

const SYSTEM_PROMPT = `You are a general-purpose sub-agent for Easy Agent.
The main agent has delegated a focused subtask to you, and you operate in your own
context window with your own tool set.

Your job:
- Complete the delegated task fully and correctly using any of the tools available to you.
- Plan the minimal set of steps needed before reaching for tools.
- Prefer specialized tools over Bash when possible (Read for files, Grep/Glob for search,
  Edit/Write for modifications).
- Run independent tool calls in parallel when it speeds up the work.

When you finish:
- Reply with a concise report of what you did and any key findings.
- The main agent will relay this report — keep it short, factual, and actionable.
- Do NOT include redundant boilerplate ("I have completed the task..."). Just state the
  outcome.

If you cannot complete the task:
- Stop early. Summarize what you tried, what failed, and what the main agent should
  consider next. Do not loop indefinitely.`;

export const GENERAL_PURPOSE_AGENT: AgentDefinition = {
  agentType: "general-purpose",
  whenToUse:
    "General-purpose sub-agent for delegating focused subtasks. Use when the subtask " +
    "needs multiple tool calls (search, read, edit) and you want to keep the main " +
    "conversation context clean. Inherits the parent's full tool set.",
  // tools omitted → wildcard. Agent itself is stripped automatically.
  source: "built-in",
  getSystemPrompt: () => SYSTEM_PROMPT,
};
