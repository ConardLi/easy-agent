/**
 * EnterPlanModeTool — switches the session into plan mode.
 *
 * When the model decides a complex task needs planning before execution,
 * it calls this tool. The permission check returns "ask" so the user
 * must approve. On approval the session switches to plan mode where
 * only read-only tools are available.
 */

import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import type Anthropic from "@anthropic-ai/sdk";
import { getPlanFilePath, ensurePlansDirectory } from "../context/plans.js";

export const enterPlanModeTool: Tool = {
  name: "EnterPlanMode",

  description:
    "Enter plan mode to explore the codebase with read-only tools before making changes. " +
    "Use this when you need to understand the code structure and form a plan before executing modifications. " +
    "In plan mode, only Read, Grep, Glob, and read-only Bash commands are available. " +
    "Write your plan to the designated plan file, then call ExitPlanMode to resume normal execution.",

  inputSchema: {
    type: "object" as const,
    properties: {
      reason: {
        type: "string",
        description: "Brief explanation of why plan mode is needed.",
      },
    },
    required: ["reason"],
  },

  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const currentMode = context.getPermissionMode?.();
    if (currentMode === "plan") {
      return { content: "Already in plan mode.", isError: true };
    }

    await ensurePlansDirectory();
    const planPath = getPlanFilePath();

    context.setPermissionMode?.("plan");

    return {
      content: [
        "PLAN MODE ACTIVE — You are now in plan mode.",
        "",
        "Workflow:",
        "1. EXPLORE: Use Read, Grep, Glob, and read-only Bash commands (ls, cat, git status, etc.) to understand the codebase.",
        "2. PLAN: Write a detailed implementation plan to the plan file using the structure below.",
        "3. EXIT: Call ExitPlanMode with a summary and any allowedPrompts for auto-approved commands.",
        "",
        "Plan file structure (write to the plan file using this format):",
        "",
        "## Context",
        "Begin with a Context section: what is the problem, what does the user need, what is the expected outcome.",
        "",
        "## Recommended approach",
        "Describe your recommended approach concisely but with enough detail to be executable.",
        "",
        "## Critical files",
        "List the paths of critical files that will be created or modified.",
        "",
        "## Reuse",
        "Identify existing functions, utilities, or patterns in the codebase that should be reused, with paths.",
        "",
        "## Verification",
        "Describe how to test and verify the implementation end-to-end.",
        "",
        "Rules:",
        "- Do NOT use Edit or destructive Bash commands.",
        "- Do NOT use Write on any file except the plan file below.",
        "- Do NOT ask the user for approval via text — use ExitPlanMode when ready.",
        "- You MUST end your turn by either continuing exploration or calling ExitPlanMode.",
        "",
        `Plan file: ${planPath}`,
      ].join("\n"),
    };
  },

  isReadOnly() {
    return false;
  },

  isEnabled() {
    return true;
  },
};
