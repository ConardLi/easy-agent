import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { WorkspacePathError, writeWorkspaceFile } from "./pathUtils.js";

interface FileWriteInput {
  file_path: string;
  content: string;
}

export const fileWriteTool: Tool = {
  name: "Write",
  searchHint: "create or overwrite files",
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

    try {
      const result = await writeWorkspaceFile(input.file_path, context.cwd, input.content);

      return {
        content: `${result.existed ? "Updated" : "Created"} file: ${result.requestedPath} (${input.content.length} chars)`,
      };
    } catch (error: unknown) {
      if (error instanceof WorkspacePathError) {
        return { content: `Error: ${error.message}`, isError: true };
      }
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
