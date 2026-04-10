import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { resolveWorkspacePath } from "./pathUtils.js";

const execFileAsync = promisify(execFile);

interface GlobInput {
  pattern: string;
  path?: string;
}

async function hasCommand(command: string): Promise<boolean> {
  try {
    await execFileAsync("sh", ["-lc", `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}

export const globTool: Tool = {
  name: "Glob",
  description: "Find files by glob pattern. Prefer this over Bash for file discovery.",
  inputSchema: {
    type: "object" as const,
    properties: {
      pattern: { type: "string", description: "Glob pattern to match, e.g. **/*.ts" },
      path: { type: "string", description: "Base directory to search from" },
    },
    required: ["pattern"],
  },
  async call(rawInput: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const input = rawInput as unknown as GlobInput;
    if (!input.pattern) {
      return { content: "Error: pattern is required", isError: true };
    }

    let basePath: string;
    try {
      basePath = resolveWorkspacePath(input.path ?? ".", context.cwd);
    } catch (error: unknown) {
      return {
        content: error instanceof Error ? `Error: ${error.message}` : `Error: ${String(error)}`,
        isError: true,
      };
    }

    try {
      if (await hasCommand("rg")) {
        const { stdout } = await execFileAsync("rg", ["--files", "--hidden", "-g", input.pattern], {
          cwd: basePath,
          maxBuffer: 1024 * 1024,
        });
        const output = stdout.trim();
        return {
          content: output ? `Matched files under ${basePath}:\n${output}` : `No files matched ${input.pattern}`,
        };
      }

      const { stdout } = await execFileAsync("find", [basePath, "-path", `*${input.pattern.replace(/\*\*/g, "*")}`], {
        maxBuffer: 1024 * 1024,
      });
      const output = stdout.trim();
      return {
        content: output ? `Matched files under ${basePath}:\n${output}` : `No files matched ${input.pattern}`,
      };
    } catch (error: unknown) {
      return {
        content: `Error running glob search: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
  isReadOnly(): boolean {
    return true;
  },
  isEnabled(): boolean {
    return true;
  },
};
