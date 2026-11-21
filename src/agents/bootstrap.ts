/**
 * Agents startup orchestration — single entry point called from cli.ts.
 *
 * Mirrors the shape of services/skills/bootstrap.ts so the CLI can fire
 * both subsystems with the same idiom. Built-ins always load first; custom
 * agents are layered on top with project-scope overriding user-scope by
 * the order of `loadAllCustomAgents`.
 */

import { loadAllCustomAgents } from "./loadAgentsDir.js";
import { getBuiltInAgents } from "./builtIn/index.js";
import { setAgents } from "./registry.js";
import { withRuntimeScope } from "../state/runtimeScope.js";

export interface AgentsBootstrapResult {
  builtInCount: number;
  customCount: number;
  warnings: string[];
}

export const bootstrapAgents = withRuntimeScope(async (cwd: string): Promise<AgentsBootstrapResult> => {
  const builtIns = getBuiltInAgents();
  const { agents: custom, warnings } = await loadAllCustomAgents(cwd);

  // Built-ins first → user/project custom agents on top. Map.set() inside
  // setAgents overwrites by name, so a project-scope `Explore.md` cleanly
  // shadows the built-in Explore agent.
  setAgents([...builtIns, ...custom]);

  for (const w of warnings) {
    console.warn(`[easy-agent] ${w}`);
  }

  return {
    builtInCount: builtIns.length,
    customCount: custom.length,
    warnings,
  };
});
