/**
 * Step 3 - Tool interface + first Read tool
 *
 * Goal:
 * - define a tiny tool contract
 * - register tools in one place
 * - implement a readable file reader with line numbers
 */

import fs from "node:fs/promises";
import path from "node:path";

export function resolveWorkspacePath(filePath, cwd) {
  const resolved = path.resolve(cwd, filePath);
  const relative = path.relative(cwd, resolved);

  // Prevent the model from escaping the workspace root.
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path is outside the workspace: " + filePath);
  }

  return resolved;
}

export function addLineNumbers(text, startLine = 1) {
  const lines = text.split(/\r?\n/);
  const width = String(startLine + lines.length - 1).length;

  return lines
    .map((line, index) => String(startLine + index).padStart(width, " ") + "\t" + line)
    .join("\n");
}

export const readTool = {
  name: "Read",
  description: "Read a file from the current workspace. Supports partial reads with offset and limit.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      offset: { type: "number" },
      limit: { type: "number" },
    },
    required: ["file_path"],
  },
  isReadOnly() {
    return true;
  },
  isEnabled() {
    return true;
  },
  async call(input, context) {
    const filePath = input.file_path;
    const offset = input.offset || 1;
    const limit = input.limit;

    if (!filePath) {
      return { content: "Error: file_path is required", isError: true };
    }

    try {
      const resolvedPath = resolveWorkspacePath(filePath, context.cwd);
      const raw = await fs.readFile(resolvedPath, "utf8");
      const allLines = raw.split(/\r?\n/);

      const startIndex = Math.max(0, offset - 1);
      const endIndex = typeof limit === "number" ? startIndex + limit : allLines.length;
      const selected = allLines.slice(startIndex, endIndex);

      return {
        content: [
          "File: " + resolvedPath,
          "Lines: " + (startIndex + 1) + "-" + (startIndex + selected.length) + " / " + allLines.length,
          addLineNumbers(selected.join("\n"), startIndex + 1),
        ].join("\n"),
      };
    } catch (error) {
      return { content: "Error reading file: " + error.message, isError: true };
    }
  },
};

export const allTools = [readTool];

export function findToolByName(name) {
  return allTools.find((tool) => tool.name === name);
}

export function getToolsApiParams() {
  return allTools
    .filter((tool) => tool.isEnabled())
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
}
