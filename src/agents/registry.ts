/**
 * Agent registry — in-memory lookup table for every loaded
 * AgentDefinition (built-in + user-scope + project-scope merged).
 *
 * Insertion order matters: the bootstrap places built-ins first, user
 * agents second, project agents third — and `Map.set()` overwrites on
 * collision, so project > user > built-in by name. Same precedence
 * model as skills/registry.ts.
 */

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

export function findAgent(agentType: string): AgentDefinition | undefined {
  return agents.get(agentType);
}

export function getAllAgents(): AgentDefinition[] {
  return [...agents.values()];
}

/** Drop everything — only used by tests / hot reload. */
export function clearAgents(): void {
  agents.clear();
  initialized = false;
}
