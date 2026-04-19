/**
 * Tool Registry — Central registry for all available tools.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "./Tool.js";
import { toolToApiParam } from "./Tool.js";
import { bashTool } from "./bashTool.js";
import { fileEditTool } from "./fileEditTool.js";
import { fileReadTool } from "./fileReadTool.js";
import { fileWriteTool } from "./fileWriteTool.js";
import { globTool } from "./globTool.js";
import { grepTool } from "./grepTool.js";
import { memoryWriteTool } from "./memoryWriteTool.js";
import { enterPlanModeTool } from "./enterPlanModeTool.js";
import { exitPlanModeTool } from "./exitPlanModeTool.js";
import { todoWriteTool } from "./todoWriteTool.js";
import { taskCreateTool } from "./taskCreateTool.js";
import { taskUpdateTool } from "./taskUpdateTool.js";
import { taskGetTool } from "./taskGetTool.js";
import { taskListTool } from "./taskListTool.js";
import type { PermissionMode } from "../permissions/permissions.js";

const ALL_TOOLS: Tool[] = [
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  globTool,
  grepTool,
  bashTool,
  memoryWriteTool,
  todoWriteTool,
  taskCreateTool,
  taskUpdateTool,
  taskGetTool,
  taskListTool,
  enterPlanModeTool,
  exitPlanModeTool,
];

export function getAllTools(): Tool[] {
  return ALL_TOOLS.filter((tool) => tool.isEnabled());
}

export function findToolByName(name: string): Tool | undefined {
  return ALL_TOOLS.find((tool) => tool.name === name);
}

/**
 * Get tool API params with mode-aware Enter/Exit visibility.
 *
 * The model always sees all tools (Write, Edit, Bash, etc.) regardless
 * of mode. Enforcement happens in checkPermission at execution time.
 * Only the plan mode transition tools are toggled:
 * - In plan mode: hide EnterPlanMode, show ExitPlanMode
 * - Outside plan mode: show EnterPlanMode, hide ExitPlanMode
 */
export function getToolsApiParams(mode?: PermissionMode): Anthropic.Tool[] {
  const tools = getAllTools();
  if (mode === "plan") {
    return tools.filter((t) => t.name !== "EnterPlanMode").map(toolToApiParam);
  }
  return tools.filter((t) => t.name !== "ExitPlanMode").map(toolToApiParam);
}
