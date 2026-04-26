/**
 * Skill registry — central in-memory state for loaded skills.
 *
 * Two maps mirror the source code's split between always-on skills and
 * conditionally-activated ones (paths frontmatter):
 *
 *   - `dynamic`     : visible to the model right now. Initial set comes from
 *                     loadAllSkills(); conditional skills are promoted in
 *                     when their paths match touched files.
 *   - `conditional` : declared with `paths` but not yet activated.
 *
 * Two sources of skills (user / project) are merged at load time with
 * project overriding user when names collide. After load the source
 * doesn't matter for execution — it only affects the discovery listing.
 *
 * Reference: claude-code-source-code/src/skills/loadSkillsDir.ts
 * (`getSkillDirCommands` + `activateConditionalSkillsForPaths`).
 */

import type { Skill } from "../../types/types.js";

const dynamic = new Map<string, Skill>();
const conditional = new Map<string, Skill>();
let initialized = false;

/**
 * Replace the registry with a freshly-loaded set. Called once at startup
 * by bootstrapSkills(). The split between dynamic / conditional happens
 * here based on whether `frontmatter.paths` is present.
 */
export function setSkills(skills: Skill[]): void {
  dynamic.clear();
  conditional.clear();
  for (const skill of skills) {
    if (skill.frontmatter.paths && skill.frontmatter.paths.length > 0) {
      conditional.set(skill.name, skill);
    } else {
      dynamic.set(skill.name, skill);
    }
  }
  initialized = true;
}

/** Has bootstrapSkills() ever been called? Useful for warning suppression. */
export function isSkillsInitialized(): boolean {
  return initialized;
}

/**
 * Skills currently visible to the model — used to build the discovery
 * listing in the system prompt. EXCLUDES `disable-model-invocation` skills.
 */
export function getModelVisibleSkills(): Skill[] {
  return [...dynamic.values()].filter((s) => !s.frontmatter.disableModelInvocation);
}

/**
 * All skills that the user could invoke via `/<name>`, INCLUDING
 * disable-model-invocation ones (the flag only hides from the AI listing,
 * the user can still trigger them) and conditional ones (so users aren't
 * surprised by "command not found" before the file path matches).
 */
export function getAllUserInvocableSkills(): Skill[] {
  return [...dynamic.values(), ...conditional.values()];
}

/** Look up by name across both maps; returns undefined if not loaded. */
export function findSkill(name: string): Skill | undefined {
  return dynamic.get(name) ?? conditional.get(name);
}

/**
 * Promote a conditional skill into the dynamic map. Returns true when the
 * skill was previously latent — caller may want to surface that fact in the
 * UI ("activated skill X").
 */
export function activateConditional(name: string): boolean {
  const skill = conditional.get(name);
  if (!skill) return false;
  conditional.delete(name);
  dynamic.set(name, skill);
  return true;
}

/** Iterate over the conditional skills (read-only view). */
export function listConditionalSkills(): Skill[] {
  return [...conditional.values()];
}

/** Drop everything — only used by tests / hot reload. */
export function clearSkills(): void {
  dynamic.clear();
  conditional.clear();
  initialized = false;
}
