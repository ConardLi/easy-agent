/**
 * Step 17 - Skills system
 *
 * Goal:
 * - load reusable workflows from SKILL.md files
 * - parse YAML frontmatter and markdown instructions
 * - expose model-visible skills in the system prompt
 * - let the model invoke skills through a Skill tool
 * - let users invoke skills with slash commands like `/review src/foo.ts`
 * - support conditional activation through `paths` frontmatter
 *
 * This file is a teaching version that condenses the core mechanics.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import ignore from "ignore";

const SKILL_FILE = "SKILL.md";
const DEFAULT_SKILL_BUDGET_CHARS = 8000;
const MAX_LISTING_DESC_CHARS = 250;
const SKILL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

// -----------------------------------------------------------------------------
// 1. Paths
// -----------------------------------------------------------------------------

export function getUserSkillsDir() {
  return path.join(os.homedir(), ".easy-agent", "skills");
}

export function getProjectSkillsDir(cwd) {
  return path.join(cwd, ".easy-agent", "skills");
}

function posixifyPath(filePath) {
  return String(filePath).split(/[\\/]/).join("/");
}

// -----------------------------------------------------------------------------
// 2. Frontmatter parsing
// -----------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function asString(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function asStringArray(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : undefined))
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function asBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "yes" || normalized === "1";
  }
  return false;
}

export function splitFrontmatter(content) {
  const match = String(content).match(FRONTMATTER_RE);
  if (!match) return { raw: {}, body: String(content) };

  const [, yamlText, body] = match;
  try {
    const parsed = parseYaml(yamlText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { raw: parsed, body };
    }
    return {
      raw: {},
      body,
      parseError: "Frontmatter must be a YAML mapping (key: value)",
    };
  } catch (error) {
    return { raw: {}, body, parseError: error.message };
  }
}

export function extractFallbackDescription(body) {
  const buffer = [];
  for (const rawLine of String(body).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (buffer.length > 0) break;
      continue;
    }
    if (buffer.length === 0 && line.startsWith("#")) continue;
    buffer.push(line);
  }
  return buffer.join(" ").replace(/\s+/g, " ").trim();
}

export function normalizeFrontmatter(raw) {
  const allowedTools = asStringArray(raw["allowed-tools"] ?? raw.allowedTools);
  const paths = asStringArray(raw.paths);
  return {
    name: asString(raw.name),
    description: asString(raw.description),
    whenToUse: asString(raw.when_to_use ?? raw.whenToUse),
    allowedTools,
    argumentHint: asString(raw["argument-hint"] ?? raw.argumentHint),
    disableModelInvocation: asBoolean(
      raw["disable-model-invocation"] ?? raw.disableModelInvocation,
    ),
    paths: paths.length > 0 ? paths : undefined,
    hasForkContext: asString(raw.context) === "fork",
    raw,
  };
}

// -----------------------------------------------------------------------------
// 3. Disk loader
// -----------------------------------------------------------------------------

async function loadFromOneDir(dir, source) {
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { skills: [], warnings: [] };
    return { skills: [], warnings: ["Failed to read " + dir + ": " + error.message] };
  }

  const skills = [];
  const warnings = [];

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;

    const skillDir = path.join(dir, dirent.name);
    const filePath = path.join(skillDir, SKILL_FILE);

    let rawText;
    try {
      rawText = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        warnings.push("[skills] Skipping " + skillDir + ": " + error.message);
      }
      continue;
    }

    const split = splitFrontmatter(rawText);
    if (split.parseError) {
      warnings.push("[skills] Skipping " + dirent.name + ": " + split.parseError);
      continue;
    }

    const frontmatter = normalizeFrontmatter(split.raw);
    const realFile = await fs.realpath(filePath).catch(() => filePath);
    const realDir = await fs.realpath(skillDir).catch(() => skillDir);
    const name = frontmatter.name ?? dirent.name;

    skills.push({
      name,
      description:
        frontmatter.description ?? extractFallbackDescription(split.body) ?? name,
      whenToUse: frontmatter.whenToUse,
      body: split.body,
      filePath: realFile,
      baseDir: realDir,
      source,
      frontmatter,
    });
  }

  return { skills, warnings };
}

export async function loadAllSkills(cwd) {
  const [userResult, projectResult] = await Promise.all([
    loadFromOneDir(getUserSkillsDir(), "user"),
    loadFromOneDir(getProjectSkillsDir(cwd), "project"),
  ]);

  const seenRealPaths = new Set();
  const byName = new Map();

  // Project skills are loaded second, so they override user skills by name.
  for (const skill of [...userResult.skills, ...projectResult.skills]) {
    if (seenRealPaths.has(skill.filePath)) continue;
    seenRealPaths.add(skill.filePath);
    byName.set(skill.name, skill);
  }

  return {
    skills: [...byName.values()],
    warnings: [...userResult.warnings, ...projectResult.warnings],
  };
}

// -----------------------------------------------------------------------------
// 4. Registry
// -----------------------------------------------------------------------------

const dynamicSkills = new Map();
const conditionalSkills = new Map();
let initialized = false;

export function setSkills(skills) {
  dynamicSkills.clear();
  conditionalSkills.clear();

  for (const skill of skills) {
    if (skill.frontmatter.paths && skill.frontmatter.paths.length > 0) {
      conditionalSkills.set(skill.name, skill);
    } else {
      dynamicSkills.set(skill.name, skill);
    }
  }

  initialized = true;
}

export function isSkillsInitialized() {
  return initialized;
}

export function getModelVisibleSkills() {
  return [...dynamicSkills.values()].filter(
    (skill) => !skill.frontmatter.disableModelInvocation,
  );
}

export function getAllUserInvocableSkills() {
  return [...dynamicSkills.values(), ...conditionalSkills.values()];
}

export function findSkill(name) {
  return dynamicSkills.get(name) ?? conditionalSkills.get(name);
}

export function activateConditionalSkill(name) {
  const skill = conditionalSkills.get(name);
  if (!skill) return false;

  conditionalSkills.delete(name);
  dynamicSkills.set(name, skill);
  return true;
}

// -----------------------------------------------------------------------------
// 5. System prompt discovery listing
// -----------------------------------------------------------------------------

function truncateDescription(description, maxChars) {
  if (description.length <= maxChars) return description;
  if (maxChars <= 1) return "...";
  return description.slice(0, maxChars - 3).trimEnd() + "...";
}

function buildSkillLine(skill, descMax) {
  const fullDescription = skill.whenToUse
    ? skill.description + " - " + skill.whenToUse
    : skill.description;
  return "- " + skill.name + ": " + truncateDescription(
    fullDescription,
    Math.min(descMax, MAX_LISTING_DESC_CHARS),
  );
}

export function formatSkillsWithinBudget(
  skills,
  budget = DEFAULT_SKILL_BUDGET_CHARS,
) {
  if (skills.length === 0) return "";

  const fullLines = skills.map((skill) => buildSkillLine(skill, MAX_LISTING_DESC_CHARS));
  const fullCost = fullLines.reduce((sum, line) => sum + line.length + 1, 0);
  if (fullCost <= budget) return fullLines.join("\n");

  const prefixCost = skills.reduce((sum, skill) => {
    return sum + ("- " + skill.name + ": ").length + 1;
  }, 0);
  const descBudget = budget - prefixCost;
  if (descBudget >= skills.length * 20) {
    const perDesc = Math.max(20, Math.floor(descBudget / skills.length));
    return skills.map((skill) => buildSkillLine(skill, perDesc)).join("\n");
  }

  return skills.map((skill) => "- " + skill.name).join("\n");
}

export function formatSkillsSystemReminder(skills) {
  const listing = formatSkillsWithinBudget(skills);
  if (!listing) return "";

  return [
    "<system-reminder>",
    "Available skills you can invoke via the `Skill` tool.",
    "Call `Skill(skill=\"<name>\", args=\"<optional args>\")` when a skill matches the user's request.",
    "",
    listing,
    "</system-reminder>",
  ].join("\n");
}

// -----------------------------------------------------------------------------
// 6. Skill tool
// -----------------------------------------------------------------------------

function substituteSkillVariables(skill, args, sessionId) {
  return skill.body
    .replaceAll("${CLAUDE_SKILL_DIR}", posixifyPath(skill.baseDir))
    .replaceAll("${CLAUDE_SESSION_ID}", sessionId)
    .replaceAll("$ARGUMENTS", args);
}

export function createSkillTool() {
  return {
    name: "Skill",
    description:
      "Execute a named skill. The skill's instructions are returned as text; read them and continue following them.",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string" },
        args: { type: "string" },
      },
      required: ["skill"],
      additionalProperties: false,
    },
    isReadOnly() {
      return false;
    },
    isEnabled() {
      return true;
    },
    async call(input, context) {
      const name = typeof input.skill === "string" ? input.skill.trim() : "";
      const args = typeof input.args === "string" ? input.args : "";

      if (!name || !SKILL_NAME_RE.test(name)) {
        return {
          content: "Error: invalid skill name. Use letters, digits, underscores, or dashes.",
          isError: true,
        };
      }

      const skill = findSkill(name);
      if (!skill) {
        return { content: 'Error: skill "' + name + '" not found.', isError: true };
      }
      if (skill.frontmatter.disableModelInvocation) {
        return {
          content: 'Error: skill "' + name + '" can only be invoked by the user.',
          isError: true,
        };
      }
      if (skill.frontmatter.hasForkContext) {
        return {
          content: 'Error: skill "' + name + '" requires forked sub-agent context.',
          isError: true,
        };
      }

      if (skill.frontmatter.allowedTools.length > 0 && context.addSessionAllowRules) {
        context.addSessionAllowRules(skill.frontmatter.allowedTools);
      }

      const sessionId = context.sessionId ?? "unknown-session";
      const body = substituteSkillVariables(skill, args, sessionId);

      return {
        content:
          'Loaded skill "' + skill.name + '" from ' + skill.source + ".\n" +
          "Base directory for this skill: " + posixifyPath(skill.baseDir) + "\n\n" +
          body,
      };
    },
  };
}

// -----------------------------------------------------------------------------
// 7. User slash command expansion
// -----------------------------------------------------------------------------

export function expandSkillSlashCommand(input, context) {
  const match = String(input).match(/^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/);
  if (!match) return null;

  const [, name, rawArgs] = match;
  const skill = findSkill(name);
  if (!skill) return null;

  const args = rawArgs?.trim() ?? "";
  const sessionId = context.sessionId ?? "unknown-session";

  if (skill.frontmatter.allowedTools.length > 0 && context.addSessionAllowRules) {
    context.addSessionAllowRules(skill.frontmatter.allowedTools);
  }

  const markerLines = [
    "<command-message>" + skill.name + "</command-message>",
    "<command-name>/" + skill.name + "</command-name>",
  ];
  if (args) {
    markerLines.push("<command-args>" + args + "</command-args>");
  }

  return {
    markerContent: markerLines.join("\n"),
    bodyText:
      "[skill_invocation:" + skill.name + "]\n" +
      'Run skill "' + skill.name + '" with the following instructions.\n' +
      "Base directory for this skill: " + posixifyPath(skill.baseDir) + "\n\n" +
      substituteSkillVariables(skill, args, sessionId),
  };
}

// -----------------------------------------------------------------------------
// 8. Conditional activation
// -----------------------------------------------------------------------------

export function activateConditionalSkillsForPaths(filePaths, cwd) {
  if (!filePaths || filePaths.length === 0) return [];

  const relativePaths = filePaths
    .map((filePath) => {
      const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
      const relative = path.relative(cwd, absolute);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
      return posixifyPath(relative);
    })
    .filter(Boolean);

  const activated = [];
  for (const skill of conditionalSkills.values()) {
    const patterns = skill.frontmatter.paths;
    if (!patterns || patterns.length === 0) continue;

    const matcher = ignore().add(patterns);
    if (relativePaths.some((filePath) => matcher.ignores(filePath))) {
      if (activateConditionalSkill(skill.name)) {
        activated.push(skill.name);
      }
    }
  }

  return activated;
}

export function extractToolFilePaths(toolName, input) {
  if (toolName === "Read" || toolName === "Write" || toolName === "Edit") {
    return typeof input.file_path === "string" ? [input.file_path] : [];
  }
  if (toolName === "Glob") {
    return typeof input.path === "string" ? [input.path] : [];
  }
  return [];
}

// -----------------------------------------------------------------------------
// 9. Bootstrap
// -----------------------------------------------------------------------------

export async function bootstrapSkills(cwd) {
  const { skills, warnings } = await loadAllSkills(cwd);
  setSkills(skills);

  return {
    skillCount: getModelVisibleSkills().length,
    userInvocableCount: getAllUserInvocableSkills().length,
    conditionalCount: skills.filter((skill) => skill.frontmatter.paths).length,
    warnings,
  };
}
