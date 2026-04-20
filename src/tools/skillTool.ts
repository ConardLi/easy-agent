/**
 * SkillTool — the "Skill" tool exposed to the model.
 *
 * Loads a SKILL.md from the registry, performs `$ARGUMENTS` /
 * `${CLAUDE_SKILL_DIR}` / `${CLAUDE_SESSION_ID}` substitution, and returns
 * the resulting prompt as the tool result. The model then reads the result
 * (just like any other tool output) and continues the conversation
 * following the skill's instructions.
 *
 * Side effect: the skill's `allowed-tools` whitelist is appended to the
 * session-allow rules via `context.addSessionAllowRules`, so any tool
 * calls the skill makes during this session don't trigger another permission
 * prompt. Mirrors the source's `contextModifier.alwaysAllowRules` injection.
 *
 * Out of scope for stage 17 (will surface as errors):
 *   - `context: fork`            — needs sub-agent (stage 20+)
 *   - `disable-model-invocation` — model calling a hidden skill is rejected
 *
 * Reference: claude-code-source-code/src/tools/SkillTool/SkillTool.ts
 */

import { findSkill } from "../skills/registry.js";
import type { Skill } from "../skills/types.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";

interface SkillInput {
  skill: string;
  args?: string;
}

const SKILL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function readInput(input: Record<string, unknown>): SkillInput {
  const skill = typeof input["skill"] === "string" ? input["skill"].trim() : "";
  const args = typeof input["args"] === "string" ? input["args"] : "";
  return { skill, args };
}

/**
 * Apply the three substitution variables documented in DEVELOPMENT-PLAN
 * §17.4. Order matters slightly: we substitute `${CLAUDE_SKILL_DIR}` and
 * `${CLAUDE_SESSION_ID}` BEFORE `$ARGUMENTS` so a literal `$ARGUMENTS`
 * inside an environment variable reference would still work — though in
 * practice that case should never appear.
 */
function substituteVariables(
  body: string,
  skill: Skill,
  args: string,
  sessionId: string,
): string {
  // Posix-style separator on all platforms; matches source `posixifyPath`.
  const dir = skill.baseDir.split(/[\\/]/).join("/");
  return body
    .replaceAll("${CLAUDE_SKILL_DIR}", dir)
    .replaceAll("${CLAUDE_SESSION_ID}", sessionId)
    .replaceAll("$ARGUMENTS", args);
}

function buildPromptText(skill: Skill, args: string, sessionId: string): string {
  const dir = skill.baseDir.split(/[\\/]/).join("/");
  const header = `Base directory for this skill: ${dir}\n\n`;
  return header + substituteVariables(skill.body, skill, args, sessionId);
}

export const skillTool: Tool = {
  name: "Skill",
  description:
    "Execute a named skill within the current conversation. Pass the skill's `name` " +
    "(as listed in the system-reminder block of available skills) and optional `args` " +
    "string. The skill's instructions are returned as text — read them and continue " +
    "the conversation following those instructions. Use a skill instead of improvising " +
    "when one matches the user's request.",
  inputSchema: {
    type: "object",
    properties: {
      skill: {
        type: "string",
        description: "Name of the skill to execute (must match a skill from the registry).",
      },
      args: {
        type: "string",
        description: "Optional argument string substituted into the skill's $ARGUMENTS placeholder.",
      },
    },
    required: ["skill"],
    additionalProperties: false,
  },

  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { skill: name, args } = readInput(input);

    if (!name || !SKILL_NAME_RE.test(name)) {
      return {
        content: `Error: invalid skill name. Must match /^[a-zA-Z0-9_-]+$/. Got: ${JSON.stringify(name)}`,
        isError: true,
      };
    }

    const skill = findSkill(name);
    if (!skill) {
      return {
        content: `Error: skill "${name}" not found. Run with --dump-system-prompt to see the available list.`,
        isError: true,
      };
    }

    if (skill.frontmatter.disableModelInvocation) {
      return {
        content: `Error: skill "${name}" has disable-model-invocation: true and can only be invoked by the user via /${name}.`,
        isError: true,
      };
    }

    if (skill.frontmatter.hasForkContext) {
      return {
        content:
          `Error: skill "${name}" declares context: fork, which requires sub-agent execution. ` +
          "This is not implemented in Easy Agent's stage 17. Remove `context: fork` from " +
          "the SKILL.md frontmatter to run it inline, or wait for the AgentTool stage.",
        isError: true,
      };
    }

    // Inject the skill's allowedTools into session-allow rules so subsequent
    // tool calls during this skill don't interrupt the user with permission
    // prompts. We use the same `<ToolName>` rule format as elsewhere.
    if (skill.frontmatter.allowedTools.length > 0 && context.addSessionAllowRules) {
      context.addSessionAllowRules(skill.frontmatter.allowedTools);
    }

    const sessionId = context.sessionId ?? "unknown-session";
    const promptText = buildPromptText(skill, args ?? "", sessionId);

    return {
      content:
        `Loaded skill "${skill.name}" (${skill.source}). ` +
        `Follow the instructions below — they ARE your next steps for this turn.\n\n` +
        promptText,
    };
  },

  isReadOnly(): boolean {
    // A skill can do anything its body asks. Treat as a side-effecting tool
    // so Plan Mode rejects it (matches source's `isReadOnly: false`).
    return false;
  },

  isEnabled(): boolean {
    return true;
  },
};
