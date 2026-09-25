# Agent Teams state and recovery

Agent Teams is enabled with `--agent-teams` or `EASY_AGENT_TEAMS=1`. `TeamCreate` creates one active team for the CLI process. Named background agents join with `Agent({ name, team_name, run_in_background: true, ... })`; ordinary `Agent` calls remain independent.

The team file is stored at `~/.easy-agent/teams/<team-name>/team.json`. Every update reads and writes it under a file lock, commits an atomic replacement and increments `version`. A direct write based on an older version is rejected. Each teammate run has its own id, state and run token, so completion from an earlier run cannot mark a replacement inactive. A running name cannot be launched twice.

`TaskCreate`, `TaskList`, `TaskGet` and `TaskUpdate` use one task list while a team is active. The lead and every named teammate see the same tasks. Claim a pending task with `TaskUpdate({ taskId: "1", status: "in_progress" })`; the claim and dependency check are serialized. Only the owner can release it by setting `pending` or finish it by setting `completed`. A teammate's unfinished claims return to `pending` when that run ends. Outside a team, task tools keep their existing session scope.

`SendMessage` delivers ordinary messages before a running teammate's next model call. A message to a finished teammate remains in its inbox until that name is launched again. The lead receives teammate messages in its next turn; an idle interactive session wakes when an in-process message arrives. To stop a teammate, the lead can send `type: "shutdown_request"`, which stops after the current tool batch, or `type: "abort_request"`, which cancels immediately. Control messages carry a request id. A shutdown response is written to the lead's inbox when the run closes.

If the CLI process exits before `TeamDelete`, start a new process and call `TeamCreate({ team_name: "<name>", resume: true })`. Resume refuses to take over a team whose lead PID is still alive. It marks previous active members `stale` and returns their unfinished tasks to `pending`; it does not restart their model calls. Review those tasks and launch new teammate runs as needed.

`TeamDelete()` refuses to remove a team with live teammates. After a crash, `TeamDelete({ team_name: "<name>", forceStale: true })` can remove a team whose old processes are gone. It refuses to force a live lead or teammate. Deletion removes the team file, inboxes and shared task list. Dirty worktrees are preserved for review.

Run `npm run test:team-lifecycle` for concurrent membership, version checks, competing task claims, control messages and recovery after an actual worker-process exit. `npm run verify:production` also runs this test and the existing Agent Teams and Sub-Agent suites.
