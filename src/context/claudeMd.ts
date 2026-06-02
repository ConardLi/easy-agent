import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getGlobalAgentMdPath } from "../utils/paths.js";
import { loadSettingSources } from "../config/sources.js";

const AGENT_MD_NAME = "AGENT.md";

/**
 * Compile a glob pattern (matched against absolute file paths) to a RegExp.
 * Supports `**` (any chars incl. separators), `*` (any non-separator run), and
 * `?` (single non-separator). Mirrors the picomatch-style matching source uses
 * for `claudeMdExcludes`.
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
    files.push(path.join(dir, AGENT_MD_NAME));
  }
  return files;
}

export async function loadAgentMdContext(cwd: string): Promise<string> {
  const [allFiles, excludes] = await Promise.all([
    getAgentMdFiles(cwd),
    loadAgentMdExcludes(cwd),
  ]);
  const files = allFiles.filter((filePath) => !isAgentMdExcluded(filePath, excludes));
  const loaded = await Promise.all(
    files.map(async (filePath) => {
      const content = await readIfExists(filePath);
      return content ? { filePath, content } : null;
    }),
  );

  const sections = loaded
    .filter((entry): entry is { filePath: string; content: string } => entry !== null)
    .map((entry) => "# Source: " + entry.filePath + "\n" + entry.content);

  return sections.join("\n\n");
}
