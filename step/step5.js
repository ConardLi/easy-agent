/**
 * Step 5 - Core tools in one teaching file
 *
 * Goal:
 * - show the essential patterns behind Read / Write / Edit / Grep / Glob / Bash
 * - keep each tool short enough to learn from quickly
 */

import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function resolveWorkspacePath(filePath, cwd) {
  const resolved = path.resolve(cwd, filePath || ".");
  const relative = path.relative(cwd, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path is outside the workspace: " + filePath);
  }
  return resolved;
}

function countOccurrences(text, pattern) {
  let count = 0;
  let index = 0;
  while (true) {
    index = text.indexOf(pattern, index);
    if (index === -1) return count;
    count += 1;
    index += pattern.length;
  }
}

export const readTool = {
  name: "Read",
  description: "Read file content.",
  inputSchema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
  isReadOnly: () => true,
  isEnabled: () => true,
  async call(input, context) {
    const resolved = resolveWorkspacePath(input.file_path, context.cwd);
    const raw = await fs.readFile(resolved, "utf8");
    return { content: raw };
  },
};

export const writeTool = {
  name: "Write",
  description: "Create or overwrite a file.",
  inputSchema: {
    type: "object",
    properties: { file_path: { type: "string" }, content: { type: "string" } },
    required: ["file_path", "content"],
  },
  isReadOnly: () => false,
  isEnabled: () => true,
  async call(input, context) {
    const resolved = resolveWorkspacePath(input.file_path, context.cwd);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, input.content, "utf8");
    return { content: "Wrote " + resolved };
  },
};

export const editTool = {
  name: "Edit",
  description: "Replace one unique string inside a file.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  isReadOnly: () => false,
  isEnabled: () => true,
  async call(input, context) {
    const resolved = resolveWorkspacePath(input.file_path, context.cwd);
    const original = await fs.readFile(resolved, "utf8");
    const matches = countOccurrences(original, input.old_string);

    if (matches !== 1) {
      return { content: "Error: expected 1 match, got " + matches, isError: true };
    }

    const updated = original.replace(input.old_string, input.new_string);
    await fs.writeFile(resolved, updated, "utf8");
    return { content: "Edited " + resolved };
  },
};

export const grepTool = {
  name: "Grep",
  description: "Search file contents with ripgrep.",
  inputSchema: {
    type: "object",
    properties: { pattern: { type: "string" }, path: { type: "string" } },
    required: ["pattern"],
  },
  isReadOnly: () => true,
  isEnabled: () => true,
  async call(input, context) {
    const targetPath = resolveWorkspacePath(input.path || ".", context.cwd);
    try {
      const { stdout } = await execFileAsync("rg", ["-n", input.pattern, targetPath]);
      return { content: stdout.trim() || "No matches found" };
    } catch (error) {
      return { content: (error.stdout || "").trim() || "No matches found" };
    }
  },
};

export const globTool = {
  name: "Glob",
  description: "Find files by glob pattern.",
  inputSchema: {
    type: "object",
    properties: { pattern: { type: "string" }, path: { type: "string" } },
    required: ["pattern"],
  },
  isReadOnly: () => true,
  isEnabled: () => true,
  async call(input, context) {
    const cwd = resolveWorkspacePath(input.path || ".", context.cwd);
    const { stdout } = await execFileAsync("rg", ["--files", "-g", input.pattern], { cwd });
    return { content: stdout.trim() || "No files matched" };
  },
};

export const bashTool = {
  name: "Bash",
  description: "Run a shell command in the workspace.",
  inputSchema: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
  isReadOnly: () => false,
  isEnabled: () => true,
  async call(input, context) {
    return new Promise((resolve) => {
      const child = spawn(process.env.SHELL || "bash", ["-lc", input.command], {
        cwd: context.cwd,
        env: process.env,
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("close", (code) => {
        resolve({
          content: [
            "Exit code: " + code,
            "STDOUT:",
            stdout,
            "STDERR:",
            stderr,
          ].join("\n").trim(),
          isError: code !== 0,
        });
      });
    });
  },
};
