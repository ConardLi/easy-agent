import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { MemoryEntry, MemoryFrontmatter, MemoryType } from "./memoryTypes.js";
import { isMemoryType } from "./memoryTypes.js";
import { getProjectsRoot } from "../../utils/paths.js";

export const MEMORY_ENTRYPOINT = "MEMORY.md";
export const MAX_ENTRYPOINT_LINES = 200;
export const MAX_ENTRYPOINT_BYTES = 25_000;

export interface MemoryDocument extends MemoryEntry {
  frontmatter: MemoryFrontmatter;
  body: string;
  relativePath: string;
}


export interface MemoryHeader extends MemoryEntry {
  frontmatter: MemoryFrontmatter;
  relativePath: string;
}

export interface ProjectPathInfo {
  gitRoot: string;
  projectKey: string;
  projectDir: string;
}

function sanitizeSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "project";
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function scoreTextMatch(haystack: string, terms: string[]): number {
  return terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
}

async function findCanonicalGitRoot(cwd: string): Promise<string> {
  let current = path.resolve(cwd);

  while (true) {
    try {
      await fs.stat(path.join(current, ".git"));
      return current;
    } catch {
      // keep walking upward
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(cwd);
    }
    current = parent;
  }
}

export async function getProjectPathInfo(cwd: string): Promise<ProjectPathInfo> {
  const gitRoot = await findCanonicalGitRoot(cwd);
  const slugBase = sanitizeSlug(path.basename(gitRoot));
  const suffix = crypto.createHash("sha256").update(gitRoot).digest("hex").slice(0, 16);
  const projectKey = `${slugBase}-${suffix}`;
  return {
    gitRoot,
    projectKey,
    projectDir: path.join(getProjectsRoot(), projectKey),
  };
}

export async function getProjectMemoryDir(cwd: string): Promise<string> {
  const { projectDir } = await getProjectPathInfo(cwd);
  return path.join(projectDir, "memory");
}

export async function ensureMemoryDirExists(cwd: string): Promise<string> {
  const memoryDir = await getProjectMemoryDir(cwd);
  await fs.mkdir(memoryDir, { recursive: true });
  const entrypoint = path.join(memoryDir, MEMORY_ENTRYPOINT);
  try {
    await fs.access(entrypoint);
  } catch {
    await fs.writeFile(entrypoint, "# Project Memory\n\n", "utf-8");
  }
  return memoryDir;
}

function parseFrontmatter(raw: string): MemoryFrontmatter | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return null;

  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    fields.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }

  const name = fields.get("name");
  const description = fields.get("description");
  const type = fields.get("type");
  if (!name || !description || !type || !isMemoryType(type)) {
    return null;
  }

  return {
    name: normalizeLine(name),
    description: normalizeLine(description),
    type,
  };
}

function stripFrontmatter(raw: string): string {
  return raw.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

function truncateEntrypoint(raw: string): { content: string; warning?: string } {
  let content = raw;
  let lineTruncated = false;
  let byteTruncated = false;

  const lines = content.split(/\r?\n/);
  if (lines.length > MAX_ENTRYPOINT_LINES) {
    content = lines.slice(0, MAX_ENTRYPOINT_LINES).join("\n");
    lineTruncated = true;
  }

  while (Buffer.byteLength(content, "utf-8") > MAX_ENTRYPOINT_BYTES && content.length > 0) {
    content = content.slice(0, -1);
    byteTruncated = true;
  }

  const warning = lineTruncated || byteTruncated
    ? `> WARNING: MEMORY.md was truncated${lineTruncated ? " by line limit" : ""}${lineTruncated && byteTruncated ? " and" : ""}${byteTruncated ? " by byte limit" : ""}.`
    : undefined;

  return { content: content.trim(), ...(warning ? { warning } : {}) };
}

function buildPointerLine(entry: MemoryEntry): string {
  return `- [${normalizeLine(entry.title)}](${entry.fileName}) — ${normalizeLine(entry.hook)}`;
}

export function formatMemorySystemLocation(memoryDir: string): string[] {
  const entrypointPath = path.join(memoryDir, MEMORY_ENTRYPOINT);
  return [
    `You have a persistent, file-based project memory system at \`${memoryDir}\`.`,
    `The memory index file is \`${entrypointPath}\`.`,
    `The index points to topic memory files stored under \`${memoryDir}\` (including subdirectories).`,
    "Before creating a new memory, inspect existing topic files and update the best match when possible.",
  ];
}

export async function readMemoryEntrypoint(cwd: string): Promise<string | null> {
  const memoryDir = await ensureMemoryDirExists(cwd);
  const entrypoint = path.join(memoryDir, MEMORY_ENTRYPOINT);
  const raw = await fs.readFile(entrypoint, "utf-8");
  const truncated = truncateEntrypoint(raw);
  return [truncated.content, truncated.warning].filter(Boolean).join("\n\n") || null;
}

async function collectMemoryMarkdownFiles(memoryDir: string, currentDir = memoryDir): Promise<string[]> {
  const dirents = await fs.readdir(currentDir, { withFileTypes: true });
  const nested = await Promise.all(
    dirents.map(async (entry) => {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        return collectMemoryMarkdownFiles(memoryDir, fullPath);
      }
      if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== MEMORY_ENTRYPOINT) {
        return [path.relative(memoryDir, fullPath)];
      }
      return [];
    }),
  );

  return nested.flat();
}

