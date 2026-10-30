/**
 * Feature flag for Agent Teams.
 *
 * Pattern:
 *   - One central gate function (`isAgentTeamsEnabled`).
 *   - Two opt-in signals: a CLI flag and an environment variable.
 *   - Defaults to OFF — teams must be explicitly enabled.
 *
 * Why a feature flag at all:
 *
 *   1. The team toolchain (TeamCreate / TeamDelete / SendMessage) adds
 *      three new schema-visible tools the model can call. When teams are
 *      off the model shouldn't even see them — clutters the tool list,
 *      tempts mis-routing of regular sub-agent work into a "team", and
 *      lights up unrelated `<system-reminder>` guidance.
 *   2. Teams persist state on disk (~/.easy-agent/teams/...). For a user
 *      who never opted in we should never create that directory tree.
 *   3. Keeping the gate in one function means new opt-in signals can be
 *      added without touching every call site that asks "is this
 *      feature on?".
 *
 * The gate is the Agent's `features.agentTeams`. Either signal turns it on:
 *
 *   --agent-teams (CLI flag)
 *   EASY_AGENT_TEAMS=1 (env var; accepts 1/true/yes/on, anything else off)
 *
 * An Agent spec can turn it on as well. There is no remote killswitch: Easy
 * Agent has no analytics or feature-flag service.
 */

import { harnessSetting } from "../harness/active.js";

/**
 * True when the Agent has Agent Teams on. Read on every Tool.isEnabled()
 * call; the flag and the variable are taken when the runtime starts.
 */
export function isAgentTeamsEnabled(): boolean {
  return harnessSetting<boolean>("features.agentTeams");
}
