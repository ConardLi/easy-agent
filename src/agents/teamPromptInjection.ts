/**
 * System-prompt reminder for the active Agent Teams session (stage 21).
 *
 * Reference: claude-code-source-code/src/utils/swarm/teammatePromptAddendum.ts
 *
 * Two-tier visibility:
 *
 *   1. Feature flag OFF                 → empty string (the team tools
 *                                          aren't even registered, so
 *                                          there's nothing for the model
 *                                          to coordinate on).
 *   2. Feature flag ON, no active team  → "you can call TeamCreate"
 *                                          hint, no member list.
 *   3. Feature flag ON, team is active  → full reminder: who's in the
 *                                          team, who's still active,
 *                                          how to send messages, when
 *                                          to disband.
 *
 * The reminder is wrapped in a `<system-reminder>` block (same pattern
 * as the skills + agents reminders) so the model treats it as ambient
 * context — applicable when relevant, ignorable otherwise.
 *
 * Stage 21 keeps this block intentionally short:
 *   - Source's prompt addendum (~150 lines) covers tmux pane mgmt,
 *     plan-mode approval, shutdown protocols, and DM summaries. We
 *     don't ship any of those, so most of that text would be lying.
 *   - The TeamCreate / TeamDelete / SendMessage tool descriptions
 *     already carry the per-action usage notes; the reminder only adds
 *     CROSS-cutting workflow rules.
 */

import { isAgentTeamsEnabled } from "../utils/agentTeamsEnabled.js";
import { getActiveTeam } from "../state/teamContext.js";
import {
  readTeamFile,
  TEAM_LEAD_NAME,
} from "../utils/teamHelpers.js";

/**
 * Render the Agent Teams system-reminder block. Returns `""` when the
 * feature flag is off, so the dynamic-sections filter drops it.
 */
export function formatTeamSystemReminder(): string {
  if (!isAgentTeamsEnabled()) return "";

  const active = getActiveTeam();
  if (!active) {
    // Flag on but no team yet — give the model just enough nudge to
    // know the tool exists, but no detailed workflow yet (it doesn't
    // apply until a team is created).
    return [
      "<system-reminder>",
      "Agent Teams is enabled. You can call `TeamCreate({ team_name: \"...\" })` to start a team-coordinated session for tasks that split naturally into long-running parallel roles (e.g. backend + frontend + reviewer).",
      "For a single short subtask, prefer plain `Agent(...)` — no team needed.",
      "</system-reminder>",
    ].join("\n");
  }

  // Active team — read the latest member snapshot. Sync read is fine
  // here: the system prompt is rebuilt on every turn, and the team file
  // is small (one JSON, a handful of members).
  const file = readTeamFile(active.teamName);
  const members = file?.members ?? [];
  const teammates = members.filter((m) => m.name !== TEAM_LEAD_NAME);
  const activeTeammates = teammates.filter((m) => m.isActive);
  const idleTeammates = teammates.filter((m) => !m.isActive);

  const memberLines: string[] = [];
  if (teammates.length === 0) {
    memberLines.push(
      "- (No teammates yet — spawn one with `Agent({ name: \"<short-name>\", team_name: \"" +
        active.teamName +
        "\", run_in_background: true, prompt: \"...\", description: \"...\" })`.)",
    );
  } else {
    for (const t of activeTeammates) {
      memberLines.push(
        `- ${t.name} [active] — agent_type=${t.agentType ?? "general-purpose"}`,
      );
    }
    for (const t of idleTeammates) {
      memberLines.push(
        `- ${t.name} [idle] — finished its task; SendMessage will queue but won't wake them up until they're respawned`,
      );
    }
  }

  return [
    "<system-reminder>",
    `Agent Teams: you are the LEAD of team "${active.teamName}" (lead_agent_id: ${active.leadAgentId}).`,
    "",
    "Team members:",
    ...memberLines,
    "",
    "Workflow rules:",
    "- Spawn teammates with `Agent({ name, team_name, run_in_background: true, ... })`. They run in the background and the lead's loop keeps going — same anti-polling discipline as a regular background sub-agent (no sleep, no Read on the output_file, wait for the `<task-notification>`).",
    "- Coordinate with `SendMessage({ to: \"<name>\", summary, message })`. Use `to: \"*\"` to broadcast to every active teammate (not yourself).",
    "- A teammate sees mailbox messages at the start of their next spawn; SendMessage to an already-finished (`[idle]`) teammate sits in their inbox until you respawn them with another `Agent({ name: \"<same-name>\", ... })` call.",
    "- Run `TeamDelete()` when the team's mission is done. It refuses while any teammate is still `[active]` — wait for the relevant `<task-notification>` first.",
    "- Only ONE team can be active at a time; you cannot nest teams or spawn sub-teams from inside a teammate.",
    "</system-reminder>",
  ].join("\n");
}