export async function loadMemoryHeaders(cwd: string): Promise<MemoryHeader[]> {
  const memoryDir = await ensureMemoryDirExists(cwd);
  const relativePaths = await collectMemoryMarkdownFiles(memoryDir);
  const headers = await Promise.all(
    relativePaths.map(async (relativePath) => {
      const filePath = path.join(memoryDir, relativePath);
      const raw = await fs.readFile(filePath, "utf-8");
      const frontmatter = parseFrontmatter(raw);
      if (!frontmatter) return null;
      return {
        fileName: relativePath,
        relativePath,
        filePath,
        title: frontmatter.name,
        hook: frontmatter.description,
        frontmatter,
      } satisfies MemoryHeader;
    }),
  );

  return headers
    .filter((header): header is MemoryHeader => header !== null)
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function formatMemoryManifest(headers: readonly MemoryHeader[]): string {
  return headers
    .map((header) => `- [${header.frontmatter.type}] ${header.relativePath}: ${header.title} — ${header.hook}`)
    .join("\n");
}

export async function loadMemoryDocumentBodies(cwd: string, relativePaths: readonly string[]): Promise<MemoryDocument[]> {
  const memoryDir = await ensureMemoryDirExists(cwd);
  const uniquePaths = [...new Set(relativePaths)];
  const docs = await Promise.all(
    uniquePaths.map(async (relativePath) => {
      const filePath = path.join(memoryDir, relativePath);
      const raw = await fs.readFile(filePath, "utf-8");
      const frontmatter = parseFrontmatter(raw);
      if (!frontmatter) return null;
      return {
        fileName: relativePath,
        relativePath,
        filePath,
        title: frontmatter.name,
        hook: frontmatter.description,
        frontmatter,
        body: stripFrontmatter(raw),
      } satisfies MemoryDocument;
    }),
  );

  return docs.filter((doc): doc is MemoryDocument => doc !== null);
}

export async function listMemoryFiles(cwd: string): Promise<MemoryDocument[]> {
  const headers = await loadMemoryHeaders(cwd);
  return loadMemoryDocumentBodies(cwd, headers.map((header) => header.relativePath));
}

function slugifyMemoryFileName(name: string): string {
  return sanitizeSlug(name).replace(/\.+/g, "-") + ".md";
}

async function rewriteEntrypoint(memoryDir: string, entries: MemoryEntry[]): Promise<void> {
  const entrypointPath = path.join(memoryDir, MEMORY_ENTRYPOINT);
  const unique = new Map<string, string>();
  for (const entry of entries) {
    unique.set(entry.fileName, buildPointerLine(entry));
  }

  const bodyLines = ["# Project Memory", "", ...[...unique.values()]];
  const truncated = truncateEntrypoint(bodyLines.join("\n"));
  const finalText = [truncated.content, truncated.warning].filter(Boolean).join("\n\n") + "\n";
  await fs.writeFile(entrypointPath, finalText, "utf-8");
}

async function findExistingMemoryFile(cwd: string, name: string, description: string): Promise<string | null> {
  const docs = await listMemoryFiles(cwd);
  const normalizedName = normalizeLine(name).toLowerCase();
  const normalizedDescription = normalizeLine(description).toLowerCase();

  const exact = docs.find((doc) => doc.frontmatter.name.toLowerCase() === normalizedName);
  if (exact) return exact.fileName;

  const similar = docs.find((doc) => {
    const existing = `${doc.frontmatter.name} ${doc.frontmatter.description}`.toLowerCase();
    return existing.includes(normalizedName) || existing.includes(normalizedDescription);
  });

  return similar?.fileName ?? null;
}

export async function writeProjectMemory(input: {
  cwd: string;
  name: string;
  description: string;
  type: MemoryType;
  content: string;
  fileName?: string;
}): Promise<{ filePath: string; fileName: string; updatedExisting: boolean }> {
  const memoryDir = await ensureMemoryDirExists(input.cwd);
  const existingFileName = input.fileName ?? (await findExistingMemoryFile(input.cwd, input.name, input.description));
  const fileName = existingFileName ?? slugifyMemoryFileName(input.name);
  const filePath = path.join(memoryDir, fileName);

  const body = [
    "---",
    `name: ${normalizeLine(input.name)}`,
    `description: ${normalizeLine(input.description)}`,
    `type: ${input.type}`,
    "---",
    "",
    input.content.trim(),
    "",
  ].join("\n");

  await fs.writeFile(filePath, body, "utf-8");
  const docs = await listMemoryFiles(input.cwd);
  await rewriteEntrypoint(memoryDir, docs.map((doc) => ({
    fileName: doc.fileName,
    filePath: doc.filePath,
    title: doc.frontmatter.name,
    hook: doc.frontmatter.description,
  })));

  return { filePath, fileName, updatedExisting: Boolean(existingFileName) };
}

export function shouldIgnoreMemory(query: string): boolean {
  const normalized = query.toLowerCase();
  return ["ignore memory", "don't use memory", "do not use memory", "忽略记忆", "不要用记忆", "别用记忆"].some((term) => normalized.includes(term));
}

export function buildMemoryPromptInstructions(): string[] {
  return [
    "Use memory only for information that will be useful in future conversations and cannot be derived directly from the current repo state.",
    "Supported memory types: user, feedback, project, reference.",
    "When saving a memory, write one markdown file with frontmatter: name, description, type.",
    `After writing or updating a memory file, update ${MEMORY_ENTRYPOINT} with a one-line pointer in the form: - [Title](file.md) — one-line hook.`,
    `${MEMORY_ENTRYPOINT} is an index, not a place to store full memory content.`,
    `Keep ${MEMORY_ENTRYPOINT} under ${MAX_ENTRYPOINT_LINES} lines and ${MAX_ENTRYPOINT_BYTES} bytes.`,
    "Before creating a new memory, inspect existing topic memory files and update the best match when possible.",
  ];
}
