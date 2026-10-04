/**
 * Disk loader for user-defined slash commands.
 *
 * Discovers `*.md` files (recursively) in two scopes:
 *   1. ~/.easy-agent/commands/         (user)
 *   2. <cwd>/.easy-agent/commands/      (project — wins on name clash)
 *
 * Naming:
 *   review.md            → /review
 *   team/review.md       → /team:review   (subdir becomes a `:` namespace)
 *   team/sub/x.md        → /team:sub:x
 *
 * Frontmatter (all optional):
 *   description    — one-line blurb (defaults to first markdown paragraph)
 *   argument-hint  — UI hint for args
 *   model          — per-turn model override
 *   allowed-tools  — tool whitelist (CSV or array)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getEasyAgentPath, getProjectEasyAgentDir } from "../../utils/paths.js";
import { extractFallbackDescription, splitFrontmatter } from "../../services/skills/parseFrontmatter.js";
import type { UserCommand, UserCommandSource } from "./types.js";

/** ~/.easy-agent/commands */
export function getUserCommandsDir(): string {
  return getEasyAgentPath("commands");
}

/** <cwd>/.easy-agent/commands */
export function getProjectCommandsDir(cwd: string): string {
  return path.join(getProjectEasyAgentDir(cwd), "commands");
}

interface LoadedFromDir {
  commands: UserCommand[];
  warnings: string[];
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

/** Recursively collect every `.md` file under `dir`, returning paths relative to `dir`. */
async function collectMarkdownFiles(dir: string, prefix = ""): Promise<string[]> {
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") return [];
    throw error;
  }

  const files: string[] = [];
  for (const dirent of dirents) {
    const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) {
      files.push(...(await collectMarkdownFiles(path.join(dir, dirent.name), rel)));
    } else if (dirent.isFile() && dirent.name.endsWith(".md")) {
      files.push(rel);
    }
  }
  return files;
}

async function loadFromOneDir(dir: string, source: UserCommandSource): Promise<LoadedFromDir> {
  let relPaths: string[];
  try {
    relPaths = await collectMarkdownFiles(dir);
  } catch (error: unknown) {
    return { commands: [], warnings: [`Failed to read ${dir}: ${(error as Error).message}`] };
  }

  const commands: UserCommand[] = [];
  const warnings: string[] = [];

  for (const rel of relPaths) {
    const filePath = path.join(dir, rel);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (error: unknown) {
      warnings.push(`[commands] Skipping ${filePath}: ${(error as Error).message}`);
      continue;
    }

    const split = splitFrontmatter(raw);
    if (split.parseError) {
      warnings.push(`[commands] Skipping ${rel}: invalid frontmatter (${split.parseError})`);
      continue;
    }

    // team/review.md → team:review (drop the .md, swap path sep for ':')
    const name = rel.replace(/\.md$/, "").split(/[\\/]/).join(":");
    const description =
      asString(split.raw["description"]) ?? extractFallbackDescription(split.body) ?? `Custom /${name} command`;

    commands.push({
      name,
      description,
      argumentHint: asString(split.raw["argument-hint"] ?? split.raw["argumentHint"]),
      model: asString(split.raw["model"]),
      allowedTools: asStringArray(split.raw["allowed-tools"] ?? split.raw["allowedTools"]),
      body: split.body.trim(),
      filePath,
      source,
    });
  }

  return { commands, warnings };
}

export interface LoadAllUserCommandsResult {
  commands: UserCommand[];
  warnings: string[];
}

/**
 * Load slash commands from ONE arbitrary directory (e.g. a plugin's
 * `commands/` dir), reusing the recursive `.md` walk + subdir→`:` namespacing.
 */
export async function loadCommandsFromDir(dir: string, source: UserCommandSource): Promise<LoadAllUserCommandsResult> {
  const { commands, warnings } = await loadFromOneDir(dir, source);
  return { commands, warnings };
}

/**
 * Load every command from user + project scopes. Project is loaded second so
 * its entries override user-scope commands with the same name.
 */
export async function loadAllUserCommands(cwd: string): Promise<LoadAllUserCommandsResult> {
  const [userResult, projectResult] = await Promise.all([
    loadFromOneDir(getUserCommandsDir(), "user"),
    loadFromOneDir(getProjectCommandsDir(cwd), "project"),
  ]);

  const byName = new Map<string, UserCommand>();
  for (const cmd of [...userResult.commands, ...projectResult.commands]) {
    byName.set(cmd.name, cmd);
  }

  return {
    commands: [...byName.values()],
    warnings: [...userResult.warnings, ...projectResult.warnings],
  };
}
