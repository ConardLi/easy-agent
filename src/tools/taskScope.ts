import type { ToolContext } from "./Tool.js";
import { getActiveTeam } from "../state/teamContext.js";
import { getTaskListId, getTeamTaskListId } from "../state/taskStore.js";
import { getTeamFilePath, readTeamFileAsync, TEAM_LEAD_NAME } from "../utils/teamHelpers.js";
import { withFileLock } from "../utils/atomicFile.js";
import { isTaskModeEnabled } from "../state/taskModeStore.js";

export function isTaskGraphEnabled(): boolean {
  return isTaskModeEnabled() || getActiveTeam() !== null;
}

export function resolveTaskScope(context: ToolContext): { listId: string; actor?: string } {
  const teammate = context.teammateIdentity;
  if (teammate) {
    return { listId: getTeamTaskListId(teammate.teamName), actor: teammate.agentName };
  }
  if (context.taskScope === "session") return { listId: getTaskListId(context.sessionId ?? "default") };
  const active = getActiveTeam();
  if (active) return { listId: getTeamTaskListId(active.teamName), actor: TEAM_LEAD_NAME };
  return { listId: getTaskListId(context.sessionId ?? "default") };
}

export async function validateTaskActor(context: ToolContext): Promise<string | null> {
  const identity = context.teammateIdentity;
  if (!identity) return null;
  const team = await readTeamFileAsync(identity.teamName);
  const member = team?.members.find((candidate) => candidate.name === identity.agentName);
  if (!team || team.status === "shutting_down" || !member?.isActive || (identity.runId && member.runId !== identity.runId)) {
    return `Teammate "${identity.agentName}" is no longer active in team "${identity.teamName}"`;
  }
  return null;
}

export async function withActiveTaskActor<T>(context: ToolContext, operation: () => Promise<T>): Promise<T> {
  const identity = context.teammateIdentity;
  const teamName = identity?.teamName ?? (context.taskScope === "session" ? undefined : getActiveTeam()?.teamName);
  if (!teamName) return operation();
  return withFileLock(getTeamFilePath(teamName), async () => {
    const team = await readTeamFileAsync(teamName);
    if (!team || team.status === "shutting_down") throw new Error(`Team "${teamName}" is unavailable`);
    if (identity) {
      const member = team.members.find((candidate) => candidate.name === identity.agentName);
      if (!member?.isActive || !identity.runId || member.runId !== identity.runId) {
        throw new Error(`Teammate "${identity.agentName}" is no longer active in team "${teamName}"`);
      }
    } else if (team.leadPid !== process.pid) {
      throw new Error(`Team "${teamName}" is led by another process`);
    }
    return operation();
  });
}
