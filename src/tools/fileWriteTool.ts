import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { resolveWorkspacePath } from "./pathUtils.js";

interface FileWriteInput {
  file_path: string;
  content: string;
}

export const fileWriteTool: Tool = {
  name: "Write",
  description: "Create a file or overwrite an existing file with the provided content.",
  inputSchema: {
    type: "object" as const,
    properties: {
      file_path: { type: "string", description: "File path to write" },
      content: { type: "string", description: "Full file content to write" },
    },
    required: ["file_path", "content"],
  },
  async call(rawInput: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const input = rawInput as unknown as FileWriteInput;
    if (!input.file_path) {
      return { content: "Error: file_path is required", isError: true };
    }
    if (typeof input.content !== "string") {
      return { content: "Error: content must be a string", isError: true };
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
      let existed = true;
      try {
        await fs.access(resolvedPath);
      } catch {
        existed = false;
      }

      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.writeFile(resolvedPath, input.content, "utf-8");

      return {
        content: `${existed ? "Updated" : "Created"} file: ${resolvedPath} (${input.content.length} chars)`,
      };
    } catch (error: unknown) {
      return {
        content: `Error writing file: ${error instanceof Error ? error.message : String(error)}`,
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
