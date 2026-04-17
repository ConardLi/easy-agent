/**
 * Step 13 - Plan Mode
 *
 * Goal:
 * - let the agent switch into a "look first, act later" mode
 * - allow only read-only exploration while planning
 * - store the plan in a markdown file on disk
 * - exit planning with an approved execution plan
 *
 * This file is a teaching version that condenses the core mechanics.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const EASY_AGENT_HOME = path.join(os.homedir(), ".easy-agent");
const PLANS_DIR = path.join(EASY_AGENT_HOME, "plans");
const PLAN_ALLOWED_TOOLS = new Set(["Read", "Grep", "Glob"]);

let cachedPlanSlug = null;

function generatePlanSlug() {
  return crypto.randomBytes(4).toString("hex");
}

export function getPlanSlug() {
  if (!cachedPlanSlug) {
    cachedPlanSlug = generatePlanSlug();
  }
  return cachedPlanSlug;
}

export function getPlanFilePath() {
  return path.join(PLANS_DIR, getPlanSlug() + ".md");
}

export async function ensurePlansDirectory() {
  await fs.mkdir(PLANS_DIR, { recursive: true });
}

export async function writePlan(content) {
  await ensurePlansDirectory();
  const planPath = getPlanFilePath();
  await fs.writeFile(planPath, content, "utf8");
  return planPath;
}

export async function readPlan() {
  try {
    return await fs.readFile(getPlanFilePath(), "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

function buildAllowRulesFromPrompts(prompts) {
  return prompts
    .filter((item) => item.tool && item.prompt)
    .map((item) => {
      if (item.tool === "Bash") {
        return "Bash(" + item.prompt + " *)";
      }
      return item.tool;
    });
}

export const enterPlanModeTool = {
  name: "EnterPlanMode",
  description: "Enter plan mode to explore with read-only tools before making changes.",
  inputSchema: {
    type: "object",
    properties: {
      reason: { type: "string" },
    },
    required: ["reason"],
  },
  isReadOnly() {
    return false;
  },
  isEnabled() {
    return true;
  },
  async call(input, context) {
    if (context.getPermissionMode?.() === "plan") {
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
        "1. EXPLORE: Use Read, Grep, Glob, and read-only Bash commands.",
        "2. PLAN: Write the implementation plan to the plan file.",
        "3. EXIT: Call ExitPlanMode when the plan is ready.",
        "",
        "Rules:",
        "- Do not edit source files yet.",
        "- Do not run destructive shell commands.",
        "- Only the plan file may be written in plan mode.",
        "",
        "Plan file: " + planPath,
      ].join("\n"),
    };
  },
};

export const exitPlanModeTool = {
  name: "ExitPlanMode",
  description: "Exit plan mode and resume normal execution.",
  inputSchema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      allowedPrompts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tool: { type: "string" },
            prompt: { type: "string" },
          },
          required: ["tool", "prompt"],
        },
      },
      plan: { type: "string" },
    },
    required: ["summary"],
  },
  isReadOnly() {
    return false;
  },
  isEnabled() {
    return true;
  },
  async call(input, context) {
    if (context.getPermissionMode?.() !== "plan") {
      return { content: "Not currently in plan mode.", isError: true };
    }

    const planPath = getPlanFilePath();
    const allowedPrompts = Array.isArray(input.allowedPrompts) ? input.allowedPrompts : [];

    if (typeof input.plan === "string") {
      await ensurePlansDirectory();
      await fs.writeFile(planPath, input.plan, "utf8");
    }

    if (allowedPrompts.length > 0) {
      const allowRules = buildAllowRulesFromPrompts(allowedPrompts);
      context.addSessionAllowRules?.(allowRules);
    }

    context.setPermissionMode?.("default");

    const planContent = await readPlan();
    return {
      content: [
        "Plan approved by user. Full tool access restored.",
        "",
        "IMPORTANT: Start implementing immediately.",
        "Do not summarize the plan again.",
        "",
        "Plan file: " + planPath,
        "",
        planContent || "(No plan content found)",
      ].join("\n"),
    };
  },
};

export function isReadOnlyCommand(command) {
  const normalized = String(command || "").trim().replace(/\s+/g, " ");
  const prefixes = ["pwd", "ls", "cat", "find", "rg", "grep", "git status", "git diff", "git log"];
  return prefixes.some((prefix) => normalized === prefix || normalized.startsWith(prefix + " "));
}

export function checkPermissionInPlanMode({ toolName, input }) {
  if (PLAN_ALLOWED_TOOLS.has(toolName)) {
    return { behavior: "allow", reason: "read-only tool allowed in plan mode" };
  }

  if (toolName === "EnterPlanMode" || toolName === "ExitPlanMode") {
    return { behavior: "ask", reason: "plan mode transition requires confirmation" };
  }

  if (toolName === "Bash") {
    if (isReadOnlyCommand(input.command)) {
      return { behavior: "allow", reason: "read-only shell command allowed" };
    }
    return { behavior: "deny", reason: "plan mode blocks non-read-only Bash commands" };
  }

  if (toolName === "Write") {
    const requestedPath = typeof input.file_path === "string" ? path.resolve(input.file_path) : "";
    if (requestedPath === path.resolve(getPlanFilePath())) {
      return { behavior: "allow", reason: "writing to the plan file is allowed" };
    }
  }

  return { behavior: "deny", reason: "plan mode blocks " + toolName };
}

export function getToolsApiParams(mode, allTools) {
  if (mode === "plan") {
    return allTools.filter((tool) => tool.name !== "EnterPlanMode");
  }
  return allTools.filter((tool) => tool.name !== "ExitPlanMode");
}

export function getPlanModeAttachment(planFilePath) {
  return {
    role: "user",
    content: [
      "[plan_mode_attachment]",
      "PLAN MODE ACTIVE — Only read-only tools are available.",
      "Write your plan to: " + planFilePath,
      "Call ExitPlanMode when your plan is ready.",
    ].join("\n"),
  };
}
