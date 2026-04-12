import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MemoryEntry, MemoryFrontmatter, MemoryType } from "./memoryTypes.js";
import { isMemoryType } from "./memoryTypes.js";

export const MEMORY_ENTRYPOINT = "MEMORY.md";
export const MAX_ENTRYPOINT_LINES = 200;
export const MAX_ENTRYPOINT_BYTES = 25_000;
const MAX_RELEVANT_MEMORIES = 5;
const EASY_AGENT_HOME = path.join(os.homedir(), ".easy-agent");
const PROJECTS_DIR = path.join(EASY_AGENT_HOME, "projects");

export interface MemoryDocument extends MemoryEntry {
  frontmatter: MemoryFrontmatter;
  body: string;
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
    projectDir: path.join(PROJECTS_DIR, projectKey),
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

export async function readMemoryEntrypoint(cwd: string): Promise<string | null> {
  const memoryDir = await ensureMemoryDirExists(cwd);
  const entrypoint = path.join(memoryDir, MEMORY_ENTRYPOINT);
  const raw = await fs.readFile(entrypoint, "utf-8");
  const truncated = truncateEntrypoint(raw);
  return [truncated.content, truncated.warning].filter(Boolean).join("\n\n") || null;
}

export async function listMemoryFiles(cwd: string): Promise<MemoryDocument[]> {
  const memoryDir = await ensureMemoryDirExists(cwd);
  const dirents = await fs.readdir(memoryDir, { withFileTypes: true });
  const docs = await Promise.all(
    dirents
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== MEMORY_ENTRYPOINT)
      .map(async (entry) => {
        const filePath = path.join(memoryDir, entry.name);
        const raw = await fs.readFile(filePath, "utf-8");
        const frontmatter = parseFrontmatter(raw);
        if (!frontmatter) return null;
        return {
          fileName: entry.name,
          filePath,
          title: frontmatter.name,
          hook: frontmatter.description,
          frontmatter,
          body: stripFrontmatter(raw),
        } satisfies MemoryDocument;
      }),
  );

  return docs
    .filter((doc): doc is MemoryDocument => doc !== null)
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
}

export async function loadRelevantMemories(
  cwd: string,
  query: string,
  options?: { alreadySurfaced?: ReadonlySet<string>; ignoreMemory?: boolean },
): Promise<string[]> {
  if (options?.ignoreMemory) return [];

  const normalizedQuery = normalizeLine(query).toLowerCase();
  if (normalizedQuery.length < 3) return [];

  const terms = normalizedQuery.split(/[^a-zA-Z0-9_\-\u4e00-\u9fff]+/).filter(Boolean);
  if (terms.length === 0) return [];

  const docs = await listMemoryFiles(cwd);
  const scored = docs
    .filter((doc) => !(options?.alreadySurfaced?.has(doc.fileName) ?? false))
    .map((doc) => {
      const haystack = `${doc.frontmatter.name}\n${doc.frontmatter.description}\n${doc.body}`.toLowerCase();
      return { doc, score: scoreTextMatch(haystack, terms) };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RELEVANT_MEMORIES);

  return scored.map((item) => {
    const header = buildPointerLine(item.doc);
    return `${header}\n\n${item.doc.body}`.trim();
  });
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

export function buildMemoryPromptInstructions(memoryDir: string): string[] {
  return [
    `You have a persistent, file-based project memory directory at ${memoryDir}.`,
    "Use memory only for information that will be useful in future conversations and cannot be derived directly from the current repo state.",
    "Supported memory types: user, feedback, project, reference.",
    "When saving a memory, write one markdown file with frontmatter: name, description, type.",
    `After writing or updating a memory file, update ${MEMORY_ENTRYPOINT} with a one-line pointer in the form: - [Title](file.md) — one-line hook.`,
    `${MEMORY_ENTRYPOINT} is an index, not a place to store full memory content.`,
    `Keep ${MEMORY_ENTRYPOINT} under ${MAX_ENTRYPOINT_LINES} lines and ${MAX_ENTRYPOINT_BYTES} bytes.`,
    "Before creating a new memory, check whether an existing memory should be updated instead.",
  ];
}
