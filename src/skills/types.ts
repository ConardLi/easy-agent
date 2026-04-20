/**
 * Skill type definitions.
 *
 * A "Skill" is a Markdown file with YAML frontmatter describing a reusable
 * workflow. Compared to a Tool (TypeScript code), a Skill is a *declarative*
 * unit: prompt + permission config. The Skill body becomes a UserMessage at
 * invocation time, instructing the model how to perform a complex task.
 *
 * Stage 17 supports a subset of the source-code frontmatter fields. The full
 * field list (model/effort/context=fork/agent/hooks/shell/...) is parsed but
 * ignored for now — see DEVELOPMENT-PLAN §17.6.1 for the deferral rationale.
 */

/** Where a skill was loaded from. Affects override priority and display. */
export type SkillSource = "user" | "project";

/** Raw frontmatter keys we read in this stage. Other keys are preserved in `frontmatter` for forward compat. */
export interface SkillFrontmatter {
  /** Display name (defaults to dirname). */
  name?: string;
  /** Short one-line description for the discovery listing. */
  description?: string;
  /** Hint to the model about WHEN to use this skill — appended to description. */
  when_to_use?: string;
  /**
   * Allowed-tools whitelist. When the skill executes, these tool names are
   * temporarily added to session-allow rules so the skill can run without
   * interruption. Always an array post-parse.
   */
  allowedTools: string[];
  /** UI hint for arguments (e.g. `<file-or-dir>`). */
  argumentHint?: string;
  /** When true, skill is hidden from the AI listing. User can still /name. */
  disableModelInvocation: boolean;
  /**
   * Conditional activation patterns (gitignore-style). When non-empty the
   * skill is NOT in the discovery listing until a matching file path is
   * touched by Read/Write/Edit/Glob.
   */
  paths?: string[];
  /** Whether the source file declared `context: fork` — currently rejected at exec. */
  hasForkContext: boolean;
  /** Untouched frontmatter (sans the ones above) for future expansion. */
  raw: Record<string, unknown>;
}

/** A loaded skill, ready to be matched and invoked. */
export interface Skill {
  /** Unique identifier — also the path slug used in `/name`. Defaults to dirname. */
  name: string;
  /** Final description shown in discovery (frontmatter desc OR first markdown paragraph). */
  description: string;
  /** Optional when-to-use hint, appended to description in the listing. */
  whenToUse?: string;
  /** Markdown body without the YAML frontmatter. */
  body: string;
  /** Absolute path to the SKILL.md file (after symlink resolution). */
  filePath: string;
  /** Absolute path to the directory containing SKILL.md (`${CLAUDE_SKILL_DIR}` value). */
  baseDir: string;
  /** Where this skill came from. Project overrides user. */
  source: SkillSource;
  /** Parsed + normalized frontmatter. */
  frontmatter: SkillFrontmatter;
}
