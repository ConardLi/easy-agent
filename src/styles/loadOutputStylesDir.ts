/**
 * Disk loader for custom output styles.
 *
 * Discovers `<output-styles>/<name>.md` flat files in two scopes:
 *   1. ~/.easy-agent/output-styles/         (user)
 *   2. <cwd>/.easy-agent/output-styles/      (project — wins on name clash)
 *
 * Each file is a Markdown document with optional YAML frontmatter:
 *   ---
 *   name: My Style
 *   description: A short blurb
 *   keep-coding-instructions: true
 *   ---
 *   <the style prompt body>
 *
 * The filename (sans `.md`) is the default style name. The body becomes the
 * style prompt. We reuse the skills frontmatter splitter so the parsing
 * stays consistent across the codebase.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getEasyAgentPath, getProjectEasyAgentDir } from "../utils/paths.js";
import { extractFallbackDescription, splitFrontmatter } from "../services/skills/parseFrontmatter.js";
import type { OutputStyleConfig, OutputStyleSource } from "./registry.js";

/** ~/.easy-agent/output-styles */
export function getUserOutputStylesDir(): string {
  return getEasyAgentPath("output-styles");
}

/** <cwd>/.easy-agent/output-styles */
export function getProjectOutputStylesDir(cwd: string): string {
  return path.join(getProjectEasyAgentDir(cwd), "output-styles");
}

interface LoadedFromDir {
  styles: OutputStyleConfig[];
  warnings: string[];
}

/**
 * Parse the `keep-coding-instructions` frontmatter flag. Defaults to true
 * (instructions kept) — only an explicit `false` drops them, so a style
 * that omits the flag keeps the coding instructions.
 */
function parseKeepCodingInstructions(raw: Record<string, unknown>): boolean {
  const value = raw["keep-coding-instructions"] ?? raw["keepCodingInstructions"];
  if (value === false) return false;
  if (typeof value === "string" && value.trim().toLowerCase() === "false") return false;
  return true;
}

async function loadFromOneDir(dir: string, source: OutputStyleSource): Promise<LoadedFromDir> {
  let entries: string[];
  try {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    entries = dirents.filter((d) => d.isFile() && d.name.endsWith(".md")).map((d) => d.name);
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") return { styles: [], warnings: [] };
    return { styles: [], warnings: [`Failed to read ${dir}: ${(error as Error).message}`] };
  }

  const styles: OutputStyleConfig[] = [];
  const warnings: string[] = [];

  for (const fileName of entries) {
    const filePath = path.join(dir, fileName);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (error: unknown) {
      warnings.push(`[output-styles] Skipping ${filePath}: ${(error as Error).message}`);
      continue;
    }

    const split = splitFrontmatter(raw);
    if (split.parseError) {
      warnings.push(`[output-styles] Skipping ${fileName}: invalid frontmatter (${split.parseError})`);
      continue;
    }

    const styleName = fileName.replace(/\.md$/, "");
    const name =
      typeof split.raw["name"] === "string" && (split.raw["name"] as string).trim()
        ? (split.raw["name"] as string).trim()
        : styleName;
    const description =
      typeof split.raw["description"] === "string" && (split.raw["description"] as string).trim()
        ? (split.raw["description"] as string).trim()
        : extractFallbackDescription(split.body) || `Custom ${styleName} output style`;

    const prompt = split.body.trim();
    if (!prompt) {
      warnings.push(`[output-styles] Skipping ${fileName}: empty style prompt`);
      continue;
    }

    styles.push({
      name,
      description,
      prompt,
      source,
      keepCodingInstructions: parseKeepCodingInstructions(split.raw),
    });
  }

  return { styles, warnings };
}

export interface LoadAllOutputStylesResult {
  styles: OutputStyleConfig[];
  warnings: string[];
}

/**
 * Load output styles from ONE arbitrary directory (e.g. a plugin's
 * `output-styles/` dir), reusing the shared frontmatter parser.
 */
export async function loadOutputStylesFromDir(
  dir: string,
  source: OutputStyleSource,
): Promise<LoadAllOutputStylesResult> {
  const { styles, warnings } = await loadFromOneDir(dir, source);
  return { styles, warnings };
}

/**
 * Load every custom style from user + project scopes. Project is loaded
 * second so its entries naturally override user-scope styles with the same
 * name in the returned (de-duped) list.
 */
export async function loadAllOutputStyles(cwd: string): Promise<LoadAllOutputStylesResult> {
  const [userResult, projectResult] = await Promise.all([
    loadFromOneDir(getUserOutputStylesDir(), "user"),
    loadFromOneDir(getProjectOutputStylesDir(cwd), "project"),
  ]);

  const byName = new Map<string, OutputStyleConfig>();
  for (const style of [...userResult.styles, ...projectResult.styles]) {
    byName.set(style.name, style);
  }

  return {
    styles: [...byName.values()],
    warnings: [...userResult.warnings, ...projectResult.warnings],
  };
}
