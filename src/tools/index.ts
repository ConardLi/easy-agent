/**
 * Tool Registry — Central registry for all available tools.
 *
 * Stage 16: MCP tools are registered at startup via `registerMcpTools()`.
 * Built-in tools live in BUILTIN_TOOLS (compile-time list); MCP tools are
 * collected separately so they can be reset/refreshed independently when
 * the user runs `/mcp reconnect`.
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

const BUILTIN_TOOLS: Tool[] = [
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

let mcpTools: Tool[] = [];

/**
 * Replace the registry of MCP-provided tools. Called once at startup after
 * connecting to all MCP servers, and again after `/mcp reconnect`.
 */
export function registerMcpTools(tools: Tool[]): void {
  mcpTools = [...tools];
}

/** Drop the MCP-provided tools — used before re-registering after reconnect. */
export function clearMcpTools(): void {
  mcpTools = [];
}

export function getAllTools(): Tool[] {
  return [...BUILTIN_TOOLS, ...mcpTools].filter((tool) => tool.isEnabled());
}

export function findToolByName(name: string): Tool | undefined {
  return [...BUILTIN_TOOLS, ...mcpTools].find((tool) => tool.name === name);
}

/**
 * Get tool API params with mode-aware Enter/Exit visibility.
 *
 * The model always sees all tools (Write, Edit, Bash, etc.) regardless
 * of mode. Enforcement happens in checkPermission at execution time.
 * Only the plan mode transition tools are toggled:
 * - In plan mode: hide EnterPlanMode, show ExitPlanMode
 * - Outside plan mode: show EnterPlanMode, hide ExitPlanMode
 *
 * MCP tools are always included; their visibility-in-plan is handled by
 * `checkPermission()` reading `tool.isReadOnly()` (which maps to MCP's
 * `annotations.readOnlyHint`).
 */
export function getToolsApiParams(mode?: PermissionMode): Anthropic.Tool[] {
  const tools = getAllTools();
  if (mode === "plan") {
    return tools.filter((t) => t.name !== "EnterPlanMode").map(toolToApiParam);
  }
  return tools.filter((t) => t.name !== "ExitPlanMode").map(toolToApiParam);
}
