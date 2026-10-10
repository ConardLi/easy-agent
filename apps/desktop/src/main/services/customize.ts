/**
 * Files behind the customize pages: rule files and skill folders the user
 * edits, uploads, or removes, and the project's `.mcp.json`. Everything else
 * the pages change goes through the Agent (`config/write`).
 *
 * Paths come from the renderer, so each one is resolved through symlinks and
 * must sit inside the workspace or `~/.easy-agent`, or be an AGENTS.md /
 * AGENT.md in a parent of the workspace (those load as rules too). Writes are
 * limited to Markdown files.
 */

import { cp, lstat, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SkillPreview } from "../../shared/contract";

const MAX_READ_BYTES = 512 * 1024;
const MAX_LISTED = 200;
const SKIPPED = new Set([".git", "node_modules", ".DS_Store"]);
const RULE_NAMES = new Set(["AGENTS.md", "AGENT.md"]);
const SKILL_NAME = /^[A-Za-z0-9][\w.-]{0,63}$/;

export type SkillScope = "user" | "project";

export const easyAgentHome = (): string => join(homedir(), ".easy-agent");

export function skillsRoot(workspace: string, scope: SkillScope): string {
  return scope === "user" ? join(easyAgentHome(), "skills") : join(workspace, ".easy-agent", "skills");
}

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** The path with `~` expanded and symlinks resolved; a file that does not exist yet resolves through its folder. */
async function resolveReal(path: string): Promise<string> {
  const absolute = resolve(path.replace(/^~(?=$|\/)/, homedir()));
  try {
    return await realpath(absolute);
  } catch {
    return join(await resolveReal(dirname(absolute)), basename(absolute));
  }
}

/** Resolve a renderer-supplied path and refuse anything outside what the customize pages may touch. */
export async function checkPath(workspace: string, path: string, { write = false } = {}): Promise<string> {
  if (!path || !(isAbsolute(path) || path.startsWith("~"))) throw new Error("需要绝对路径");
  const target = await resolveReal(path);
  const root = await resolveReal(workspace);
  const home = await resolveReal(easyAgentHome());
  const parentRule = RULE_NAMES.has(basename(target)) && inside(dirname(target), root);
  if (!inside(root, target) && !inside(home, target) && !parentRule) throw new Error(`不能访问这个位置：${path}`);
  if (write && extname(target).toLowerCase() !== ".md") throw new Error("只能编辑 Markdown 文件");
  return target;
}

export async function readText(workspace: string, path: string): Promise<string> {
  const target = await checkPath(workspace, path);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("不是文件");
  if (info.size > MAX_READ_BYTES) throw new Error("文件太大，请在编辑器里打开");
  return readFile(target, "utf8");
}

/** Write a Markdown file, creating its folder; replaces the file in one step. */
export async function writeText(workspace: string, path: string, content: string): Promise<void> {
  const target = await checkPath(workspace, path, { write: true });
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, content, "utf8");
  await rename(temp, target);
}

/** Files under `dir`, relative to it, skipping VCS and dependency folders. */
async function filesUnder(dir: string): Promise<string[]> {
  const files: string[] = [];
  const queue = [dir];
  while (queue.length > 0 && files.length < MAX_LISTED) {
    const current = queue.shift()!;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (SKIPPED.has(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile()) files.push(relative(dir, path).split(sep).join("/"));
    }
  }
  return files.slice(0, MAX_LISTED);
}

export async function listFiles(workspace: string, dir: string): Promise<string[]> {
  return filesUnder(await checkPath(workspace, dir));
}

/** `name` and `description` from a SKILL.md frontmatter block. */
export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (!block) return {};
  const get = (key: string) =>
    new RegExp(`^${key}:\\s*(.+)$`, "m")
      .exec(block)?.[1]
      ?.trim()
      .replace(/^(["'])(.*)\1$/, "$2");
  return { name: get("name"), description: get("description") };
}

/** Read a skill folder (or a lone SKILL.md) before installing it. */
export async function previewSkill(source: string): Promise<SkillPreview> {
  const path = await resolveReal(source);
  const info = await stat(path);
  const folder = info.isDirectory() ? path : dirname(path);
  if (!info.isDirectory() && basename(path) !== "SKILL.md") throw new Error("请选择技能文件夹或 SKILL.md");
  const skillFile = join(folder, "SKILL.md");
  const text = await readFile(skillFile, "utf8").catch(() => {
    throw new Error("这个文件夹里没有 SKILL.md");
  });
  const meta = parseSkillFrontmatter(text);
  const name = meta.name && SKILL_NAME.test(meta.name) ? meta.name : basename(folder);
  if (!SKILL_NAME.test(name)) throw new Error(`技能名「${name}」只能用字母、数字、点、下划线和连字符`);
  return {
    source: info.isDirectory() ? folder : path,
    name,
    description: meta.description ?? "",
    files: info.isDirectory() ? await filesUnder(folder) : ["SKILL.md"],
  };
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/**
 * Copy a skill into the user or project skills folder under its name and
 * return the destination. Fails when a skill of that name is already there;
 * to replace it, move the old one to the trash first.
 */
export async function installSkill(workspace: string, source: string, scope: SkillScope): Promise<string> {
  const preview = await previewSkill(source);
  const root = skillsRoot(workspace, scope);
  const dest = join(root, preview.name);
  if (await exists(dest)) throw new Error(`已经有一个名为 ${preview.name} 的技能`);
  const from = await resolveReal(preview.source);
  if (inside(from, await resolveReal(dest))) throw new Error("不能把技能复制到它自己的文件夹里");
  await mkdir(root, { recursive: true });
  if (basename(from) === "SKILL.md") {
    await mkdir(dest);
    await cp(from, join(dest, "SKILL.md"));
  } else {
    await cp(from, dest, { recursive: true, filter: (path) => !SKIPPED.has(basename(path)) });
  }
  return dest;
}

/** The skill folder a removal may target: `<skills root>/<name>` with a SKILL.md in it. */
export async function skillFolderToRemove(workspace: string, dir: string): Promise<string> {
  const target = await resolveReal(dir);
  const roots = await Promise.all((["user", "project"] as const).map((scope) => resolveReal(skillsRoot(workspace, scope))));
  if (!roots.includes(dirname(target)) || !(await exists(join(target, "SKILL.md")))) {
    throw new Error("只能删除全局或项目 skills 文件夹里的技能");
  }
  return target;
}

/** Add, replace, or (with null) remove one server in the project's `.mcp.json`. */
export async function setMcpJsonServer(workspace: string, name: string, entry: Record<string, unknown> | null): Promise<void> {
  if (!/^[\w.-]{1,64}$/.test(name)) throw new Error("服务器名只能用字母、数字、点、下划线和连字符");
  const file = join(workspace, ".mcp.json");
  let config: { mcpServers?: Record<string, unknown> } = {};
  const text = await readFile(file, "utf8").catch(() => null);
  if (text !== null) {
    try {
      config = JSON.parse(text);
    } catch {
      throw new Error(".mcp.json 不是合法的 JSON，请先在编辑器里修好");
    }
  }
  const servers = { ...(config.mcpServers ?? {}) };
  if (entry) servers[name] = entry;
  else delete servers[name];
  const next = { ...config, mcpServers: servers };
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(temp, file);
}
