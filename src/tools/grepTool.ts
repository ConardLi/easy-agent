import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { resolveWorkspacePath } from "./pathUtils.js";

const execFileAsync = promisify(execFile);

interface GrepInput {
  pattern: string;
  path?: string;
  include?: string;
}

async function hasCommand(command: string): Promise<boolean> {
  try {
    await execFileAsync("sh", ["-lc", `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}

export const grepTool: Tool = {
  name: "Grep",
  description: "Search file contents by regex pattern. Prefer this over Bash for code search.",
  inputSchema: {
    type: "object" as const,
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for" },
      path: { type: "string", description: "Directory or file path to search within" },
      include: { type: "string", description: "Optional glob filter, e.g. *.ts" },
    },
    required: ["pattern"],
  },
  async call(rawInput: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const input = rawInput as unknown as GrepInput;
    if (!input.pattern) {
      return { content: "Error: pattern is required", isError: true };
    }

    let targetPath: string;
    try {
      targetPath = resolveWorkspacePath(input.path ?? ".", context.cwd);
    } catch (error: unknown) {
      return {
        content: error instanceof Error ? `Error: ${error.message}` : `Error: ${String(error)}`,
        isError: true,
      };
    }

    try {
      if (await hasCommand("rg")) {
        const args = ["-n", "--hidden"];
        if (input.include) {
          args.push("-g", input.include);
        }
        args.push(input.pattern, targetPath);
        const { stdout } = await execFileAsync("rg", args, { maxBuffer: 1024 * 1024 });
        const output = stdout.trim();
        return {
          content: output ? output : `No matches found for pattern: ${input.pattern}`,
        };
      }

      const grepArgs = ["-RIn", input.pattern, targetPath];
      const { stdout } = await execFileAsync("grep", grepArgs, { maxBuffer: 1024 * 1024 });
      const output = stdout.trim();
      return {
        content: output ? output : `No matches found for pattern: ${input.pattern}`,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("code 1")) {
        return { content: `No matches found for pattern: ${input.pattern}` };
      }
      return { content: `Error running grep search: ${message}`, isError: true };
    }
  },
  isReadOnly(): boolean {
    return true;
  },
  isEnabled(): boolean {
    return true;
  },
};
