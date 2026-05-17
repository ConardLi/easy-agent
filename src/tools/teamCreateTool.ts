/**
 * TeamCreate — kick off an Agent Teams session.
 *
 * Reference: claude-code-source-code/src/tools/TeamCreateTool/TeamCreateTool.ts
 *
 * Mental model: TeamCreate is the moment the main session morphs from
 * "one agent talking to the user" into "team lead coordinating
 * teammates". After this call:
 *
 *   - `~/.easy-agent/teams/<sanitized>/team.json` exists with the lead
 *     as the sole member.
 *   - The in-process `teamContext` singleton is populated; promptInjection
 *     starts including team-coordination guidance in the system prompt.
 *   - SendMessage / TeamDelete become operative.
 *   - The model can now call `Agent({ name, team_name, ... })` to
 *     spawn named teammates that the lead can SendMessage to.
 *
 * Trimmed vs source:
 *   - No `getResolvedTeammateMode()` / tmux backend setup — Easy Agent
 *     only does in-process teammates (background sub-agents).
 *   - No analytics event.
 *   - No `parseUserSpecifiedModel` resolution; we record the lead's
 *     current model name as-is.
 *   - No shared-tasks-dir reset (source's `Team = Project = TaskList`
 *     coupling). Stage 15's task store is per-session already; we keep
 *     the same `getTaskListId(sessionId)` semantics inside teammates.
 *
 * Gating: this tool's `isEnabled()` returns false unless
 * `isAgentTeamsEnabled()` (the feature flag) is true. When teams are
 * off, the model never sees the schema and never calls it.
 */

import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { isAgentTeamsEnabled } from "../utils/agentTeamsEnabled.js";
import {
  formatAgentId,
  getTeamFilePath,
  readTeamFile,
  sanitizeName,
  TEAM_LEAD_NAME,
  writeTeamFileAsync,
  type TeamFile,
} from "../utils/teamHelpers.js";
import {
  getActiveTeam,
  setActiveTeam,
} from "../state/teamContext.js";

interface TeamCreateInput {
  team_name: string;
  description?: string;
}

function readInput(raw: Record<string, unknown>): TeamCreateInput {
  const team_name =
    typeof raw["team_name"] === "string" ? raw["team_name"].trim() : "";
  const description =
    typeof raw["description"] === "string"
      ? raw["description"].trim()
      : undefined;
  return {
    team_name,
    ...(description ? { description } : {}),
  };
}

export const teamCreateTool: Tool = {
  name: "TeamCreate",
  description:
    "Spin up a new Agent Teams session. The current Easy Agent process becomes the team lead. " +
    "After this call you can spawn named teammates via `Agent({ name: \"<name>\", team_name: \"<team>\", run_in_background: true, ... })` and message them with `SendMessage`. " +
    "Only ONE team can be active per session; call `TeamDelete` first if you want to start over. " +
    "Use this when the user's task naturally splits into long-running parallel roles (e.g. backend + frontend + reviewer). For a single short subtask, prefer plain `Agent(...)` without a team.",
  inputSchema: {
    type: "object",
    properties: {
      team_name: {
        type: "string",
        description:
          "Short human-readable team name (e.g. \"refactor-auth\"). Used as the directory segment under ~/.easy-agent/teams/, so it's auto-sanitized to lowercase alphanumeric + hyphen.",
      },
      description: {
        type: "string",
        description:
          "Optional 1-2 sentence summary of what the team is for. Stored in team.json for future reference; not injected into the model's context.",
      },
    },
    required: ["team_name"],
    additionalProperties: false,
  },

  async call(
    input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolResult> {
    const { team_name, description } = readInput(input);
    if (!team_name) {
      return {
        content:
          "Error: 'team_name' is required and must be a non-empty string.",
        isError: true,
      };
    }

    // Source-aligned single-team-per-process gate.
    // The in-process check is fast; the on-disk check catches the case
    // where a previous run crashed without TeamDelete'ing — the user
    // would otherwise be silently re-using a stale team file with
    // unread inbox messages from another lifetime.
    const active = getActiveTeam();
    if (active) {
      return {
        content:
          `Error: this session is already leading team "${active.teamName}". ` +
          `Call TeamDelete first to disband it, or pick a different conversation to start a new team.`,
        isError: true,
      };
    }

    const sanitized = sanitizeName(team_name);
    if (!sanitized) {
      return {
        content: `Error: 'team_name' sanitizes to an empty string. Use letters / digits / hyphens.`,
        isError: true,
      };
    }

    // Refuse if a same-named team already exists on disk — surfaces the
    // crashed-previous-session case to the user explicitly rather than
    // silently re-leading someone else's leftover team.
    const existing = readTeamFile(team_name);
    if (existing) {
      return {
        content:
          `Error: team "${team_name}" already exists on disk (${getTeamFilePath(team_name)}). ` +
          `Pick a different name, or run TeamDelete to remove the previous one first.`,
        isError: true,
      };
    }

    const leadAgentId = formatAgentId(TEAM_LEAD_NAME, team_name);
    const createdAt = Date.now();
    const teamFile: TeamFile = {
      name: team_name,
      ...(description ? { description } : {}),
      createdAt,
      leadAgentId,
      members: [
        {
          agentId: leadAgentId,
          name: TEAM_LEAD_NAME,
          agentType: "team-lead",
          joinedAt: createdAt,
          isActive: true,
        },
      ],
    };

    const teamFilePath = getTeamFilePath(team_name);
    await writeTeamFileAsync(team_name, teamFile);
    setActiveTeam({
      teamName: team_name,
      leadAgentId,
      teamFilePath,
      createdAt,
    });

    const lines = [
      `Team "${team_name}" created. You are the lead (${leadAgentId}).`,
      description ? `description: ${description}` : "",
      `team_file: ${teamFilePath}`,
      "",
      "Next steps you can take:",
      `  1. Spawn a named teammate:`,
      `       Agent({ subagent_type: "<agent-type>", name: "<short-name>", team_name: "${team_name}", run_in_background: true, prompt: "...", description: "..." })`,
      `  2. Message a running teammate:`,
      `       SendMessage({ to: "<short-name>", summary: "...", message: "..." })`,
      `  3. When the team's work is done:`,
      `       TeamDelete()`,
      "",
      `Reminder: only ONE team can be active at a time. Teammates cannot themselves call TeamCreate / TeamDelete or spawn sub-teams.`,
    ]
      .filter(Boolean)
      .join("\n");

    return {
      content: lines,
    };
  },

  isReadOnly(): boolean {
    // Creates on-disk state and mutates the in-process teamContext.
    return false;
  },

  isEnabled(): boolean {
    return isAgentTeamsEnabled();
  },

  isConcurrencySafe(): boolean {
    // Single-team-per-process invariant prohibits parallel TeamCreate
    // calls in the same turn.
    return false;
  },
};
