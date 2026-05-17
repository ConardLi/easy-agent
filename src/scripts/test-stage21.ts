#!/usr/bin/env tsx
/**
 * Stage 21 verification script — exercise the Agent Teams subsystem
 * WITHOUT touching the LLM.
 *
 * Coverage:
 *   [1]  Feature flag (isAgentTeamsEnabled) — env var + --agent-teams
 *   [2]  teamHelpers — sanitizeName, formatAgentId, read/write,
 *                      add/remove members, setMemberActive
 *   [3]  teammateMailbox — write / read / drainUnreadMessages,
 *                          concurrent writes serialize via lock
 *   [4]  formatMailboxAttachment — XML shape
 *   [5]  teamContext — single-team-per-process invariant, subscribe
 *   [6]  TeamCreate tool — feature gate, duplicate refusal, in-process
 *                          context populated, on-disk team file created
 *   [7]  SendMessage tool — broadcast, single recipient, unknown target,
 *                           self-send refusal, feature gate
 *   [8]  TeamDelete tool — refuses when active teammates remain,
 *                          cleans up directory + team context
 *   [9]  agentTool — validates name+team_name pairing, refuses without
 *                    feature flag, refuses TEAM_LEAD_NAME, refuses nested
 *                    teammate spawn
 *   [10] System prompt — `formatTeamSystemReminder` rendering across
 *                        the three visibility tiers
 *
 * Usage:
 *   cd easy-agent
 *   npx tsx src/scripts/test-stage21.ts        # baseline run
 *   EASY_AGENT_TEAMS=1 npx tsx src/scripts/test-stage21.ts  # with feature flag set
 *
 * The tests that need the feature flag flip `process.env.EASY_AGENT_TEAMS`
 * in-process (and restore it) so the script self-contains the gate
 * checking — you don't have to run it twice.
 *
 * Exits non-zero on any assertion failure.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { isAgentTeamsEnabled } from "../utils/agentTeamsEnabled.js";
import {
  addTeamMember,
  cleanupTeamDirectory,
  formatAgentId,
  getTeamDir,
  getTeamFilePath,
  readTeamFile,
  readTeamFileAsync,
  removeTeamMember,
  sanitizeName,
  setMemberActive,
  TEAM_LEAD_NAME,
  type TeamFile,
  type TeamMember,
  writeTeamFileAsync,
} from "../utils/teamHelpers.js";
import {
  drainUnreadMessages,
  formatMailboxAttachment,
  getInboxPath,
  markMessagesAsRead,
  readMailbox,
  writeToMailbox,
} from "../utils/teammateMailbox.js";
import {
  clearActiveTeam,
  getActiveTeam,
  isInActiveTeam,
  setActiveTeam,
  subscribeActiveTeam,
} from "../state/teamContext.js";
import { teamCreateTool } from "../tools/teamCreateTool.js";
import { teamDeleteTool } from "../tools/teamDeleteTool.js";
import { sendMessageTool } from "../tools/sendMessageTool.js";
import { agentTool } from "../tools/agentTool.js";
import { formatTeamSystemReminder } from "../agents/teamPromptInjection.js";
import type { ToolContext } from "../tools/Tool.js";
import { setAgents } from "../agents/registry.js";
import { getBuiltInAgents } from "../agents/builtIn/index.js";

// ─── Test plumbing ──────────────────────────────────────────────────

const failures: string[] = [];
function assert(condition: unknown, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`);
    failures.push(label);
  }
}

/**
 * Run `fn` with a temp HOME so every team operation writes under a
 * sandboxed `~/.easy-agent/...`. We point os.homedir() at the temp
 * dir by overriding HOME (which os.homedir() reads on POSIX).
 *
 * Cleanup is unconditional so a failing assertion doesn't leak
 * directories into the developer's real ~/.
 */
async function withTempHome(
  fn: (tmpHome: string) => Promise<void>,
): Promise<void> {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "stage21-home-"));
  const prevHome = process.env["HOME"];
  process.env["HOME"] = tmpHome;
  try {
    await fn(tmpHome);
  } finally {
    if (prevHome !== undefined) process.env["HOME"] = prevHome;
    else delete process.env["HOME"];
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
}

/**
 * Run `fn` with the EASY_AGENT_TEAMS env flag in a known state.
 * Saves + restores both the env var and the `--agent-teams` argv flag
 * if it was already present.
 */
