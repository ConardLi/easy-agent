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

const ALL_TOOLS: Tool[] = [
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  globTool,
  grepTool,
  bashTool,
];

export function getAllTools(): Tool[] {
  return ALL_TOOLS.filter((tool) => tool.isEnabled());
}

export function findToolByName(name: string): Tool | undefined {
  return ALL_TOOLS.find((tool) => tool.name === name);
}

export function getToolsApiParams(): Anthropic.Tool[] {
  return getAllTools().map(toolToApiParam);
}
