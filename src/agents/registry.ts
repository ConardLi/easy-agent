/**
 * Agent registry — in-memory lookup table for every loaded
 * AgentDefinition (built-in + user-scope + project-scope merged).
 *
 * Insertion order matters: the bootstrap places built-ins first, user
 * agents second, project agents third — and `Map.set()` overwrites on
 * collision, so project > user > built-in by name. Same precedence
 * model as skills/registry.ts.
 *
 * The registry holds every loaded definition; `findAgent` and
 * `getAllAgents` return only the sub-agents the Agent keeps
 * (`agents.include` / `agents.exclude`), built in or from the user, the
 * project, or a plugin. `getRegisteredAgents()` returns all of them, for
 * views that show what the Agent leaves out.
 */

import { activeHarness } from "../harness/active.js";
import type { ResolvedHarness } from "../harness/resolve.js";
import { selectionOffReason } from "../harness/selection.js";
import type { AgentDefinition } from "./types.js";

const agents = new Map<string, AgentDefinition>();
let initialized = false;

/**
 * Replace the registry with a fresh set. Called once at startup by
 * bootstrapAgents(). Overwrites the previous contents entirely.
 */
export function setAgents(definitions: AgentDefinition[]): void {
  agents.clear();
  for (const def of definitions) {
    agents.set(def.agentType, def);
  }
  initialized = true;
}

export function isAgentsInitialized(): boolean {
  return initialized;
}

/** Why the Agent leaves out the sub-agent `agentType`, or undefined when it keeps it. */
export function subAgentOffByAgent(agentType: string, resolved: ResolvedHarness = activeHarness()): string | undefined {
  return selectionOffReason(resolved, "agents", agentType);
}

/** A loaded sub-agent the Agent keeps. */
export function findAgent(agentType: string): AgentDefinition | undefined {
  const def = agents.get(agentType);
  return def && !subAgentOffByAgent(agentType) ? def : undefined;
}

/** Why a loaded sub-agent is left out by the Agent; undefined when it is kept or no such sub-agent is loaded. */
export function loadedSubAgentOffByAgent(agentType: string): string | undefined {
  return agents.has(agentType) ? subAgentOffByAgent(agentType) : undefined;
}

/** The loaded sub-agents the Agent keeps. */
export function getAllAgents(resolved: ResolvedHarness = activeHarness()): AgentDefinition[] {
  return [...agents.values()].filter((def) => !subAgentOffByAgent(def.agentType, resolved));
}

/** Every loaded sub-agent, including the ones the Agent leaves out. */
export function getRegisteredAgents(): AgentDefinition[] {
  return [...agents.values()];
}

/** Drop everything — only used by tests / hot reload. */
export function clearAgents(): void {
  agents.clear();
  initialized = false;
}
