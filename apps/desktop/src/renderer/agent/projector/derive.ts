/**
 * Summaries the side panels and the export build from a session view. Pure,
 * like the rest of the projector.
 */

import type { Block, DiffLine, FileChange } from "../viewModel";
import { blocksOf, type SessionView } from "./session";

/**
 * Files this session changed, from its successful Write, Edit, and MultiEdit
 * calls, in the order they were first touched. Changes made by shell
 * commands are not visible here.
 */
export function changesOf(view: SessionView): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const block of blocksOf(view)) {
    if (block.kind !== "tool" || block.tool.status !== "success") continue;
    const { tool } = block;
    if (tool.name !== "Write" && tool.name !== "Edit") continue;
    const path = tool.target;
    const created = tool.created === true;
    const diff: DiffLine[] = tool.diff ?? [];
    const current = byPath.get(path);
    if (!current) {
      byPath.set(path, { path, kind: created ? "added" : "modified", added: tool.added ?? 0, removed: tool.removed ?? 0, diff });
      continue;
    }
    const separator: DiffLine[] = current.diff.length > 0 && diff.length > 0 ? [{ type: "hunk", text: "@@" }] : [];
    byPath.set(path, {
      ...current,
      added: current.added + (tool.added ?? 0),
      removed: current.removed + (tool.removed ?? 0),
      diff: [...current.diff, ...separator, ...diff],
    });
  }
  return [...byPath.values()];
}

function fence(text: string, lang = ""): string {
  const ticks = text.includes("```") ? "````" : "```";
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

function blockMarkdown(block: Block): string | null {
  switch (block.kind) {
    case "user":
      return `## 你\n\n${block.text}`;
    case "assistant":
      return `## Easy Agent\n\n${block.text}`;
    case "thinking":
      return null;
    case "tool": {
      const { tool } = block;
      const head = `> ${tool.label ?? tool.name}${tool.target ? ` \`${tool.target}\`` : ""}`;
      if (tool.name === "Bash" && tool.output) return `${head}\n\n${fence(tool.output)}`;
      if (tool.diff && tool.diff.length > 0)
        return `${head}\n\n${fence(tool.diff.map((l) => (l.type === "add" ? `+${l.text}` : l.type === "del" ? `-${l.text}` : ` ${l.text}`)).join("\n"), "diff")}`;
      return head;
    }
    case "request":
      return null;
    case "notice":
      return `*${block.text}${block.detail ? `：${block.detail}` : ""}*`;
  }
}

/** The visible conversation as Markdown: what was said, tool calls, and notices; thinking is left out. */
export function exportMarkdown(view: SessionView, title: string, now = new Date()): string {
  const header = [`# ${title}`, "", `- 工作区：\`${view.cwd}\``, `- 模型：${view.model}`, `- 导出时间：${now.toLocaleString("zh-CN")}`];
  const body = blocksOf(view)
    .map(blockMarkdown)
    .filter((part): part is string => part !== null);
  return `${[header.join("\n"), ...body].join("\n\n")}\n`;
}
