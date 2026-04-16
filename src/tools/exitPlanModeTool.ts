/**
 * ExitPlanModeTool — exits plan mode and optionally declares allowedPrompts.
 *
 * After the model finishes exploring and writing a plan, it calls this
 * tool to restore normal permissions. The `allowedPrompts` parameter
 * lets the model pre-declare Bash commands that should be auto-approved
 * during the execution phase (e.g. "run tests", "install dependencies").
 *
 * If the user edits the plan (passes `plan` in input), the edited content
 * is written to disk and the tool result is labeled "edited by user".
 */

import * as fs from "node:fs/promises";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { readPlan, getPlanFilePath, ensurePlansDirectory } from "../context/plans.js";

interface AllowedPrompt {
  tool: string;
  prompt: string;
}

function buildAllowRulesFromPrompts(prompts: AllowedPrompt[]): string[] {
  return prompts
    .filter((p) => p.tool && p.prompt)
    .map((p) => {
      if (p.tool === "Bash") {
        return `Bash(${p.prompt} *)`;
      }
      return p.tool;
    });
}

export const exitPlanModeTool: Tool = {
  name: "ExitPlanMode",

  description:
    "Exit plan mode and return to normal execution mode. " +
    "Call this after you have finished exploring the codebase and written your plan. " +
    "You can optionally declare allowedPrompts — Bash command patterns that should be " +
    "auto-approved during execution (e.g. running tests, installing dependencies).",

  inputSchema: {
    type: "object" as const,
    properties: {
      summary: {
        type: "string",
        description: "Brief summary of the plan that was created.",
      },
      allowedPrompts: {
        type: "array",
        description: "Optional list of tool commands to auto-approve after exiting plan mode.",
        items: {
          type: "object",
          properties: {
            tool: { type: "string", description: "Tool name (e.g. 'Bash')." },
            prompt: { type: "string", description: "Command pattern (e.g. 'npm test')." },
          },
          required: ["tool", "prompt"],
        },
      },
      plan: {
        type: "string",
        description: "User-edited plan content. Only provided when the user edits the plan before approval.",
      },
    },
    required: ["summary"],
  },

  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const currentMode = context.getPermissionMode?.();
    if (currentMode !== "plan") {
      return { content: "Not currently in plan mode. ExitPlanMode can only be called while in plan mode.", isError: true };
    }

    const planPath = getPlanFilePath();
    const summary = (input.summary as string) || "No summary provided.";
    const allowedPrompts = (input.allowedPrompts as AllowedPrompt[]) ?? [];
    const inputPlan = typeof input.plan === "string" ? input.plan : undefined;

    // If user edited the plan, write it to disk
    let planWasEdited = false;
    if (inputPlan !== undefined) {
      await ensurePlansDirectory();
      await fs.writeFile(planPath, inputPlan, "utf-8");
      planWasEdited = true;
    }

    const planContent = await readPlan();

    // Convert allowedPrompts to session-level allow rules
    if (allowedPrompts.length > 0) {
      const rules = buildAllowRulesFromPrompts(allowedPrompts);
      context.addSessionAllowRules?.(rules);
    }

    // Restore to pre-plan mode
    context.setPermissionMode?.("default");

    // Build structured tool result
    const lines = [
      "Plan approved by user. Full tool access restored.",
      "",
      "IMPORTANT: Immediately begin implementing the plan below.",
      "Do NOT summarize the plan or ask for confirmation — start writing code NOW.",
      "",
      `Plan file: ${planPath}`,
      "",
    ];

    if (planContent) {
      const header = planWasEdited
        ? "## Approved Plan (edited by user)"
        : "## Approved Plan";
      lines.push(header, "", planContent);
    } else {
      lines.push("(No plan content found on disk)");
    }

    if (allowedPrompts.length > 0) {
      lines.push(
        "",
        "Auto-approved commands for this session:",
        ...allowedPrompts.map((p) => `- ${p.tool}: ${p.prompt}`),
      );
    }

    return { content: lines.join("\n") };
  },

  isReadOnly() {
    return false;
  },

  isEnabled() {
    return true;
  },
};
