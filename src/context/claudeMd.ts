import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getGlobalAgentMdPath } from "../utils/paths.js";

const AGENT_MD_NAME = "AGENT.md";

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
  const files = await getAgentMdFiles(cwd);
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
