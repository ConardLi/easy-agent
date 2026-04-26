/**
 * Skills startup orchestration.
 *
 * Called once from the CLI entrypoint before the React UI mounts. Loads
 * skills from disk, populates the registry, and emits warnings for any
 * malformed SKILL.md files so users see them in the terminal scrollback
 * (the React UI hides them otherwise).
 *
 * Mirrors the shape of `services/mcp/bootstrap.ts` so the entrypoint can
 * fire-and-forget both subsystems with the same idiom.
 */

import { loadAllSkills } from "./loadSkillsDir.js";
import { setSkills } from "./registry.js";

export interface SkillsBootstrapResult {
  skillCount: number;
  conditionalCount: number;
  warnings: string[];
}

export async function bootstrapSkills(cwd: string): Promise<SkillsBootstrapResult> {
  const { skills, warnings } = await loadAllSkills(cwd);
  setSkills(skills);

  const conditionalCount = skills.filter(
    (s) => s.frontmatter.paths && s.frontmatter.paths.length > 0,
  ).length;

  for (const warning of warnings) {
    console.warn(`[easy-agent] ${warning}`);
  }

  return {
    skillCount: skills.length - conditionalCount,
    conditionalCount,
    warnings,
  };
}
