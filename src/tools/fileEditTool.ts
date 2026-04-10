import * as fs from "node:fs/promises";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { resolveWorkspacePath } from "./pathUtils.js";

interface FileEditInput {
  file_path: string;
  old_string: string;
  new_string: string;
}

function normalizeQuotes(value: string): string {
  return value
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let fromIndex = 0;
  while (true) {
    const foundIndex = haystack.indexOf(needle, fromIndex);
    if (foundIndex === -1) return count;
    count += 1;
    fromIndex = foundIndex + needle.length;
  }
}

function buildEditPreview(oldString: string, newString: string): string {
  const oldLines = oldString.split("\n").slice(0, 3);
  const newLines = newString.split("\n").slice(0, 3);
  return [
    "Preview:",
    ...oldLines.map((line) => `- ${line}`),
    ...newLines.map((line) => `+ ${line}`),
  ].join("\n");
}

export const fileEditTool: Tool = {
  name: "Edit",
  description: "Find a unique string in a file, replace it, and write the updated content back.",
  inputSchema: {
    type: "object" as const,
    properties: {
      file_path: { type: "string", description: "File path to edit" },
      old_string: { type: "string", description: "Existing text to replace; must match uniquely" },
      new_string: { type: "string", description: "Replacement text" },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  async call(rawInput: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const input = rawInput as unknown as FileEditInput;
    if (!input.file_path || typeof input.old_string !== "string" || typeof input.new_string !== "string") {
      return { content: "Error: file_path, old_string, and new_string are required", isError: true };
    }

    const oldString = normalizeQuotes(input.old_string);
    const newString = normalizeQuotes(input.new_string);

    if (!oldString) {
      return { content: "Error: old_string must not be empty", isError: true };
    }

    let resolvedPath: string;
    try {
      resolvedPath = resolveWorkspacePath(input.file_path, context.cwd);
    } catch (error: unknown) {
      return {
        content: error instanceof Error ? `Error: ${error.message}` : `Error: ${String(error)}`,
        isError: true,
      };
    }

    try {
      const original = await fs.readFile(resolvedPath, "utf-8");
      const occurrences = countOccurrences(original, oldString);
      if (occurrences === 0) {
        return { content: `Error: old_string not found in ${resolvedPath}`, isError: true };
      }
      if (occurrences > 1) {
        return { content: `Error: old_string matched ${occurrences} times; Edit requires a unique match`, isError: true };
      }

      const updated = original.replace(oldString, newString);
      await fs.writeFile(resolvedPath, updated, "utf-8");

      return {
        content: `Updated file: ${resolvedPath}\n${buildEditPreview(oldString, newString)}`,
      };
    } catch (error: unknown) {
      return {
        content: `Error editing file: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
  isReadOnly(): boolean {
    return false;
  },
  isEnabled(): boolean {
    return true;
  },
};
