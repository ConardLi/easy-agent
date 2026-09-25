import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  addTeamMember,
  finalizeTeamMember,
  getTeamFilePath,
  readTeamFileAsync,
  resumeTeamFile,
  setMemberStatus,
  writeTeamFileAsync,
  TEAM_LEAD_NAME,
  type TeamMember,
} from "../utils/teamHelpers.js";
import { clearActiveTeam, getActiveTeam } from "../state/teamContext.js";
import { getTeamTaskListId, getTask, releaseMemberTasks } from "../state/taskStore.js";
import { teamCreateTool } from "../tools/teamCreateTool.js";
import { teamDeleteTool } from "../tools/teamDeleteTool.js";
import { taskCreateTool } from "../tools/taskCreateTool.js";
import { taskUpdateTool } from "../tools/taskUpdateTool.js";
import { taskListTool } from "../tools/taskListTool.js";
import { sendMessageTool } from "../tools/sendMessageTool.js";
import { clearAllAsyncAgents, completeAsyncAgent, getAsyncAgent, registerAsyncAgent } from "../state/asyncAgentStore.js";
import { readMailbox } from "../utils/teammateMailbox.js";
import { getTaskMode, setTaskMode } from "../state/taskModeStore.js";
import type { ToolContext } from "../tools/Tool.js";

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "easy-agent-team-lifecycle-"));
const oldHome = process.env.HOME;
const oldProfile = process.env.USERPROFILE;
const oldTeams = process.env.EASY_AGENT_TEAMS;
const oldTaskMode = getTaskMode();
const execFileAsync = promisify(execFile);
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EASY_AGENT_TEAMS = "1";

const leadContext: ToolContext = { cwd: tempHome, sessionId: "lead-session" };
const runIds = new Map<string, string>();
const memberContext = (name: string): ToolContext => ({
  cwd: tempHome,
  sessionId: `${name}-session`,
  teammateIdentity: { agentId: `${name}@concurrent-team`, agentName: name, teamName: "concurrent-team", runId: runIds.get(name) },
});

