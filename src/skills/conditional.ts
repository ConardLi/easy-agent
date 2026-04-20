/**
 * Conditional skill activation — promotes skills declared with a `paths`
 * frontmatter into the visible skill set when their patterns match a file
 * the agent just touched (Read / Write / Edit / Glob).
 *
 * Reference: claude-code-source-code/src/skills/loadSkillsDir.ts
 *   `activateConditionalSkillsForPaths` — uses gitignore-style matching
 *   via the `ignore` package; we follow the same library + semantics so
 *   patterns authored against Claude Code work unmodified.
 *
 * Activation is one-way and sticky for the lifetime of the process: once a
 * skill activates, it stays in the visible set until restart. This avoids
 * flicker (skill appearing then disappearing as the model navigates files)
 * which would just confuse the model.
 */

import * as path from "node:path";
import ignore from "ignore";
import {
  activateConditional,
  listConditionalSkills,
} from "./registry.js";

/**
 * Try to activate every still-conditional skill against the given file
 * paths. Returns the names of skills that just became visible — useful for
 * UI notices ("activated skill: test-reviewer").
 *
 * `cwd` is required so we can convert absolute paths into the
 * repo-relative form that gitignore patterns are written against.
 */
export function activateConditionalSkillsForPaths(
  filePaths: string[],
  cwd: string,
): string[] {
  if (filePaths.length === 0) return [];
  const candidates = listConditionalSkills();
  if (candidates.length === 0) return [];

  const relativePaths = filePaths
    .map((p) => {
      const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
      const rel = path.relative(cwd, abs);
      // The `ignore` package can't match absolute paths or '..' paths.
      // Drop those — conditional skills are intended for in-repo files.
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
      return rel.split(path.sep).join("/");
    })
    .filter((p): p is string => Boolean(p));

  if (relativePaths.length === 0) return [];

  const activated: string[] = [];
  for (const skill of candidates) {
    const patterns = skill.frontmatter.paths;
    if (!patterns || patterns.length === 0) continue;
    const matcher = ignore().add(patterns);
    if (relativePaths.some((p) => matcher.ignores(p))) {
      if (activateConditional(skill.name)) {
        activated.push(skill.name);
      }
    }
  }
  return activated;
}

/**
 * Best-effort extractor: pull file-path-shaped fields out of an arbitrary
 * tool input object. We keep this conservative — only well-known fields
 * from Read / Write / Edit / Glob — to avoid false positives that would
 * activate skills against irrelevant inputs.
 */
export function extractToolFilePaths(
  toolName: string,
  input: Record<string, unknown>,
): string[] {
  const paths: string[] = [];
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit": {
      const fp = input["file_path"];
      if (typeof fp === "string") paths.push(fp);
      break;
    }
    case "Glob": {
      // Glob's `pattern` isn't a file path per se, but the `path` field
      // (the search root) often is, and conditional skills authored for
      // a directory subtree should still trigger.
      const root = input["path"];
      if (typeof root === "string") paths.push(root);
      break;
    }
    default:
      break;
  }
  return paths;
}
