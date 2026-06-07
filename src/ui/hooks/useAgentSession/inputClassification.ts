/**
 * Slash-command vs. chat-input classification, extracted from useAgentSession's
 * `submit` (二期 C2). Pure: given the trimmed input (and the live registries it
 * consults), it decides whether the input should engage the full agentic loop
 * or be handled as a synchronous system command. Behavior is unchanged.
 *
 * Slash commands fall into two UX categories:
 *   1. System commands (/help, /cost, /model, /skills, /mcp, …) — synchronous,
 *      never call the LLM, just print a notice.
 *   2. LLM-triggering commands — skill commands (/<skill-name>), user-defined
 *      commands (~/.easy-agent/commands), and built-in prompt commands (/init)
 *      expand into a real prompt and run a normal model turn.
 */

import { findSkill } from "../../../services/skills/registry.js";
import { findUserCommand } from "../../../commands/userCommands/registry.js";
import {
  isBuiltinCommandName,
  isBuiltinPromptCommand,
} from "../../../commands/builtinCommandNames.js";

export interface InputClassification {
  isSlashCommand: boolean;
  /** First whitespace-delimited token after the leading "/", "" if not a slash command. */
  rawCommandName: string;
  isSkillCommand: boolean;
  isUserCommand: boolean;
  isPromptCommand: boolean;
  /** True when the input should engage the full agentic loop (spinner/stream). */
  isLlmTriggering: boolean;
}

export function classifyUserInput(trimmed: string): InputClassification {
  const isSlashCommand = trimmed.startsWith("/");
  const rawCommandName = isSlashCommand
    ? trimmed.slice(1).split(/\s+/, 1)[0] ?? ""
    : "";
  const skillCommandName = rawCommandName.toLowerCase();
  const isSkillCommand =
    isSlashCommand && !!skillCommandName && !!findSkill(skillCommandName);
  // User-defined commands also engage the full agentic loop (they expand into a
  // real prompt). Skip reserved built-in names so `/help` etc. stay synchronous
  // notices, mirroring the engine's guard.
  const isUserCommand =
    isSlashCommand &&
    !!rawCommandName &&
    !isBuiltinCommandName(rawCommandName) &&
    !!findUserCommand(rawCommandName);
  // Built-in `prompt` commands (`/init`) expand into a real prompt and run a
  // normal model turn, so they too are LLM-triggering.
  const isPromptCommand =
    isSlashCommand && isBuiltinPromptCommand(rawCommandName);
  const isLlmTriggering =
    !isSlashCommand || isSkillCommand || isUserCommand || isPromptCommand;

  return {
    isSlashCommand,
    rawCommandName,
    isSkillCommand,
    isUserCommand,
    isPromptCommand,
    isLlmTriggering,
  };
}
