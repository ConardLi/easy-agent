/**
 * Step 10 - Project memory with file-based long-term knowledge
 *
 * Goal:
 * - store long-term project memory as markdown files
 * - keep one lightweight MEMORY.md index as the entrypoint
 * - separate memory from transcript history
 * - make memory human-readable, editable, and easy to inject into prompts
 *
 * This file is intentionally smaller than the production memory system.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const EASY_AGENT_HOME = path.join(os.homedir(), ".easy-agent");
const PROJECTS_DIR = path.join(EASY_AGENT_HOME, "projects");
const MEMORY_DIR_NAME = "memory";
const MEMORY_ENTRYPOINT = "MEMORY.md";
const MAX_ENTRYPOINT_LINES = 200;
const MAX_ENTRYPOINT_BYTES = 25_000;
const MEMORY_TYPES = new Set(["user", "feedback", "project", "reference"]);

export function getProjectKey(cwd) {
  return crypto
    .createHash("sha256")
    .update(path.resolve(cwd))
    .digest("hex")
    .slice(0, 16);
}

export function getProjectMemoryPaths(cwd) {
  const projectKey = getProjectKey(cwd);
  const projectDir = path.join(PROJECTS_DIR, projectKey);
  const memoryDir = path.join(projectDir, MEMORY_DIR_NAME);
  const entrypointPath = path.join(memoryDir, MEMORY_ENTRYPOINT);

  return {
    projectKey,
    projectDir,
    memoryDir,
    entrypointPath,
  };
}

export async function ensureMemoryDir(cwd) {
  const paths = getProjectMemoryPaths(cwd);
  await fs.mkdir(paths.memoryDir, { recursive: true });
  return paths;
}

function slugify(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "memory_note";
}

function stripHtmlComments(content) {
  return content.replace(/<!--[\s\S]*?-->/g, "").trim();
}

export function shouldStoreAsMemory(candidate) {
  if (!candidate) return false;
  if (!MEMORY_TYPES.has(candidate.type)) return false;

  // Memory should keep facts that are useful across future conversations.
  if (!candidate.name || !candidate.description || !candidate.body) return false;
  if (candidate.description.length > 200) return false;
  return true;
}

export function buildMemoryFileContent({ name, description, type, body }) {
  return [
    "---",
    "name: " + name,
    "description: " + description,
    "type: " + type,
    "---",
    "",
    body.trim(),
    "",
  ].join("\n");
}

export function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;

  const header = match[1];
  const body = match[2].trim();
  const fields = {};

  for (const line of header.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    fields[key] = value;
  }

  if (!fields.name || !fields.description || !fields.type) return null;

  return {
    name: fields.name,
    description: fields.description,
    type: fields.type,
    body,
  };
}

export async function writeMemoryFile(cwd, memory) {
  if (!shouldStoreAsMemory(memory)) {
    throw new Error("Invalid memory payload.");
  }

  const { memoryDir } = await ensureMemoryDir(cwd);
  const fileName = slugify(memory.name) + ".md";
  const filePath = path.join(memoryDir, fileName);
  const content = buildMemoryFileContent(memory);

  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

export async function readMemoryFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const cleaned = stripHtmlComments(raw);
  const parsed = parseFrontmatter(cleaned);
  if (!parsed) return null;
  return {
    filePath,
    ...parsed,
  };
}

export async function listMemoryFiles(cwd) {
  const { memoryDir } = await ensureMemoryDir(cwd);
  const entries = await fs.readdir(memoryDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== MEMORY_ENTRYPOINT)
    .map((entry) => path.join(memoryDir, entry.name));
}

export function buildMemoryIndex(memories) {
  const lines = ["# Project Memory", ""];

  for (const memory of memories) {
    const fileName = path.basename(memory.filePath);
    lines.push(
      `- [${memory.name}](${fileName}) — ${memory.description}`,
    );
  }

  let text = lines.join("\n").trim() + "\n";
  const limitedLines = text.split(/\r?\n/).slice(0, MAX_ENTRYPOINT_LINES).join("\n");
  text = Buffer.byteLength(limitedLines, "utf8") > MAX_ENTRYPOINT_BYTES
    ? limitedLines.slice(0, MAX_ENTRYPOINT_BYTES)
    : limitedLines;

  return text.trimEnd() + "\n";
}

export async function rebuildMemoryIndex(cwd) {
  const paths = await ensureMemoryDir(cwd);
  const files = await listMemoryFiles(cwd);
  const loaded = await Promise.all(files.map(readMemoryFile));
  const memories = loaded.filter(Boolean);
  const index = buildMemoryIndex(memories);

  await fs.writeFile(paths.entrypointPath, index, "utf8");
  return index;
}

// Write the memory first, then rebuild the index.
export async function saveMemory(cwd, memory) {
  const filePath = await writeMemoryFile(cwd, memory);
  await rebuildMemoryIndex(cwd);
  return filePath;
}

export async function readMemoryEntrypoint(cwd) {
  const { entrypointPath } = await ensureMemoryDir(cwd);
  try {
    return await fs.readFile(entrypointPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

// A small, cheap relevance pass is enough at this stage.
export async function findRelevantMemories(cwd, query) {
  const files = await listMemoryFiles(cwd);
  const loaded = (await Promise.all(files.map(readMemoryFile))).filter(Boolean);
  const queryTerms = query.toLowerCase().split(/\W+/).filter(Boolean);

  return loaded
    .map((memory) => {
      const haystack = [memory.name, memory.description, memory.body].join("\n").toLowerCase();
      const score = queryTerms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      return { memory, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((entry) => {
      return [
        `# ${entry.memory.name}`,
        `Type: ${entry.memory.type}`,
        `Description: ${entry.memory.description}`,
        entry.memory.body,
      ].join("\n\n");
    });
}
