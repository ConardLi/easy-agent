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
 * Resolution order (any single signal flips the flag on):
 *
 *   --agent-teams (CLI flag, checked via process.argv)
 *   EASY_AGENT_TEAMS=1 (env var; accepts 1/true/yes/on, anything else off)
 *
 * There is no remote killswitch: Easy Agent has no analytics or
 * feature-flag service.
 */

const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);

function isEnvTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return TRUTHY_VALUES.has(value.trim().toLowerCase());
}

/**
 * True when the user opted into Agent Teams for this process.
 *
 * Read on every Tool.isEnabled() call (cheap — pure string/array checks)
 * so a settings reload that sets the env var mid-session is picked up
 * without a process restart. CLI-flag opt-in is locked at startup.
 */
export function isAgentTeamsEnabled(): boolean {
  if (process.argv.includes("--agent-teams")) return true;
  if (isEnvTruthy(process.env["EASY_AGENT_TEAMS"])) return true;
  return false;
}
