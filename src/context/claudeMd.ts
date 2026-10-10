import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getGlobalAgentMdPath } from "../utils/paths.js";
import { loadSettingSources } from "../config/sources.js";

export const AGENT_MD_NAME = "AGENT.md";
export const AGENTS_MD_NAME = "AGENTS.md";
/**
 * Project memory file names, in load order within one directory. `AGENTS.md`
 * is the shared convention across agent tools; `AGENT.md` is Easy Agent's own
 * name. When both exist, both load and the more specific `AGENT.md` comes last.
 */
export const PROJECT_MEMORY_FILE_NAMES = [AGENTS_MD_NAME, AGENT_MD_NAME] as const;

/**
 * Compile a glob pattern (matched against absolute file paths) to a RegExp.
 * Supports `**` (any chars incl. separators), `*` (any non-separator run), and
 * `?` (single non-separator), the picomatch-style subset needed for
 * `claudeMdExcludes`.
 */
function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
        if (pattern[i + 1] === "/") i++; // collapse `**/` into `.*`
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Merge the `claudeMdExcludes` glob list across all settings sources. Excludes
 * only ever REMOVE files (fail-safe), so they're read from every source.
 */
async function loadAgentMdExcludes(cwd: string): Promise<string[]> {
  const sources = await loadSettingSources(cwd);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const src of sources) {
    const arr = src.raw?.["claudeMdExcludes"];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (typeof item !== "string") continue;
      const trimmed = item.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        out.push(trimmed);
      }
    }
  }
  return out;
}

function isAgentMdExcluded(filePath: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  const abs = path.resolve(filePath);
  return patterns.some((pattern) => {
    if (pattern === abs) return true;
    try {
      return globToRegExp(pattern).test(abs);
    } catch {
      return false;
    }
  });
}

function stripHtmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, "").trim();
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    const raw = await fs.readFile(filePath, "utf-8");
    const stripped = stripHtmlComments(raw).trim();
    return stripped || null;
  } catch {
    return null;
  }
}

function getDirectoryChain(cwd: string): string[] {
  const resolved = path.resolve(cwd);
  const chain: string[] = [];
  let current = resolved;

  while (true) {
    chain.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return chain.reverse();
}

export async function getAgentMdFiles(cwd: string): Promise<string[]> {
  const files: string[] = [getGlobalAgentMdPath()];
  for (const dir of getDirectoryChain(cwd)) {
    for (const name of PROJECT_MEMORY_FILE_NAMES) files.push(path.join(dir, name));
  }
  return files;
}

/** A project memory file that exists, in load order. */
export interface AgentMdFile {
  filePath: string;
  /** `global` is the user-wide file, `project` sits in the workspace, `ancestor` in a parent directory. */
  scope: "global" | "ancestor" | "project";
  /** Matched by `claudeMdExcludes`, so it is not loaded. */
  excluded: boolean;
  /** Content as loaded: HTML comments removed, trimmed. */
  content: string;
}

/** Every non-empty project memory file in load order, excluded ones included and marked. */
export async function listAgentMdFiles(cwd: string): Promise<AgentMdFile[]> {
  const [allFiles, excludes] = await Promise.all([getAgentMdFiles(cwd), loadAgentMdExcludes(cwd)]);
  const globalPath = getGlobalAgentMdPath();
  const workspace = path.resolve(cwd);
  const loaded = await Promise.all(
    allFiles.map(async (filePath): Promise<AgentMdFile | null> => {
      const content = await readIfExists(filePath);
      if (!content) return null;
      const scope = filePath === globalPath ? "global" : path.dirname(filePath) === workspace ? "project" : "ancestor";
      return { filePath, scope, excluded: isAgentMdExcluded(filePath, excludes), content };
    }),
  );
  return loaded.filter((entry): entry is AgentMdFile => entry !== null);
}

/** The text one loaded file contributes to the project memory section. */
export function formatAgentMdSection(file: Pick<AgentMdFile, "filePath" | "content">): string {
  return "# Source: " + file.filePath + "\n" + file.content;
}

export async function loadAgentMdContext(cwd: string): Promise<string> {
  const files = await listAgentMdFiles(cwd);
  return files
    .filter((file) => !file.excluded)
    .map(formatAgentMdSection)
    .join("\n\n");
}
