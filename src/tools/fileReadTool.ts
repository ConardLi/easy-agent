/**
 * FileReadTool — Read file contents with optional line range.
 */

import * as fs from "node:fs/promises";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { resolveWorkspacePath } from "./pathUtils.js";

interface FileReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
}

function addLineNumbers(content: string, startLine: number): string {
  const lines = content.split("\n");
  const maxLineNum = startLine + lines.length - 1;
  const padWidth = String(maxLineNum).length;

  return lines
    .map((line, index) => `${String(startLine + index).padStart(padWidth, " ")}\t${line}`)
    .join("\n");
}

export const fileReadTool: Tool = {
  name: "Read",
  description:
    "Read the contents of a file at the specified path. " +
    "Use offset and limit to read specific line ranges for large files. " +
    "Output includes line numbers in cat -n format.",
  inputSchema: {
    type: "object" as const,
    properties: {
      file_path: {
        type: "string",
        description: "The absolute or relative path to the file to read",
      },
      offset: {
        type: "number",
        description: "The 1-indexed line number to start reading from (default: 1)",
      },
      limit: {
        type: "number",
        description: "The number of lines to read. If not provided, reads the entire file",
      },
    },
    required: ["file_path"],
  },
  async call(rawInput: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const input = rawInput as unknown as FileReadInput;
    if (!input.file_path) {
      return { content: "Error: file_path is required", isError: true };
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

    const offset = input.offset ?? 1;
    const limit = input.limit;

    try {
      const stat = await fs.stat(resolvedPath);
      if (stat.isDirectory()) {
        const entries = await fs.readdir(resolvedPath);
        return { content: `Directory listing for ${input.file_path}:\n${entries.join("\n")}` };
      }

      const raw = await fs.readFile(resolvedPath, "utf-8");
      const allLines = raw.split("\n");
      const startIdx = Math.max(0, offset - 1);
      const endIdx = limit ? startIdx + limit : allLines.length;
      const selectedLines = allLines.slice(startIdx, endIdx);
      const numbered = addLineNumbers(selectedLines.join("\n"), startIdx + 1);
      const numLines = selectedLines.length;
      const rangeInfo =
        startIdx > 0 || endIdx < allLines.length
          ? ` (lines ${startIdx + 1}-${startIdx + numLines} of ${allLines.length})`
          : ` (${allLines.length} lines)`;

      return { content: `${resolvedPath}${rangeInfo}\n${numbered}` };
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return { content: `Error: File not found: ${input.file_path}`, isError: true };
      }
      if (err.code === "EACCES") {
        return { content: `Error: Permission denied: ${input.file_path}`, isError: true };
      }
      return { content: `Error reading file: ${err.message}`, isError: true };
    }
  },
  isReadOnly(): boolean {
    return true;
  },
  isEnabled(): boolean {
    return true;
  },
};
