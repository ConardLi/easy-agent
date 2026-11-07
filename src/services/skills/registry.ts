/**
 * Skill registry — central in-memory state for loaded skills.
 *
 * Two maps split always-on skills from conditionally-activated ones
 * (paths frontmatter):
 *
 *   - `dynamic`     : visible to the model right now. Initial set comes from
 *                     loadAllSkills(); conditional skills are promoted in
 *                     when their paths match touched files.
 *   - `conditional` : declared with `paths` but not yet activated.
 *
 * Two sources of skills (user / project) are merged at load time with
 * project overriding user when names collide. After load a skill's origin
 * doesn't matter for execution — it only affects the discovery listing.
 *
 * The registry holds every loaded skill; the lookups below return only the
 * ones the Agent keeps (`skills.include` / `skills.exclude`), whether they
 * come from the user, the project, or a plugin. `getRegisteredSkills()`
 * returns all of them, for views that show what the Agent leaves out.
 */

import { activeHarness } from "../../harness/active.js";
import type { ResolvedHarness } from "../../harness/resolve.js";
import { selectionOffReason } from "../../harness/selection.js";
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

/** Why the Agent leaves out the skill `name`, or undefined when it keeps it. */
export function skillOffByAgent(name: string, resolved: ResolvedHarness = activeHarness()): string | undefined {
  return selectionOffReason(resolved, "skills", name);
}

const kept = (skills: Iterable<Skill>, resolved: ResolvedHarness): Skill[] =>
  [...skills].filter((skill) => !skillOffByAgent(skill.name, resolved));

/**
 * Skills currently visible to the model — used to build the discovery
 * listing in the system prompt. EXCLUDES `disable-model-invocation` skills.
 */
export function getModelVisibleSkills(resolved: ResolvedHarness = activeHarness()): Skill[] {
  return kept(dynamic.values(), resolved).filter((s) => !s.frontmatter.disableModelInvocation);
}

/**
 * All skills that the user could invoke via `/<name>`, INCLUDING
 * disable-model-invocation ones (the flag only hides from the AI listing,
 * the user can still trigger them) and conditional ones (so users aren't
 * surprised by "command not found" before the file path matches).
 */
export function getAllUserInvocableSkills(resolved: ResolvedHarness = activeHarness()): Skill[] {
  return kept([...dynamic.values(), ...conditional.values()], resolved);
}

/** Every loaded skill, including the ones the Agent leaves out. */
export function getRegisteredSkills(): Skill[] {
  return [...dynamic.values(), ...conditional.values()];
}

/** Look up by name across both maps; undefined if not loaded or left out by the Agent. */
export function findSkill(name: string): Skill | undefined {
  const skill = dynamic.get(name) ?? conditional.get(name);
  return skill && !skillOffByAgent(name) ? skill : undefined;
}

/** Why a loaded skill is left out by the Agent; undefined when it is kept or no such skill is loaded. */
export function loadedSkillOffByAgent(name: string): string | undefined {
  return dynamic.has(name) || conditional.has(name) ? skillOffByAgent(name) : undefined;
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

/** The conditional skills the Agent keeps that are not activated yet (read-only view). */
export function listConditionalSkills(): Skill[] {
  return kept(conditional.values(), activeHarness());
}

/** Drop everything — only used by tests / hot reload. */
export function clearSkills(): void {
  dynamic.clear();
  conditional.clear();
  initialized = false;
}
