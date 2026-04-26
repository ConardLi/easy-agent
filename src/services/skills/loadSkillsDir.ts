/**
 * Disk skill loader — discovers `<skillsDir>/<skill-name>/SKILL.md` files
 * across the user-global and project-local scopes, parses each one, and
 * dedupes via realpath() so symlink trees don't load the same skill twice.
 *
 * Scopes (precedence: project > user):
 *   1. ~/.easy-agent/skills/             (per-user)
 *   2. <cwd>/.easy-agent/skills/         (per-project)
 *
 * Reference: claude-code-source-code/src/skills/loadSkillsDir.ts
 *   - We mirror getFileIdentity() with `realpath()` for symlink dedupe.
 *   - We DROP the legacy `.md` flat files and the bundled / mcp / remote
 *     loaders — see DEVELOPMENT-PLAN §17.6.1 for the deferral rationale.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  getEasyAgentPath,
  getProjectEasyAgentDir,
} from "../../utils/paths.js";
import {
  extractFallbackDescription,
  normalizeFrontmatter,
  splitFrontmatter,
} from "./parseFrontmatter.js";
import type { Skill, SkillSource } from "../../types/types.js";

const SKILL_FILE = "SKILL.md";

/** ~/.easy-agent/skills */
export function getUserSkillsDir(): string {
  return getEasyAgentPath("skills");
}

/** <cwd>/.easy-agent/skills */
export function getProjectSkillsDir(cwd: string): string {
  return path.join(getProjectEasyAgentDir(cwd), "skills");
}

interface LoadedFromDir {
  skills: Skill[];
  warnings: string[];
}

/**
 * Walk one skills directory, returning every parseable skill it contains.
 *
 * Emits warnings for parse failures + missing SKILL.md so users can debug
 * a misconfigured skill without it silently disappearing. The caller
 * decides whether to surface the warnings (currently console.warn).
 */
async function loadFromOneDir(dir: string, source: SkillSource): Promise<LoadedFromDir> {
  let entries: string[];
  try {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") return { skills: [], warnings: [] };
    return { skills: [], warnings: [`Failed to read ${dir}: ${(error as Error).message}`] };
  }

  const out: Skill[] = [];
  const warnings: string[] = [];

  for (const dirName of entries) {
    const skillDir = path.join(dir, dirName);
    const filePath = path.join(skillDir, SKILL_FILE);

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code !== "ENOENT") {
        warnings.push(`[skills] Skipping ${skillDir}: ${(error as Error).message}`);
      }
      continue;
    }

    const split = splitFrontmatter(raw);
    if (split.parseError) {
      warnings.push(`[skills] Skipping ${dirName}: invalid frontmatter (${split.parseError})`);
      continue;
    }
    const frontmatter = normalizeFrontmatter(split.raw, split.body);

    // Resolve to canonical paths for symlink dedupe (handled by caller).
    const realFile = await fs.realpath(filePath).catch(() => filePath);
    const realDir = await fs.realpath(skillDir).catch(() => skillDir);

    const name = frontmatter.name ?? dirName;
    const description = frontmatter.description ?? extractFallbackDescription(split.body) ?? name;

    out.push({
      name,
      description,
      whenToUse: frontmatter.when_to_use,
      body: split.body,
      filePath: realFile,
      baseDir: realDir,
      source,
      frontmatter,
    });
  }

  return { skills: out, warnings };
}

export interface LoadAllSkillsResult {
  skills: Skill[];
  warnings: string[];
}

/**
 * Load every skill from user + project scopes, applying:
 *   1. realpath() dedupe (same SKILL.md reachable via two symlinks → one entry)
 *   2. name dedupe with project > user precedence
 *
 * The project scope is loaded second so its entries naturally overwrite
 * user-scope entries with the same `name` in the final Map.
 */
export async function loadAllSkills(cwd: string): Promise<LoadAllSkillsResult> {
  const userDir = getUserSkillsDir();
  const projectDir = getProjectSkillsDir(cwd);

  const [userResult, projectResult] = await Promise.all([
    loadFromOneDir(userDir, "user"),
    loadFromOneDir(projectDir, "project"),
  ]);

  const seenRealPaths = new Set<string>();
  const byName = new Map<string, Skill>();

  for (const skill of [...userResult.skills, ...projectResult.skills]) {
    if (seenRealPaths.has(skill.filePath)) continue; // symlink loop
    seenRealPaths.add(skill.filePath);
    // Project source loaded after user, so this assignment wins on collision.
    byName.set(skill.name, skill);
  }

  return {
    skills: [...byName.values()],
    warnings: [...userResult.warnings, ...projectResult.warnings],
  };
}
