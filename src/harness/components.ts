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
import type { PromptSectionName } from "../context/systemPrompt.js";
import { getRegisteredTools } from "../tools/index.js";

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
  source: "built-in";
  enabled: boolean;
  reason?: string;
  description: string;
  /** The Harness key that turns it on or off, when there is one. */
  specKey?: string;
}

const DYNAMIC_SECTIONS: Record<PromptSectionName, string> = {
  output_style: "Instructions of the active output style.",
  language: "The reply language from the language setting.",
  environment: "Working directory, date, operating system, and the git snapshot.",
  agent_md: "AGENTS.md and AGENT.md files.",
  memory: "How to use project memory, and its index.",
  session_instructions: "Extra instructions a caller passes for the session; nothing passes them yet.",
  skills: "The skill listing.",
  agents: "The sub-agent listing.",
  team: "Agent Teams instructions.",
};

/** In prompt order: the static block first, then the dynamic sections. */
export const PROMPT_SECTIONS: readonly { name: string; block: "static" | "dynamic"; description: string }[] = [
  { name: "identity", block: "static", description: "Who the agent is and the file-tool boundary." },
  {
    name: "instructions",
    block: "static",
    description: "Coding instructions; an output style can leave them out.",
  },
  ...Object.entries(DYNAMIC_SECTIONS).map(([name, description]) => ({ name, block: "dynamic" as const, description })),
];

/** Where dynamic context comes from, and the prompt section it fills. */
export const CONTEXT_SOURCES: readonly {
  name: string;
  specKey: string;
  section: PromptSectionName;
  description: string;
}[] = [
  { name: "agent_md", specKey: "context.agentMd", section: "agent_md", description: "AGENTS.md and AGENT.md files." },
  { name: "memory", specKey: "context.memory", section: "memory", description: "The project memory index." },
  {
    name: "environment",
    specKey: "context.environment",
    section: "environment",
    description: "Working directory, date, and operating system.",
  },
  {
    name: "git_status",
    specKey: "context.gitStatus",
    section: "environment",
    description: "Git branch, status, and latest commit when the session starts.",
  },
  { name: "skills", specKey: "context.skills", section: "skills", description: "The skill listing." },
  { name: "agents", specKey: "context.agents", section: "agents", description: "The sub-agent listing." },
];

/** Built-in tools (MCP tools excluded), prompt sections, and context sources. */
export function listBuiltInComponents(): BuiltInComponent[] {
  const tools = getRegisteredTools()
    .filter((tool) => !tool.isMcp)
    .map((tool): BuiltInComponent => {
      const enabled = tool.isEnabled();
      return {
        id: componentId.tool(tool.name),
        kind: "tool",
        name: tool.name,
        source: "built-in",
        enabled,
        ...(enabled ? {} : { reason: "Turned off by its feature setting or not available on this platform." }),
        description:
          tool.description
            .trim()
            .split(/\n\s*\n/)[0]
            ?.replace(/\s+/g, " ") ?? "",
        specKey: "tools.include",
      };
    });
  const sections = PROMPT_SECTIONS.map(
    (section): BuiltInComponent => ({
      id: componentId.promptSection(section.name),
      kind: "prompt_section",
      name: section.name,
      source: "built-in",
      enabled: true,
      description: section.description,
      specKey: section.name === "identity" ? "prompt.identity" : "prompt.sections",
    }),
  );
  const contextSources = CONTEXT_SOURCES.map(
    (source): BuiltInComponent => ({
      id: componentId.contextSource(source.name),
      kind: "context_source",
      name: source.name,
      source: "built-in",
      enabled: true,
      description: source.description,
      specKey: source.specKey,
    }),
  );
  return [...tools, ...sections, ...contextSources];
}
