/**
 * Skill discovery listing — formats the `name + description` of every
 * available skill into a single text block, subject to a character budget
 * so we don't bloat the system prompt on long-skill collections.
 *
 * Reference: claude-code-source-code/src/tools/SkillTool/prompt.ts
 *   - SKILL_BUDGET_CONTEXT_PERCENT = 0.01  (1% of context window)
 *   - MAX_LISTING_DESC_CHARS = 250         (per-skill description cap)
 *   - Three-tier degradation: full → truncated descriptions → names-only
 *
 * Where ours differs from the source:
 *   - No "bundled skill never truncates" privilege (we have no bundled
 *     skills in stage 17 — see DEVELOPMENT-PLAN §17.6.1).
 *   - The budget is in CHARACTERS, not tokens. The source's
 *     `contextWindowTokens × 4 × 1%` heuristic assumes ~4 chars/token, so
 *     our default 8000 chars ≈ 2000 tokens for a 200K-token model.
 */

import type { Skill } from "./types.js";

export const MAX_LISTING_DESC_CHARS = 250;
const MIN_DESC_CHARS_PER_SKILL = 20;
const DEFAULT_BUDGET_CHARS = 8000;

/**
 * Compute the character budget. Honours the `EASY_AGENT_SKILL_CHAR_BUDGET`
 * env var so power users can shrink it on smaller-context models without
 * editing source.
 */
export function getSkillCharBudget(): number {
  const envValue = process.env["EASY_AGENT_SKILL_CHAR_BUDGET"];
  if (envValue) {
    const parsed = Number.parseInt(envValue, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_BUDGET_CHARS;
}

function truncateDesc(desc: string, max: number): string {
  if (desc.length <= max) return desc;
  if (max <= 1) return "…";
  return `${desc.slice(0, max - 1).trimEnd()}…`;
}

function buildLine(skill: Skill, descMax: number): string {
  const cappedMax = Math.min(descMax, MAX_LISTING_DESC_CHARS);
  const fullDesc = skill.whenToUse
    ? `${skill.description} — ${skill.whenToUse}`
    : skill.description;
  const desc = truncateDesc(fullDesc, cappedMax);
  return `- ${skill.name}: ${desc}`;
}

function buildNameOnly(skill: Skill): string {
  return `- ${skill.name}`;
}

/**
 * Render the discovery listing under the given char budget.
 *
 * Tier 1: every skill with full description (capped at 250 chars each).
 * Tier 2: shrink each description equally to fit (≥ 20 chars each).
 * Tier 3: name-only fallback.
 *
 * Returns an empty string when there are no skills, so callers can
 * unconditionally concatenate it without producing trailing whitespace.
 */
export function formatSkillsWithinBudget(
  skills: Skill[],
  budget: number = getSkillCharBudget(),
): string {
  if (skills.length === 0) return "";

  const tier1 = skills.map((s) => buildLine(s, MAX_LISTING_DESC_CHARS));
  const tier1Total = tier1.reduce((acc, line) => acc + line.length + 1, 0);
  if (tier1Total <= budget) return tier1.join("\n");

  // Tier 2: distribute remaining budget evenly across skills. We reserve
  // the prefix length (`- name: `) per line, then split what's left.
  const prefixCost = skills.reduce((acc, s) => acc + `- ${s.name}: `.length + 1, 0);
  const descBudget = budget - prefixCost;
  if (descBudget >= skills.length * MIN_DESC_CHARS_PER_SKILL) {
    const perDesc = Math.max(MIN_DESC_CHARS_PER_SKILL, Math.floor(descBudget / skills.length));
    const tier2 = skills.map((s) => buildLine(s, perDesc));
    const tier2Total = tier2.reduce((acc, line) => acc + line.length + 1, 0);
    if (tier2Total <= budget) return tier2.join("\n");
  }

  // Tier 3: names only. No further degradation — at this point we either
  // fit the names or we accept overshoot (unavoidable, the model gets to
  // see the full set). Mirrors source code's "names_only" final tier.
  return skills.map(buildNameOnly).join("\n");
}

/**
 * Build the system-reminder block to inject into every system prompt.
 *
 * Wrapping in `<system-reminder>` tags matches the convention used elsewhere
 * in Claude Code for "ambient" context that should influence the model's
 * planning without being treated as a user instruction.
 */
export function formatSkillsSystemReminder(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const listing = formatSkillsWithinBudget(skills);
  if (!listing) return "";
  return [
    "<system-reminder>",
    "Available skills you can invoke via the `Skill` tool. Each line is `- <name>: <description>`.",
    "Call `Skill(skill=\"<name>\", args=\"<optional args>\")` when the user's request matches one of these.",
    "",
    listing,
    "</system-reminder>",
  ].join("\n");
}
