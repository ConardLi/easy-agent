/**
 * Component ids: one naming scheme for every part of a Harness.
 *
 * The formats are the ones `runtime/inventory` already returns (skills,
 * commands, sub-agents, output styles, MCP servers, plugins, hooks, rule
 * files, tools); this module adds built-in prompt sections and context
 * sources. Ids are stable: they depend only on names, sources, and paths, so
 * they stay the same across restarts of the same workspace.
 */

import type { SettingSource } from "../config/sources.js";
import { getRegisteredTools } from "../tools/index.js";
import type { Tool } from "../tools/Tool.js";
import { activeHarness } from "./active.js";
import {
  addedPromptSections,
  CONTEXT_SOURCES,
  contextSourceOffReason,
  DYNAMIC_SECTIONS,
  promptSectionOffReason,
  promptSectionReplacement,
} from "./prompt.js";
import type { ResolvedHarness } from "./resolve.js";
import { selectionOffReason } from "./selection.js";

export { CONTEXT_SOURCES };

/** Where a component comes from: built in, a settings layer (`flag` is the command line), a plugin, or an SDK caller. */
export type HarnessComponentSource = "built-in" | SettingSource | "plugin" | "sdk";

export const componentId = {
  tool: (name: string) => `tool:${name}`,
  promptSection: (name: string) => `prompt_section:${name}`,
  contextSource: (name: string) => `context_source:${name}`,
  skill: (source: string, name: string) => `skill:${source}:${name}`,
  command: (source: string, name: string) => `command:${source}:${name}`,
  agent: (source: string, name: string) => `agent:${source}:${name}`,
  outputStyle: (source: string, name: string) => `output_style:${source}:${name}`,
  mcpServer: (name: string) => `mcp_server:${name}`,
  plugin: (pluginId: string) => `plugin:${pluginId}`,
  /** Hooks have no names; the inventory appends an index per prefix. */
  hookPrefix: (source: string, event: string) => `hook:${source}:${event}`,
  pluginHookPrefix: (pluginId: string, event: string) => `hook:plugin:${pluginId}:${event}`,
  rule: (filePath: string) => `rule:${filePath}`,
  memoryRule: () => "rule:memory",
} as const;

export type BuiltInComponentKind = "tool" | "prompt_section" | "context_source";

export interface BuiltInComponent {
  id: string;
  kind: BuiltInComponentKind;
  name: string;
  /** `harness` for a prompt section the Agent adds. */
  source: "built-in" | "harness";
  enabled: boolean;
  reason?: string;
  description: string;
  /** Where the text comes from when the Agent replaces a prompt section's built-in text, or adds the section. */
  replacedBy?: string;
  /** The Harness key that turns it on or off, when there is one. */
  specKey?: string;
}

/** Built-in prompt sections in built-in order: the static block first, then the dynamic sections. */
export const PROMPT_SECTIONS: readonly { name: string; block: "static" | "dynamic"; description: string }[] = [
  { name: "identity", block: "static", description: "Who the agent is and the file-tool boundary." },
  {
    name: "instructions",
    block: "static",
    description: "Coding instructions; an output style can leave them out.",
  },
  ...Object.entries(DYNAMIC_SECTIONS).map(([name, description]) => ({ name, block: "dynamic" as const, description })),
];

/** Why a registered tool is off for `resolved`, or undefined when the session can use it. */
export function toolOffReason(tool: Tool, resolved: ResolvedHarness): string | undefined {
  return (
    selectionOffReason(resolved, "tools", tool.name) ??
    (tool.isEnabled() ? undefined : "Turned off by its feature setting or not available on this platform.")
  );
}

/**
 * Built-in tools (MCP tools excluded), prompt sections (with the ones the
 * Agent adds), and context sources, each on or off for `resolved`. A prompt
 * section that is on can still be empty when it has nothing to show, such as
 * the team section without a team.
 */
export function listBuiltInComponents(resolved: ResolvedHarness = activeHarness()): BuiltInComponent[] {
  const tools = getRegisteredTools()
    .filter((tool) => !tool.isMcp)
    .map((tool): BuiltInComponent => {
      const reason = toolOffReason(tool, resolved);
      return {
        id: componentId.tool(tool.name),
        kind: "tool",
        name: tool.name,
        source: "built-in",
        enabled: !reason,
        ...(reason ? { reason } : {}),
        description:
          tool.description
            .trim()
            .split(/\n\s*\n/)[0]
            ?.replace(/\s+/g, " ") ?? "",
        specKey: "tools.include",
      };
    });
  const sections = PROMPT_SECTIONS.map((section): BuiltInComponent => {
    const reason = section.name === "instructions" ? undefined : promptSectionOffReason(resolved, section.name);
    const replacedBy = reason ? undefined : promptSectionReplacement(resolved, section.name);
    return {
      id: componentId.promptSection(section.name),
      kind: "prompt_section",
      name: section.name,
      source: "built-in",
      enabled: !reason,
      ...(reason ? { reason } : {}),
      description: section.description,
      ...(replacedBy ? { replacedBy } : {}),
      ...(section.name === "instructions"
        ? {}
        : { specKey: section.name === "identity" ? "prompt.identity" : "prompt.sections" }),
    };
  });
  const added = addedPromptSections(resolved).map(
    (section): BuiltInComponent => ({
      id: componentId.promptSection(section.name),
      kind: "prompt_section",
      name: section.name,
      source: "harness",
      enabled: true,
      description: `Added by the Agent (${section.text.length} chars).`,
      replacedBy: promptSectionReplacement(resolved, section.name)!,
      specKey: "prompt.sections",
    }),
  );
  const contextSources = CONTEXT_SOURCES.map((source): BuiltInComponent => {
    const reason = contextSourceOffReason(resolved, source.name);
    return {
      id: componentId.contextSource(source.name),
      kind: "context_source",
      name: source.name,
      source: "built-in",
      enabled: !reason,
      ...(reason ? { reason } : {}),
      description: source.description,
      specKey: source.specKey,
    };
  });
  return [...tools, ...sections, ...added, ...contextSources];
}