async function withTeamsFlag<T>(
  enabled: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  const prevEnv = process.env["EASY_AGENT_TEAMS"];
  if (enabled) process.env["EASY_AGENT_TEAMS"] = "1";
  else delete process.env["EASY_AGENT_TEAMS"];
  try {
    return await fn();
  } finally {
    if (prevEnv !== undefined) process.env["EASY_AGENT_TEAMS"] = prevEnv;
    else delete process.env["EASY_AGENT_TEAMS"];
  }
}

/** Minimal ToolContext stand-in for tool .call() invocations. */
function makeToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: process.cwd(),
    sessionId: "test-session",
    ...overrides,
  };
}

async function main(): Promise<void> {
  // Each block clears in-process state at the top so order between
  // blocks doesn't matter — running [3] before [2] should produce the
  // same result.
  clearActiveTeam();

  // ─── [1] Feature flag ──────────────────────────────────────────
  console.log("\n[1] Feature flag — EASY_AGENT_TEAMS + --agent-teams");

  await withTeamsFlag(false, async () => {
    assert(isAgentTeamsEnabled() === false, "feature off when no env / no flag");
  });

  await withTeamsFlag(true, async () => {
    assert(isAgentTeamsEnabled() === true, "feature on when EASY_AGENT_TEAMS=1");
  });

  // Process.argv flag — push + pop so we don't leak into other tests.
  process.argv.push("--agent-teams");
  await withTeamsFlag(false, async () => {
    assert(
      isAgentTeamsEnabled() === true,
      "feature on when --agent-teams in argv",
    );
  });
  process.argv.pop();

  // ─── [2] teamHelpers ───────────────────────────────────────────
  console.log("\n[2] teamHelpers — sanitize / read / write / members");

  assert(sanitizeName("My Team!") === "my-team-", "sanitizeName lowercases + replaces");
  assert(sanitizeName("simple") === "simple", "sanitizeName preserves clean names");
  assert(
    formatAgentId("backend", "demo-team") === "backend@demo-team",
    "formatAgentId joins with @",
  );

  await withTempHome(async () => {
    const teamName = "demo-team";
    const file: TeamFile = {
      name: teamName,
      createdAt: Date.now(),
      leadAgentId: formatAgentId(TEAM_LEAD_NAME, teamName),
      members: [
        {
          agentId: formatAgentId(TEAM_LEAD_NAME, teamName),
          name: TEAM_LEAD_NAME,
          joinedAt: Date.now(),
          isActive: true,
        },
      ],
    };
    await writeTeamFileAsync(teamName, file);

    const readBack = readTeamFile(teamName);
    assert(readBack !== null, "readTeamFile (sync) finds the file we just wrote");
    assert(readBack?.name === teamName, "readTeamFile preserves name");
    assert(readBack?.members.length === 1, "lead is sole initial member");

    const readBackAsync = await readTeamFileAsync(teamName);
    assert(readBackAsync?.name === teamName, "readTeamFileAsync agrees");

    const teammate: TeamMember = {
      agentId: formatAgentId("backend", teamName),
      name: "backend",
      agentType: "general-purpose",
      joinedAt: Date.now(),
      isActive: true,
    };
    const afterAdd = await addTeamMember(teamName, teammate);
    assert(afterAdd?.members.length === 2, "addTeamMember appends");
    assert(
      afterAdd?.members.some((m) => m.name === "backend"),
      "addTeamMember added 'backend'",
    );

    // Idempotent on name collision — replace, don't double-add.
    await addTeamMember(teamName, { ...teammate, agentType: "Explore" });
    const refetched = await readTeamFileAsync(teamName);
    assert(refetched?.members.length === 2, "duplicate add by same name replaces, not duplicates");
    assert(
      refetched?.members.find((m) => m.name === "backend")?.agentType === "Explore",
      "duplicate add by same name updates fields",
    );

    await setMemberActive(teamName, "backend", false);
    const idled = await readTeamFileAsync(teamName);
    assert(
      idled?.members.find((m) => m.name === "backend")?.isActive === false,
      "setMemberActive flips the flag",
    );

    await removeTeamMember(teamName, "backend");
    const removed = await readTeamFileAsync(teamName);
    assert(removed?.members.length === 1, "removeTeamMember drops the member");

    await cleanupTeamDirectory(teamName);
    assert(
      readTeamFile(teamName) === null,
      "cleanupTeamDirectory removes everything",
    );
  });

  // ─── [3] teammateMailbox ───────────────────────────────────────
  console.log("\n[3] teammateMailbox — write / read / drain / concurrent");

  await withTempHome(async () => {
    const teamName = "msg-team";
    // The mailbox writes don't require a team.json to exist (writeToMailbox
    // creates the inbox dir on demand), so we just go straight in.
    await writeToMailbox(
      "backend",
      {
        from: TEAM_LEAD_NAME,
        text: "hello backend",
        timestamp: new Date().toISOString(),
        summary: "greeting",
      },
      teamName,
    );

    const inboxPath = getInboxPath("backend", teamName);
    assert(
      inboxPath.endsWith(path.join("teams", teamName, "inboxes", "backend.json")),
      "getInboxPath returns the expected layout",
    );

    const msgs1 = await readMailbox("backend", teamName);
    assert(msgs1.length === 1, "single write produces one message");
    assert(msgs1[0]?.text === "hello backend", "write preserves text");
    assert(msgs1[0]?.read === false, "fresh messages are unread");

    // Concurrent writes — fan out 8 SendMessages simultaneously and
    // confirm all 8 land in the inbox in some serialized order.
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        writeToMailbox(
          "backend",
          {
            from: "frontend",
            text: `concurrent-${i}`,
            timestamp: new Date().toISOString(),
          },
          teamName,
        ),
      ),
    );
    const msgs2 = await readMailbox("backend", teamName);
    assert(msgs2.length === 9, "8 concurrent writes serialized into the inbox");

    // drainUnreadMessages should hand back exactly the 9 (the 1 original
    // + 8 concurrent) and mark them all read.
    const drained = await drainUnreadMessages("backend", teamName);
    assert(drained.length === 9, "drain returns every unread message");
    const msgs3 = await readMailbox("backend", teamName);
    assert(
      msgs3.every((m) => m.read === true),
      "drain marks every message read",
    );

    const drainedAgain = await drainUnreadMessages("backend", teamName);
    assert(drainedAgain.length === 0, "second drain returns nothing");

    // markMessagesAsRead is idempotent + safe on missing inboxes.
    await markMessagesAsRead("never-existed", teamName);
    assert(true, "markMessagesAsRead on missing inbox does not throw");
  });

  // ─── [4] formatMailboxAttachment ───────────────────────────────
  console.log("\n[4] formatMailboxAttachment — XML shape");

  const attachment = formatMailboxAttachment([
    {
      from: "frontend",
      text: "interface changed",
      timestamp: "2026-01-01T00:00:00.000Z",
      summary: "API contract delta",
      read: false,
    },
  ]);
  assert(
    attachment.includes("<teammate-messages>"),
    "outer wrapper rendered",
  );
  assert(
    attachment.includes("<teammate-message from=\"frontend\""),
    "inner block includes from attr",
  );
  assert(
    attachment.includes("summary=\"API contract delta\""),
    "summary surfaces as an attribute",
  );
  assert(
    formatMailboxAttachment([]) === "",
    "empty list returns empty string",
  );

  // ─── [5] teamContext ───────────────────────────────────────────
  console.log("\n[5] teamContext — single-team invariant + subscribe");

  clearActiveTeam();
  assert(getActiveTeam() === null, "starts cleared");
  assert(isInActiveTeam() === false, "isInActiveTeam=false when cleared");

  let notifyCount = 0;
  const unsub = subscribeActiveTeam(() => {
    notifyCount++;
  });
  setActiveTeam({
    teamName: "t1",
    leadAgentId: "team-lead@t1",
    teamFilePath: "/tmp/whatever",
    createdAt: Date.now(),
  });
  assert(getActiveTeam()?.teamName === "t1", "setActiveTeam stores ctx");
  assert(isInActiveTeam() === true, "isInActiveTeam=true after set");
  assert(notifyCount >= 1, "subscribe listener fired on set");

  // Same-name set should NOT throw (idempotent).
  setActiveTeam({
    teamName: "t1",
    leadAgentId: "team-lead@t1",
    teamFilePath: "/tmp/whatever",
    createdAt: Date.now(),
  });
  assert(true, "set with same name does not throw");

  // Different-name set MUST throw.
  let threw = false;
  try {
    setActiveTeam({
      teamName: "t2",
      leadAgentId: "team-lead@t2",
      teamFilePath: "/tmp/x",
      createdAt: Date.now(),
    });
  } catch {
    threw = true;
  }
  assert(threw, "set with different name throws (single-team invariant)");

  clearActiveTeam();
  assert(getActiveTeam() === null, "clearActiveTeam resets");
  unsub();

  // ─── [6] TeamCreate tool ───────────────────────────────────────
  console.log("\n[6] TeamCreate tool — gate + create + duplicate refusal");

  clearActiveTeam();
  await withTempHome(async () => {
    await withTeamsFlag(false, async () => {
      assert(
        teamCreateTool.isEnabled() === false,
        "TeamCreate.isEnabled() false without flag",
      );
    });

    await withTeamsFlag(true, async () => {
      assert(
        teamCreateTool.isEnabled() === true,
        "TeamCreate.isEnabled() true with flag",
      );

      const ctx = makeToolContext();
      const result = await teamCreateTool.call(
        { team_name: "demo" },
        ctx,
      );
      assert(!result.isError, "TeamCreate with fresh state succeeds");
      assert(
        getActiveTeam()?.teamName === "demo",
        "teamContext populated after TeamCreate",
      );
      const onDisk = readTeamFile("demo");
      assert(onDisk !== null, "team.json written to disk");
      assert(
        onDisk?.members[0]?.name === TEAM_LEAD_NAME,
        "lead is sole initial member",
      );

      // Second call refuses because a team is already active.
      const dup = await teamCreateTool.call({ team_name: "other" }, ctx);
      assert(dup.isError === true, "second TeamCreate refused");
      assert(
        dup.content.includes("already leading"),
        "refusal mentions current team",
      );

      // Empty / blank team_name rejected.
      clearActiveTeam();
      await cleanupTeamDirectory("demo");
      const blank = await teamCreateTool.call({ team_name: "   " }, ctx);
      assert(blank.isError === true, "blank team_name rejected");

      // A team file that already exists on disk for a different team name.
      const ctx2 = makeToolContext();
      await teamCreateTool.call({ team_name: "preset" }, ctx2);
      clearActiveTeam(); // in-process clear, but team.json still on disk
      const preExist = await teamCreateTool.call({ team_name: "preset" }, ctx2);
      assert(preExist.isError === true, "TeamCreate refuses pre-existing on-disk team");
      assert(
        preExist.content.includes("already exists on disk"),
        "refusal message mentions on-disk file",
      );
      await cleanupTeamDirectory("preset");
    });
  });

  // ─── [7] SendMessage tool ──────────────────────────────────────
  console.log("\n[7] SendMessage tool — single + broadcast + edge cases");

  clearActiveTeam();
  await withTempHome(async () => {
    await withTeamsFlag(false, async () => {
      assert(
        sendMessageTool.isEnabled() === false,
        "SendMessage disabled without flag",
      );
    });

    await withTeamsFlag(true, async () => {
      const ctx = makeToolContext();

      // No active team yet.
      const noTeam = await sendMessageTool.call(
        { to: "backend", message: "ping" },
        ctx,
      );
      assert(noTeam.isError === true, "SendMessage errors when no team active");

      // Create a team and populate two teammates manually.
      await teamCreateTool.call({ team_name: "send-team" }, ctx);
      await addTeamMember("send-team", {
        agentId: formatAgentId("backend", "send-team"),
        name: "backend",
        joinedAt: Date.now(),
        isActive: true,
      });
      await addTeamMember("send-team", {
        agentId: formatAgentId("frontend", "send-team"),
        name: "frontend",
        joinedAt: Date.now(),
        isActive: true,
      });

      // Unknown recipient.
      const unknown = await sendMessageTool.call(
        { to: "nobody", message: "ghost" },
        ctx,
      );
      assert(unknown.isError === true, "SendMessage to unknown name fails");
      assert(
        unknown.content.includes("Known members"),
        "error lists known members",
      );

      // Single recipient.
      const single = await sendMessageTool.call(
        { to: "backend", message: "fix the auth bug", summary: "auth bug" },
        ctx,
      );
      assert(!single.isError, "SendMessage to known recipient succeeds");
      const backendInbox = await readMailbox("backend", "send-team");
      assert(backendInbox.length === 1, "one message in backend inbox");
      assert(
        backendInbox[0]?.from === TEAM_LEAD_NAME,
        "from defaults to TEAM_LEAD_NAME for lead-originated sends",
      );
      assert(backendInbox[0]?.summary === "auth bug", "summary persisted");

      // From a teammate identity (ctx.teammateIdentity set).
      const teammateCtx = makeToolContext({
        teammateIdentity: {
          agentId: formatAgentId("backend", "send-team"),
          agentName: "backend",
          teamName: "send-team",
        },
      });
      await sendMessageTool.call(
        { to: "frontend", message: "the API is at /v2/auth" },
        teammateCtx,
      );
      const frontendInbox = await readMailbox("frontend", "send-team");
      assert(
        frontendInbox[0]?.from === "backend",
        "from resolved from teammateIdentity when present",
      );

      // Self-send refused.
      const self = await sendMessageTool.call(
        { to: "backend", message: "talking to myself", summary: "echo" },
        teammateCtx,
      );
      assert(self.isError === true, "self-send refused");

      // Broadcast — to "*" should hit every active OTHER member.
      const broadcast = await sendMessageTool.call(
        {
          to: "*",
          message: "stand-up in 5 minutes",
          summary: "stand-up reminder",
        },
        ctx,
      );
      assert(!broadcast.isError, "broadcast succeeds");
      const backendInbox2 = await readMailbox("backend", "send-team");
      const frontendInbox2 = await readMailbox("frontend", "send-team");
      assert(
        backendInbox2.length === 2,
        "broadcast reached backend (1 single + 1 broadcast)",
      );
      assert(
        frontendInbox2.length === 2,
        "broadcast reached frontend (1 teammate-DM + 1 broadcast)",
      );

      // Cleanup.
      clearActiveTeam();
      await cleanupTeamDirectory("send-team");
    });
  });

  // ─── [8] TeamDelete tool ───────────────────────────────────────
  console.log("\n[8] TeamDelete tool — active-member guard + cleanup");

  clearActiveTeam();
  await withTempHome(async () => {
    await withTeamsFlag(true, async () => {
      const ctx = makeToolContext();
      await teamCreateTool.call({ team_name: "kill-team" }, ctx);
      // Add a still-active teammate; TeamDelete should refuse.
      await addTeamMember("kill-team", {
        agentId: formatAgentId("worker", "kill-team"),
        name: "worker",
        joinedAt: Date.now(),
        isActive: true,
      });
      const refused = await teamDeleteTool.call({}, ctx);
      assert(refused.isError === true, "TeamDelete refused while teammate active");
      assert(
        refused.content.includes("worker"),
        "refusal lists the offending teammate",
      );
      assert(
        getActiveTeam() !== null,
        "teamContext unchanged after refused delete",
      );

      // Flip to idle and retry.
      await setMemberActive("kill-team", "worker", false);
      const ok = await teamDeleteTool.call({}, ctx);
      assert(!ok.isError, "TeamDelete succeeds after teammate idles");
      assert(getActiveTeam() === null, "teamContext cleared after delete");
      assert(
        readTeamFile("kill-team") === null,
        "team file removed from disk",
      );

      // TeamDelete with no active team → error.
      const empty = await teamDeleteTool.call({}, ctx);
      assert(empty.isError === true, "TeamDelete with no active team errors");
    });
  });

  // ─── [9] AgentTool — name/team_name validation ─────────────────
  console.log("\n[9] AgentTool — name / team_name validation");

  // The agent registry must be populated before agentTool.call() can
  // resolve subagent_type. Built-ins are synchronous and safe to call
  // unconditionally.
  setAgents(getBuiltInAgents());

  clearActiveTeam();
  await withTempHome(async () => {
    // (a) Feature flag off → name parameter is an error.
    await withTeamsFlag(false, async () => {
      const out = await agentTool.call(
        {
          prompt: "ping",
          description: "test",
          name: "backend",
          team_name: "x",
        },
        makeToolContext(),
      );
      assert(out.isError === true, "AgentTool refuses name when flag off");
      assert(
        out.content.includes("not enabled"),
        "error mentions feature is not enabled",
      );
    });

    await withTeamsFlag(true, async () => {
      const ctx = makeToolContext();
      // (b) name without team_name.
      const missingTeam = await agentTool.call(
        { prompt: "ping", description: "test", name: "backend" },
        ctx,
      );
      assert(
        missingTeam.isError === true,
        "name without team_name is an error",
      );

      // (c) team_name without active team.
      const noActive = await agentTool.call(
        {
          prompt: "ping",
          description: "test",
          name: "backend",
          team_name: "ghost-team",
        },
        ctx,
      );
      assert(
        noActive.isError === true,
        "team_name without active team is an error",
      );

      // (d) team_name mismatch.
      await teamCreateTool.call({ team_name: "valid-team" }, ctx);
      const mismatch = await agentTool.call(
        {
          prompt: "ping",
          description: "test",
          name: "backend",
          team_name: "wrong-team",
        },
        ctx,
      );
      assert(
        mismatch.isError === true,
        "team_name that doesn't match active team rejected",
      );

      // (e) name === TEAM_LEAD_NAME reserved.
      const reserved = await agentTool.call(
        {
          prompt: "ping",
          description: "test",
          name: TEAM_LEAD_NAME,
          team_name: "valid-team",
        },
        ctx,
      );
      assert(reserved.isError === true, "TEAM_LEAD_NAME reserved");

      // (f) Teammate trying to spawn a sub-teammate (nested teams).
      const teammateCtx = makeToolContext({
        teammateIdentity: {
          agentId: formatAgentId("backend", "valid-team"),
          agentName: "backend",
          teamName: "valid-team",
        },
      });
      const nested = await agentTool.call(
        {
          prompt: "ping",
          description: "test",
          name: "frontend",
          team_name: "valid-team",
        },
        teammateCtx,
      );
      assert(nested.isError === true, "nested teammate spawn rejected");

      // (g) run_in_background: false rejected for named teammate.
      const fg = await agentTool.call(
        {
          prompt: "ping",
          description: "test",
          name: "backend",
          team_name: "valid-team",
          run_in_background: false,
        },
        ctx,
      );
      assert(
        fg.isError === true,
        "foreground named teammate rejected",
      );

      clearActiveTeam();
      await cleanupTeamDirectory("valid-team");
    });
  });

  // ─── [10] System prompt rendering ──────────────────────────────
  console.log("\n[10] formatTeamSystemReminder — visibility tiers");

  clearActiveTeam();

  await withTeamsFlag(false, async () => {
    assert(
      formatTeamSystemReminder() === "",
      "empty string when feature off",
    );
  });

  await withTeamsFlag(true, async () => {
    // No team active → discovery hint.
    const hint = formatTeamSystemReminder();
    assert(
      hint.includes("Agent Teams is enabled"),
      "feature-on / no-team hint mentions enablement",
    );
    assert(
      hint.includes("TeamCreate"),
      "feature-on / no-team hint points at TeamCreate",
    );
    assert(
      !hint.includes("Team members"),
      "feature-on / no-team hint does NOT include member list",
    );

    // With an active team → full reminder. Use tmp HOME so we can
    // create / inspect the team file.
    await withTempHome(async () => {
      const ctx = makeToolContext();
      await teamCreateTool.call({ team_name: "render-team" }, ctx);
      await addTeamMember("render-team", {
        agentId: formatAgentId("backend", "render-team"),
        name: "backend",
        agentType: "general-purpose",
        joinedAt: Date.now(),
        isActive: true,
      });
      await addTeamMember("render-team", {
        agentId: formatAgentId("frontend", "render-team"),
        name: "frontend",
        joinedAt: Date.now(),
        isActive: false,
      });
      const reminder = formatTeamSystemReminder();
      assert(
        reminder.includes("LEAD of team \"render-team\""),
        "active-team reminder names the lead",
      );
      assert(
        reminder.includes("- backend [active]"),
        "active teammates rendered with [active] tag",
      );
      assert(
        reminder.includes("- frontend [idle]"),
        "idle teammates rendered with [idle] tag",
      );
      assert(
        reminder.includes("SendMessage"),
        "active-team reminder mentions SendMessage",
      );
      clearActiveTeam();
      await cleanupTeamDirectory("render-team");
    });
  });

  // ─── Summary ────────────────────────────────────────────────────
  console.log("");
  if (failures.length > 0) {
    console.log(`✗ ${failures.length} assertion(s) failed:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  } else {
    console.log("✓ All stage 21 tests passed.");
    process.exit(0);
  }
}

main().catch((err: unknown) => {
  console.error("Test script crashed:", err);
  process.exit(2);
});
