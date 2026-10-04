/**
 * Pure helper functions for the QueryEngine layer.
 *
 * Extracted verbatim from queryEngine.ts. Everything here is side-effect-free
 * and depends only on its arguments, so it can be unit-tested in isolation and
 * shared by the command-handler modules.
 */

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { Usage } from "../../types/message.js";

export function createEmptyUsage(): Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
  };
}

/** Flatten an assistant message's content down to its text blocks. */
export function extractAssistantText(message: MessageParam): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("\n");
}

/**
 * Split `git diff` output into one entry per file. Each entry keeps the patch
 * body (the lines after the `diff --git` header) so the UI can colorize the
 * `@@`/`+`/`-` lines. Rename/mode-only diffs are preserved as-is.
 */
export function parseGitDiff(patch: string): { path: string; lines: string[] }[] {
  const out: { path: string; lines: string[] }[] = [];
  let current: { path: string; lines: string[] } | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current) out.push(current);
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      const path = match ? match[2]! : line.slice("diff --git ".length).trim();
      current = { path, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) out.push(current);
  // Drop a trailing empty line many git versions append.
  for (const file of out) {
    while (file.lines.length > 0 && file.lines[file.lines.length - 1] === "") {
      file.lines.pop();
    }
  }
  return out;
}

/** Map each path from `git status --short` to its 2-char porcelain status. */
export function parseGitStatus(status: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of status.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2).trim();
    let rest = line.slice(3);
    // Renames render as "old -> new"; key on the new path git diff reports.
    const arrow = rest.indexOf(" -> ");
    if (arrow >= 0) rest = rest.slice(arrow + 4);
    map.set(rest.trim(), code || "M");
  }
  return map;
}

/** Parse `git diff --shortstat` ("N files changed, A insertions(+), D deletions(-)"). */
export function parseShortStat(shortstat: string): { files: number; insertions: number; deletions: number } | null {
  const text = shortstat.trim();
  if (!text) return null;
  const files = Number(/(\d+) files? changed/.exec(text)?.[1] ?? 0);
  const insertions = Number(/(\d+) insertions?\(\+\)/.exec(text)?.[1] ?? 0);
  const deletions = Number(/(\d+) deletions?\(-\)/.exec(text)?.[1] ?? 0);
  return { files, insertions, deletions };
}
