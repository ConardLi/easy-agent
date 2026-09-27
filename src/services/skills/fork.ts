import type { Skill } from "../../types/types.js";
import type { ToolContext, ToolResult } from "../../tools/Tool.js";
import type { PermissionDecision, PermissionMode, PermissionRequest, PermissionRuleSet, PermissionSettings } from "../../permissions/permissions.js";
import { findAgent } from "../../agents/registry.js";

/** Execute a skill in a fresh agent context without widening the parent's tool pool or rules. */
export async function executeForkSkill(skill: Skill, prompt: string, context: ToolContext): Promise<ToolResult> {
  if (context.taskScope === "session" && !context.availableTools?.some((tool) => tool.name === "Agent")) {
    return { content: "Nested fork skills are not allowed in this agent context.", isError: true };
  }
  const agentName = typeof skill.frontmatter.raw.agent === "string" ? skill.frontmatter.raw.agent : "general-purpose";
  const definition = findAgent(agentName);
  if (!definition) return { content: `Unknown skill agent: ${agentName}`, isError: true };
  const { runChildAgent } = await import("../../agents/runAgent.js");
  const { getAllTools } = await import("../../tools/index.js");
  const available = [...(context.availableTools ?? getAllTools())];
  const allowed = skill.frontmatter.allowedTools;
  const pool = allowed.length ? available.filter((tool) => allowed.some((rule) => rule === tool.name || rule.startsWith(`${tool.name}(`) || rule === "*")) : available;
  const parentRules = context.sessionPermissionRules as PermissionRuleSet | undefined;
  const rules: PermissionRuleSet = { allow: [...(parentRules?.allow ?? []), ...allowed], deny: [...(parentRules?.deny ?? [])] };
  const model = typeof skill.frontmatter.raw.model === "string" ? skill.frontmatter.raw.model : definition.model ?? context.defaultModel;
  if (!model) return { content: "No model configured for fork skill.", isError: true };
  const result = await runChildAgent({
    agentDefinition: { ...definition, permissionMode: context.getPermissionMode?.() as PermissionMode | undefined },
    prompt, availableTools: pool, model, parentToolContext: context,
    abortSignal: context.abortSignal,
    permissionMode: context.getPermissionMode?.() as PermissionMode | undefined,
    permissionSettings: context.permissionSettings as PermissionSettings | undefined,
    sessionPermissionRules: rules,
    onPermissionRequest: context.onPermissionRequest as ((request: PermissionRequest) => Promise<PermissionDecision>) | undefined,
  });
  return { content: result.finalText, ...(result.reason !== "completed" ? { isError: true } : {}) };
}
