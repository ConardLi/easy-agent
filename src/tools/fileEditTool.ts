import * as fs from "node:fs/promises";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { resolveWorkspacePath } from "./pathUtils.js";
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

      let updated: string;
      let replacements: number;
      try {
        const result = applyEditToContent(original, {
          old_string: input.old_string,
          new_string: input.new_string,
          replace_all: input.replace_all === true,
        });
        updated = result.content;
        replacements = result.replacements;
      } catch (error) {
        if (error instanceof EditError) {
          return { content: `Error: ${error.message} in ${resolvedPath}`, isError: true };
        }
        throw error;
      }

      await fs.writeFile(resolvedPath, updated, "utf-8");

      const countNote = replacements > 1 ? ` (${replacements} occurrences)` : "";
      return {
        content: `Updated file: ${resolvedPath}${countNote}\n${buildEditPreview(
          normalizeQuotes(input.old_string),
          normalizeQuotes(input.new_string),
        )}`,
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
