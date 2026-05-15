/**
 * Disk-based loader for custom Agent definitions.
 *
 * An agent file is a Markdown document with YAML frontmatter — same shape
 * as a SKILL.md but with a different field set:
 *
 *   ---
 *   name: "reviewer"
 *   description: "Code review specialist — invoke when the user asks for a review."
 *   tools: "Read,Glob,Grep,Bash"
 *   disallowedTools: "Write,Edit"
 *   model: "claude-haiku-4-20250101"
 *   maxTurns: 12
 *   permissionMode: "default"
 *   ---
 *   You are a senior code reviewer...
 *   (the markdown body is the agent's system prompt)
 *
 * Two scopes are scanned:
 *   1. ~/.easy-agent/agents/         (per-user, lower priority)
 *   2. <cwd>/.easy-agent/agents/     (per-project, higher priority)
 *
 * Files with malformed frontmatter or missing required fields (`name`,
 * `description`, non-empty body) are skipped with a warning so a typo
 * doesn't crash startup. Mirrors the loader in
 * claude-code-source-code/src/tools/AgentTool/loadAgentsDir.ts but trimmed
 * to the field set we actually use.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  getEasyAgentPath,
  getProjectEasyAgentDir,
} from "../utils/paths.js";
import { splitFrontmatter } from "../services/skills/parseFrontmatter.js";
import type {
  AgentDefinition,
  AgentIsolation,
  AgentPermissionMode,
  AgentSource,
} from "./types.js";

/** ~/.easy-agent/agents */
export function getUserAgentsDir(): string {
  return getEasyAgentPath("agents");
}

/** <cwd>/.easy-agent/agents */
export function getProjectAgentsDir(cwd: string): string {
  return path.join(getProjectEasyAgentDir(cwd), "agents");
}

interface LoadedFromDir {
  agents: AgentDefinition[];
  warnings: string[];
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const t = value.trim();
    return t.length > 0 ? t : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? v.trim() : undefined))
      .filter((v): v is string => Boolean(v));
  }
  if (typeof value === "string") {
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function asPositiveInt(value: unknown): number | undefined {
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    n = Number.parseInt(value.trim(), 10);
  } else {
    return undefined;
  }
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function asPermissionMode(value: unknown): AgentPermissionMode | undefined {
  return value === "default" || value === "plan" || value === "auto" ? value : undefined;
}

function asIsolation(value: unknown): AgentIsolation | undefined {
  // Accept both "worktree" and "none". Anything else (typo, foreign
  // mode like "remote") is treated as "no preference" so the loader
  // doesn't silently mis-route the agent.
  return value === "worktree" || value === "none" ? value : undefined;
}

async function loadFromOneDir(dir: string, source: AgentSource): Promise<LoadedFromDir> {
  let entries: string[];
  try {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    entries = dirents
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".md"))
      .map((d) => d.name);
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") return { agents: [], warnings: [] };
    return {
      agents: [],
      warnings: [`Failed to read ${dir}: ${(error as Error).message}`],
    };
  }

  const out: AgentDefinition[] = [];
  const warnings: string[] = [];

  for (const fileName of entries) {
    const filePath = path.join(dir, fileName);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (error: unknown) {
      warnings.push(`[agents] Skipping ${filePath}: ${(error as Error).message}`);
      continue;
    }

    const split = splitFrontmatter(raw);
    if (split.parseError) {
      warnings.push(`[agents] Skipping ${fileName}: invalid frontmatter (${split.parseError})`);
      continue;
    }

    const name = asString(split.raw["name"]);
    const description = asString(split.raw["description"]);
    if (!name) {
      warnings.push(`[agents] Skipping ${fileName}: missing required 'name' field`);
      continue;
    }
    if (!description) {
      warnings.push(`[agents] Skipping ${fileName}: missing required 'description' field`);
      continue;
    }

    const systemPrompt = split.body.trim();
    if (!systemPrompt) {
      warnings.push(
        `[agents] Skipping ${fileName}: empty body — agent definition needs a system prompt`,
      );
      continue;
    }

    const tools = asStringArray(split.raw["tools"]);
    const disallowedTools = asStringArray(
      split.raw["disallowedTools"] ?? split.raw["disallowed_tools"],
    );
    const model = asString(split.raw["model"]);
    const maxTurns = asPositiveInt(split.raw["maxTurns"] ?? split.raw["max_turns"]);
    const permissionMode = asPermissionMode(
      split.raw["permissionMode"] ?? split.raw["permission_mode"],
    );
    const isolation = asIsolation(split.raw["isolation"]);

    out.push({
      agentType: name,
      whenToUse: description,
      ...(tools.length > 0 ? { tools } : {}),
      ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
      ...(model ? { model } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(isolation ? { isolation } : {}),
      source,
      filePath,
      getSystemPrompt: () => systemPrompt,
    });
  }

  return { agents: out, warnings };
}

export interface LoadAllAgentsResult {
  agents: AgentDefinition[];
  warnings: string[];
}

/**
 * Load every custom agent from the user + project scopes. Order matters:
 * the registry's `setAgents()` overwrite-on-name semantics mean later
 * entries win, so we return user first, project second — and the
 * bootstrap places built-ins before both, so project > user > built-in.
 */
export async function loadAllCustomAgents(cwd: string): Promise<LoadAllAgentsResult> {
  const userDir = getUserAgentsDir();
  const projectDir = getProjectAgentsDir(cwd);

  const [userResult, projectResult] = await Promise.all([
    loadFromOneDir(userDir, "user"),
    loadFromOneDir(projectDir, "project"),
  ]);

  return {
    agents: [...userResult.agents, ...projectResult.agents],
    warnings: [...userResult.warnings, ...projectResult.warnings],
  };
}
