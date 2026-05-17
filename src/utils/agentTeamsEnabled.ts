/**
 * Feature flag for Agent Teams (stage 21).
 *
 * Mirrors source's `agentSwarmsEnabled.ts` killswitch pattern:
 *   - One central gate function (`isAgentTeamsEnabled`).
 *   - Two opt-in signals: a CLI flag and an environment variable.
 *   - Defaults to OFF — teams must be explicitly enabled.
 *
 * Why a feature flag at all (source ships it as the "tengu_amber_flint"
 * GrowthBook gate):
 *
 *   1. The team toolchain (TeamCreate / TeamDelete / SendMessage) adds
 *      three new schema-visible tools the model can call. When teams are
 *      off the model shouldn't even see them — clutters the tool list,
 *      tempts mis-routing of regular sub-agent work into a "team", and
 *      lights up unrelated `<system-reminder>` guidance.
 *   2. Teams persist state on disk (~/.easy-agent/teams/...). For a user
 *      who never opted in we should never create that directory tree.
 *   3. Forward compatibility: keeping the gate isolated means future
 *      stages can extend it (tmux backend, plan_approval protocol, …)
 *      without touching every call site that asks "is this feature on?".
 *
 * Resolution order (any single signal flips the flag on):
 *
 *   --agent-teams (CLI flag, checked via process.argv)
 *   EASY_AGENT_TEAMS=1 (env var; accepts 1/true/yes/on, anything else off)
 *
 * Mirrors source's check shape:
 *   claude-code-source-code/src/utils/agentSwarmsEnabled.ts:24-44
 *   (we drop USER_TYPE === 'ant' and the GrowthBook killswitch because
 *    Easy Agent has no analytics service and no internal-vs-external
 *    distinction — every install is "external").
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
 * without a process restart. CLI-flag opt-in is locked at startup,
 * which is the source-aligned behavior.
 */
export function isAgentTeamsEnabled(): boolean {
  if (process.argv.includes("--agent-teams")) return true;
  if (isEnvTruthy(process.env["EASY_AGENT_TEAMS"])) return true;
  return false;
}
