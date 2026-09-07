import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import {
  resolveSafePath,
  updateWorkspaceTextFile,
  WorkspacePathError,
} from "./pathUtils.js";
import {
  applyEditToContent,
  buildEditPreview,
  EditError,
  normalizeQuotes,
} from "./editCore.js";

interface FileEditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  /**
   * When true, replace EVERY occurrence of old_string (and report the count)
   * instead of requiring a unique match. Defaults to false, which keeps the
   * safe "must match exactly once" behavior.
   */
  replace_all?: boolean;
}

export const fileEditTool: Tool = {
  name: "Edit",
  searchHint: "modify file contents in place",
  description:
    "Find a string in a file and replace it. By default old_string must match uniquely; set replace_all=true to replace all occurrences.",
  inputSchema: {
    type: "object" as const,
    properties: {
      file_path: { type: "string", description: "File path to edit" },
      old_string: { type: "string", description: "Existing text to replace; must match uniquely unless replace_all is true" },
      new_string: { type: "string", description: "Replacement text" },
      replace_all: {
        type: "boolean",
        description: "Replace all occurrences of old_string (default false). Use for renaming a symbol across a file.",
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  async call(rawInput: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const input = rawInput as unknown as FileEditInput;
    if (!input.file_path || typeof input.old_string !== "string" || typeof input.new_string !== "string") {
      return { content: "Error: file_path, old_string, and new_string are required", isError: true };
    }

    try {
      const result = await updateWorkspaceTextFile(input.file_path, context.cwd, (original) => {
        const edit = applyEditToContent(original, {
          old_string: input.old_string,
          new_string: input.new_string,
          replace_all: input.replace_all === true,
        });
        return { content: edit.content, value: edit.replacements };
      });

      const countNote = result.value > 1 ? ` (${result.value} occurrences)` : "";
      return {
        content: `Updated file: ${result.requestedPath}${countNote}\n${buildEditPreview(
          normalizeQuotes(input.old_string),
          normalizeQuotes(input.new_string),
        )}`,
      };
    } catch (error: unknown) {
      if (error instanceof EditError) {
        return {
          content: `Error: ${error.message} in ${resolveSafePath(input.file_path, context.cwd)}`,
          isError: true,
        };
      }
      if (error instanceof WorkspacePathError) {
        return { content: `Error: ${error.message}`, isError: true };
      }
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
