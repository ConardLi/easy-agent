/**
 * Tool-pool resolver for sub-agents.
 *
 *   - filterToolsForAgent (drops Agent + DISALLOWED_TOOLS)
 *   - resolveAgentTools (intersects with `tools` allow-list)
 *
 * Built-in and custom agents share one rule: the Agent tool itself is
 * stripped unconditionally so a sub-agent can never spawn another
 * sub-agent.
 */

import type { Tool } from "../tools/Tool.js";
import type { AgentDefinition } from "./types.js";

export const AGENT_TOOL_NAME = "Agent";

export interface ResolvedAgentTools {
  /** True when the agent allows everything that survives filtering
   * (no explicit `tools` list, or `tools: ['*']`). */
  hasWildcard: boolean;
  /** Tools the sub-agent will actually receive in its API call. */
  resolvedTools: Tool[];
  /** Names listed in `tools` that don't match any registered tool — surfaced
   * to the UI / log so misconfigured agent files don't fail silently. */
  invalidTools: string[];
}

/**
 * Build the sub-agent's tool pool from the parent's pool, the agent's
 * allow-list, and the agent's deny-list.
 *
 * Algorithm (in order):
 *   1. Strip the `Agent` tool. Sub-agents must not spawn sub-sub-agents
 *      — this is the "no recursion" guarantee.
 *   2. Apply `disallowedTools` (acts even when `tools` is wildcard).
 *   3. If `tools` is undefined or `['*']`, keep everything that survives.
 *   4. Otherwise, filter down to the named subset (in declaration order,
 *      deduped). Names that don't resolve are returned in `invalidTools`
 *      so the loader can warn the user.
 */
export function resolveAgentTools(
  agentDefinition: Pick<AgentDefinition, "tools" | "disallowedTools">,
  availableTools: Tool[],
): ResolvedAgentTools {
  const noAgentTool = availableTools.filter((t) => t.name !== AGENT_TOOL_NAME);
  const disallowed = new Set(agentDefinition.disallowedTools ?? []);
  const afterDisallow = noAgentTool.filter((t) => !disallowed.has(t.name));

  const tools = agentDefinition.tools;
  const hasWildcard =
    !tools || tools.length === 0 || (tools.length === 1 && tools[0] === "*");
  if (hasWildcard) {
    return { hasWildcard: true, resolvedTools: afterDisallow, invalidTools: [] };
  }

  const byName = new Map<string, Tool>();
  for (const t of afterDisallow) byName.set(t.name, t);

  const resolvedTools: Tool[] = [];
  const seen = new Set<string>();
  const invalidTools: string[] = [];
  for (const wanted of tools) {
    const t = byName.get(wanted);
    if (!t) {
      invalidTools.push(wanted);
      continue;
    }
    if (!seen.has(t.name)) {
      seen.add(t.name);
      resolvedTools.push(t);
    }
  }

  return { hasWildcard: false, resolvedTools, invalidTools };
}