try {
  const created = await teamCreateTool.call({ team_name: "concurrent-team" }, leadContext);
  assert.notEqual(created.isError, true);
  assert.equal(getActiveTeam()?.teamName, "concurrent-team");
  setTaskMode("todo");
  assert.equal(taskCreateTool.isEnabled?.(), true);
  setTaskMode(oldTaskMode);

  const initial = await readTeamFileAsync("concurrent-team");
  assert.ok(initial);
  assert.equal(initial.version, 1);
  const members: TeamMember[] = Array.from({ length: 12 }, (_, index) => ({
    agentId: `worker-${index}@concurrent-team`,
    name: `worker-${index}`,
    joinedAt: Date.now(),
    isActive: true,
    runId: randomUUID(),
    hostPid: process.pid,
    heartbeatAt: Date.now(),
  }));
  for (const member of members) runIds.set(member.name, member.runId!);
  await Promise.all(members.map((member) => addTeamMember("concurrent-team", member)));
  await addTeamMember("concurrent-team", { agentId: "name_with_underscore", name: "name_with_underscore", joinedAt: Date.now(), isActive: false });
  await assert.rejects(() => addTeamMember("concurrent-team", { agentId: "name-with-underscore", name: "name-with-underscore", joinedAt: Date.now(), isActive: true }), /shares an inbox path/);
  const afterAdd = await readTeamFileAsync("concurrent-team");
  assert.equal(afterAdd?.members.length, 14);
  assert.equal(afterAdd?.version, 14);

  await Promise.all(members.map((member) => setMemberStatus("concurrent-team", member.name, member.runId!, "completed")));
  const afterFinish = await readTeamFileAsync("concurrent-team");
  assert.equal(afterFinish?.members.filter((member) => member.isActive).length, 1);
  assert.equal(afterFinish?.version, 26);
  await assert.rejects(() => writeTeamFileAsync("concurrent-team", initial), /File changed/);

  const first = members[0]!;
  const secondRunId = randomUUID();
  await addTeamMember("concurrent-team", { ...first, runId: secondRunId, isActive: true, status: "running" });
  runIds.set(first.name, secondRunId);
  await setMemberStatus("concurrent-team", first.name, first.runId!, "completed");
  assert.equal((await readTeamFileAsync("concurrent-team"))?.members.find((member) => member.name === first.name)?.runId, secondRunId);
  assert.equal((await readTeamFileAsync("concurrent-team"))?.members.find((member) => member.name === first.name)?.isActive, true);
  const oldRunContext: ToolContext = { ...memberContext(first.name), teammateIdentity: { agentId: first.agentId, agentName: first.name, teamName: "concurrent-team", runId: first.runId } };
  assert.equal((await taskCreateTool.call({ subject: "Stale write", description: "Must be rejected" }, oldRunContext)).isError, true);

  for (const member of members.slice(1, 4)) {
    const runId = randomUUID();
    await addTeamMember("concurrent-team", { ...member, runId, isActive: true, status: "running" });
    runIds.set(member.name, runId);
  }

  const task = await taskCreateTool.call({ subject: "Shared task", description: "Only one member may claim it" }, leadContext);
  assert.equal(task.isError, undefined);
  const teamListId = getTeamTaskListId("concurrent-team");
  assert.ok((await getTask(teamListId, "1")));
  assert.notEqual((await taskUpdateTool.call({ taskId: "1", status: "in_progress" }, memberContext(first.name))).isError, true);
  assert.equal(await finalizeTeamMember("concurrent-team", first.name, first.runId!, "completed", () => releaseMemberTasks("concurrent-team", first.name)), false);
  assert.equal((await getTask(teamListId, "1"))?.owner, first.name);
  assert.notEqual((await taskUpdateTool.call({ taskId: "1", status: "pending" }, memberContext(first.name))).isError, true);
  const plainAgentContext: ToolContext = { cwd: tempHome, sessionId: "plain-agent", taskScope: "session" };
  assert.notEqual((await taskCreateTool.call({ subject: "Private task", description: "Ordinary sub-agent task" }, plainAgentContext)).isError, true);
  assert.equal((await getTask(teamListId, "2")), null);
  assert.equal((await teamDeleteTool.call({}, plainAgentContext)).isError, true);
  assert.equal((await sendMessageTool.call({ to: "worker-1", message: "hello" }, plainAgentContext)).isError, true);
  assert.match(String((await taskListTool.call({}, memberContext("worker-1"))).content), /Shared task/);
  const claimResults = await Promise.all([
    taskUpdateTool.call({ taskId: "1", status: "in_progress" }, memberContext("worker-1")),
    taskUpdateTool.call({ taskId: "1", status: "in_progress" }, memberContext("worker-2")),
  ]);
  assert.equal(claimResults.filter((result) => result.isError !== true).length, 1);
  const owner = (await getTask(teamListId, "1"))?.owner;
  assert.ok(owner === "worker-1" || owner === "worker-2");
  assert.equal((await taskUpdateTool.call({ taskId: "1", status: "completed" }, memberContext(owner === "worker-1" ? "worker-2" : "worker-1"))).isError, true);
  assert.equal(await releaseMemberTasks("concurrent-team", owner!), 1);
  assert.equal((await getTask(teamListId, "1"))?.status, "pending");
  const other = owner === "worker-1" ? "worker-2" : "worker-1";
  assert.notEqual((await taskUpdateTool.call({ taskId: "1", status: "in_progress" }, memberContext(other))).isError, true);
  assert.notEqual((await taskUpdateTool.call({ taskId: "1", status: "completed" }, memberContext(other))).isError, true);
  assert.equal((await getTask(teamListId, "1"))?.status, "completed");

  const runningTask = await taskCreateTool.call({ subject: "Recoverable task", description: "Return to pending after restart" }, memberContext("worker-3"));
  assert.equal(runningTask.isError, undefined);
  assert.notEqual((await taskUpdateTool.call({ taskId: "2", status: "in_progress" }, memberContext("worker-3"))).isError, true);
  clearActiveTeam();
  const latest = await readTeamFileAsync("concurrent-team");
  assert.ok(latest);
  await writeTeamFileAsync("concurrent-team", { ...latest, leadPid: 999_999_999, leadHeartbeatAt: 0 });
  await assert.rejects(() => resumeTeamFile("concurrent-team", async () => { throw new Error("task store unavailable"); }), /task store unavailable/);
  assert.equal((await readTeamFileAsync("concurrent-team"))?.leadPid, 999_999_999);
  const resumed = await teamCreateTool.call({ team_name: "concurrent-team", resume: true }, leadContext);
  assert.notEqual(resumed.isError, true);
  assert.equal((await readTeamFileAsync("concurrent-team"))?.members.find((member) => member.name === first.name)?.status, "stale");
  assert.equal((await getTask(teamListId, "2"))?.status, "pending");
  assert.equal((await getTask(teamListId, "2"))?.owner, undefined);

  const activeRunId = randomUUID();
  const agentId = `control-${activeRunId}`;
  await addTeamMember("concurrent-team", { agentId, name: "controlled", joinedAt: Date.now(), isActive: true, runId: activeRunId, hostPid: process.pid, heartbeatAt: Date.now() });
  registerAsyncAgent({ agentId, agentType: "general-purpose", prompt: "work", outputFile: path.join(tempHome, "control.output") });
  const shutdown = await sendMessageTool.call({ to: "controlled", message: "Finish your current tool batch", type: "shutdown_request" }, leadContext);
  assert.notEqual(shutdown.isError, true);
  assert.equal(getAsyncAgent(agentId)?.shutdownRequested, true);
  assert.equal((await readTeamFileAsync("concurrent-team"))?.members.find((member) => member.name === "controlled")?.status, "stopping");
  assert.equal((await readMailbox("controlled", "concurrent-team"))[0]?.type, "shutdown_request");
  const aborted = await sendMessageTool.call({ to: "controlled", message: "Stop now", type: "abort_request" }, leadContext);
  assert.notEqual(aborted.isError, true);
  assert.equal(getAsyncAgent(agentId)?.status, "killed");
  assert.ok(getAsyncAgent(agentId)?.shutdownRequestId);
  await setMemberStatus("concurrent-team", "controlled", activeRunId, "aborted");

  registerAsyncAgent({ agentId: "model-error", agentType: "general-purpose", prompt: "work", outputFile: path.join(tempHome, "failed.output") });
  completeAsyncAgent("model-error", {
    agentType: "general-purpose", finalText: "", messages: [], totalToolUseCount: 0,
    totalDurationMs: 1, totalTokens: 0, inputTokens: 0, outputTokens: 0, turnCount: 1,
    reason: "model_error",
  });
  assert.equal(getAsyncAgent("model-error")?.status, "failed");

  const deleted = await teamDeleteTool.call({}, leadContext);
  assert.notEqual(deleted.isError, true);
  assert.equal(await readTeamFileAsync("concurrent-team"), null);
  assert.equal((await getTask(teamListId, "1")), null);

  const crashWorker = [
    "import { writeTeamFileAsync } from './src/utils/teamHelpers.ts';",
    "const now = Date.now();",
    "await writeTeamFileAsync('crash-team', { name: 'crash-team', createdAt: now, leadAgentId: 'team-lead@crash-team', leadPid: process.pid, leadHeartbeatAt: now, members: [",
    "{ agentId: 'team-lead@crash-team', name: 'team-lead', joinedAt: now, isActive: true, hostPid: process.pid, heartbeatAt: now },",
    "{ agentId: 'worker@crash-team', name: 'worker', joinedAt: now, isActive: true, hostPid: process.pid, heartbeatAt: now },",
    "] });",
  ].join("\n");
  await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", crashWorker], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
  });
  const crashRecovery = await teamCreateTool.call({ team_name: "crash-team", resume: true }, leadContext);
  assert.notEqual(crashRecovery.isError, true);
  assert.equal((await readTeamFileAsync("crash-team"))?.members.find((member) => member.name === "worker")?.status, "stale");
  assert.notEqual((await teamDeleteTool.call({}, leadContext)).isError, true);

  const orphan = {
    name: "orphan-team", createdAt: Date.now(), leadAgentId: "team-lead@orphan-team", leadPid: 999_999_999, leadHeartbeatAt: 0,
    members: [
      { agentId: "team-lead@orphan-team", name: TEAM_LEAD_NAME, joinedAt: Date.now(), isActive: true },
      { agentId: "worker@orphan-team", name: "worker", joinedAt: Date.now(), isActive: true, hostPid: 999_999_999, heartbeatAt: 0 },
    ],
  };
  await writeTeamFileAsync("orphan-team", orphan);
  assert.equal((await teamDeleteTool.call({ team_name: "orphan-team" }, leadContext)).isError, true);
  assert.notEqual((await teamDeleteTool.call({ team_name: "orphan-team", forceStale: true }, leadContext)).isError, true);
  await assert.rejects(fs.access(getTeamFilePath("orphan-team")));

  const competingCreates = await Promise.all([
    teamCreateTool.call({ team_name: "create-a" }, leadContext),
    teamCreateTool.call({ team_name: "create-b" }, leadContext),
  ]);
  assert.equal(competingCreates.filter((result) => result.isError !== true).length, 1);
  const survivingTeam = getActiveTeam()?.teamName;
  assert.ok(survivingTeam === "create-a" || survivingTeam === "create-b");
  assert.equal(await readTeamFileAsync(survivingTeam === "create-a" ? "create-b" : "create-a"), null);
  assert.notEqual((await teamDeleteTool.call({}, leadContext)).isError, true);

  console.log("Team lifecycle checks passed.");
} finally {
  clearActiveTeam();
  clearAllAsyncAgents();
  setTaskMode(oldTaskMode);
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
  if (oldTeams === undefined) delete process.env.EASY_AGENT_TEAMS; else process.env.EASY_AGENT_TEAMS = oldTeams;
  await fs.rm(tempHome, { recursive: true, force: true });
}
