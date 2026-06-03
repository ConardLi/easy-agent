import * as fs from "node:fs/promises";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { resolveWorkspacePath } from "./pathUtils.js";
import {
  applyEditsToContent,
  EditError,
  type SingleEdit,
} from "./editCore.js";

/**
 * MultiEdit — apply several find/replace edits to a single file in one call.
 *
 * Reference: claude-code-source-code MultiEdit semantics. The point of the
 * tool is to cut tool round-trips and to make a batch of edits ATOMIC:
 *
 *   - edits apply in order; each one operates on the result of the previous
 *     (so you can create a string in edit #1 and modify it in edit #2)
 *   - if ANY edit fails to match, nothing is written and the error names the
 *     failing edit's index — the file is left untouched
 *
 * File-history snapshotting (for /rewind) is handled by the agentic loop,
 * which backs up the target file before Write/Edit/MultiEdit runs.
 */
interface MultiEditInput {
  file_path: string;
  edits: SingleEdit[];
}

function validateEdits(value: unknown): value is SingleEdit[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(
    (e) =>
      e &&
      typeof e === "object" &&
      typeof (e as SingleEdit).old_string === "string" &&
      typeof (e as SingleEdit).new_string === "string",
  );
}

export const multiEditTool: Tool = {
  name: "MultiEdit",
  description:
    "Apply multiple find/replace edits to a single file atomically and in order. Each edit sees the result of the previous one. If any edit fails to match, no changes are written.",
  inputSchema: {
    type: "object" as const,
    properties: {
      file_path: { type: "string", description: "File path to edit" },
      edits: {
        type: "array",
        description: "Ordered list of edits to apply to the file.",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string", description: "Existing text to replace" },
            new_string: { type: "string", description: "Replacement text" },
            replace_all: {
              type: "boolean",
              description: "Replace all occurrences of old_string in this edit (default false).",
            },
          },
          required: ["old_string", "new_string"],
        },
      },
    },
    required: ["file_path", "edits"],
  },
  async call(rawInput: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const input = rawInput as unknown as MultiEditInput;
    if (!input.file_path) {
      return { content: "Error: file_path is required", isError: true };
    }
    if (!validateEdits(input.edits)) {
      return {
        content: "Error: edits must be a non-empty array of { old_string, new_string } objects",
        isError: true,
      };
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
      let totalReplacements: number;
      try {
        const result = applyEditsToContent(original, input.edits);
        updated = result.content;
        totalReplacements = result.totalReplacements;
      } catch (error) {
        if (error instanceof EditError) {
          // Atomic: nothing written when any edit fails.
          return { content: `Error: ${error.message} (no changes written to ${resolvedPath})`, isError: true };
        }
        throw error;
      }

      await fs.writeFile(resolvedPath, updated, "utf-8");

      return {
        content: `Updated file: ${resolvedPath} — applied ${input.edits.length} edit(s), ${totalReplacements} replacement(s)`,
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
