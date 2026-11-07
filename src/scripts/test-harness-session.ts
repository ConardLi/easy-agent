/**
 * Sessions remember their Agent: a new session records the Agent's name, the
 * hash of its settings, and a digest of each setting; `listSessions()` and
 * `readSession()` show it; `createAgentRuntime({ harness: { session } })`
 * starts with the Agent a session last ran with (`default` for sessions saved
 * before Agents were recorded, and when that Agent was deleted); resuming
 * reports whether the Agent is the same, changed (and which settings), deleted,
 * or another one, and records the Agent it now runs with; forks keep the
 * source's Agent; `/resume` reports the same; transcripts stay readable by
 * earlier versions.
 *
 * Run: node --import tsx src/scripts/test-harness-session.ts
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "easy-agent-harness-session-")));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
await Promise.all([
  mkdir(path.join(home, ".easy-agent"), { recursive: true }),
  mkdir(path.join(cwd, ".easy-agent"), { recursive: true }),
]);
for (const key of Object.keys(process.env)) {
  if (/^(?:ANTHROPIC_|EASY_AGENT_|CLAUDE_CODE_)/.test(key) || /TOOL_SEARCH|THINKING/.test(key)) delete process.env[key];
}
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.EASY_AGENT_DISABLE_HOOKS = "1";
process.env.ANTHROPIC_MODEL = "claude-test-model";
process.chdir(cwd);

const sdk = await import("../sdk/index.js");
const storage = await import("../session/storage.js");
const { resetSettingsCache } = await import("../config/sources.js");
const { trustProject, untrustProject } = await import("../config/globalState.js");
const { HARNESS_KEYS } = await import("../harness/keys.js");
const { AgentSdkError } = sdk;
type AgentRuntime = import("../sdk/index.js").AgentRuntime;
type HarnessTarget = import("../sdk/index.js").HarnessTarget;

const userSettings = path.join(home, ".easy-agent", "settings.json");
const localSettings = path.join(cwd, ".easy-agent", "settings.local.json");
const writeJson = (file: string, value: unknown) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

async function setAgents(harnesses: Record<string, unknown>): Promise<void> {
  await writeJson(userSettings, { harnesses });
  resetSettingsCache();
}

const warnings: string[] = [];
async function withRuntime<T>(harness: HarnessTarget | undefined, fn: (runtime: AgentRuntime) => Promise<T>) {
  const runtime = await sdk.createAgentRuntime({
    cwd,
    services: false,
    logger: { warn: (message) => warnings.push(message), error() {} },
    ...(harness ? { harness } : {}),
  });
  try {
    return await fn(runtime);
  } finally {
    await runtime.dispose();
  }
}

/** Create a saved session in a runtime running `harness`, and return its id. */
const saveSession = (harness?: HarnessTarget) =>
  withRuntime(harness, async (runtime) => {
    const session = await runtime.createSession();
    await session.close();
    return session.id;
  });

async function transcriptOf(sessionId: string): Promise<Record<string, unknown>[]> {
  const { transcriptPath } = await storage.getSessionPaths(cwd, sessionId);
  return (await readFile(transcriptPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const metaRecords = async (sessionId: string) =>
  (await transcriptOf(sessionId)).filter((entry) => entry.type === "session_meta");

/** Open a saved session in a runtime started with `harness` and return its check and the runtime's Agent. */
const reopen = (sessionId: string, harness: HarnessTarget = { session: sessionId }) =>
  withRuntime(harness, async (runtime) => {
    const agent = await runtime.getHarness();
    const session = await runtime.resumeSession(sessionId);
    await session.close();
    return { agent, check: session.harnessCheck! };
  });

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("Sessions remember their Agent");

try {
  await check("a new session records its Agent; listSessions and readSession show it", async () => {
    await setAgents({});
    let hash = "";
    const sessionId = await withRuntime(undefined, async (runtime) => {
      hash = (await runtime.getHarness()).hash;
      const session = await runtime.createSession();
      await session.close();
      const [listed] = await runtime.listSessions();
      assert.deepEqual(listed?.harness, { name: "default", hash });
      assert.deepEqual((await runtime.readSession(session.id)).summary.harness, { name: "default", hash });
      return session.id;
    });
    const [meta, ...more] = await metaRecords(sessionId);
    assert.equal(more.length, 0);
    const recorded = meta!.harness as { name: string; hash: string; keys: Record<string, string> };
    assert.equal(recorded.name, "default");
    assert.equal(recorded.hash, hash);
    assert.deepEqual(Object.keys(recorded.keys).sort(), HARNESS_KEYS.map((key) => key.path).sort());
    assert.ok(Object.values(recorded.keys).every((digest) => /^[0-9a-f]{12}$/.test(digest)));
  });

  await check("the record keeps the fields earlier versions read and adds nothing they reject", async () => {
    await setAgents({ reviewer: { outputStyle: "Concise" } });
    const sessionId = await saveSession({ name: "reviewer" });
    // A version without Agents needs these fields and types on the first record and ignores extra fields.
    const [meta] = await transcriptOf(sessionId);
    assert.equal(meta!.type, "session_meta");
    for (const field of ["sessionId", "cwd", "startedAt", "model"]) assert.equal(typeof meta![field], "string", field);
    await setAgents({});
    await reopen(sessionId, {});
    // The second record a resume appends is a session_meta too, with the first one's fields.
    const metas = await metaRecords(sessionId);
    assert.equal(metas.length, 2);
    const strip = ({ harness: _harness, ...rest }: Record<string, unknown>) => rest;
    assert.deepEqual(strip(metas[1]!), strip(metas[0]!));
    assert.deepEqual(
      [...new Set((await transcriptOf(sessionId)).map((entry) => entry.type))].sort(),
      ["session_meta"],
      "no record type earlier versions do not know",
    );
  });

  await check(
    "a session saved before Agents were recorded counts as default, even over the workspace default",
    async () => {
      await setAgents({ reviewer: { outputStyle: "Concise" } });
      const sessionId = storage.createSessionId();
      const startedAt = new Date().toISOString();
      await storage.initSessionStorage({ sessionId, cwd, startedAt, updatedAt: startedAt, model: "old-model" });
      await storage.appendTranscriptEntry(cwd, sessionId, {
        type: "message",
        timestamp: startedAt,
        role: "user",
        message: { role: "user", content: "hello from an old version" },
      });
      assert.equal(Object.hasOwn((await metaRecords(sessionId))[0]!, "harness"), false);
      await withRuntime(undefined, async (runtime) => {
        const listed = (await runtime.listSessions()).find((session) => session.sessionId === sessionId);
        assert.deepEqual(listed?.harness, { name: "default" });
      });

      await writeJson(localSettings, { harness: "reviewer" });
      await trustProject(cwd);
      try {
        const { agent, check: result } = await reopen(sessionId);
        assert.equal(agent.name, "default", "not the workspace default");
        assert.deepEqual(agent.selectedBy, { source: "session", sessionId });
        assert.deepEqual(
          { status: result.status, message: result.message, recorded: result.recorded },
          { status: "same", message: undefined, recorded: { name: "default" } },
        );
        const [, bound] = await metaRecords(sessionId);
        assert.equal((bound!.harness as { name: string }).name, "default", "the resume records the Agent");
        assert.equal((await withRuntime(undefined, (runtime) => runtime.getHarness())).name, "reviewer");
      } finally {
        await untrustProject(cwd);
        await rm(localSettings, { force: true });
      }
    },
  );

  await check("an unchanged Agent reopens the session as it was, without a new record", async () => {
    await setAgents({ reviewer: { outputStyle: "Concise", permissions: { deny: ["Bash"] } } });
    const sessionId = await saveSession({ name: "reviewer" });
    const { agent, check: result } = await reopen(sessionId);
    assert.equal(agent.name, "reviewer");
    assert.deepEqual(agent.selectedBy, { source: "session", sessionId });
    assert.equal(result.status, "same");
    assert.equal(result.recorded.hash, result.current.hash);
    assert.equal(result.message, undefined);
    assert.equal((await metaRecords(sessionId)).length, 1);
  });

  await check("a changed Agent reopens the session and names the settings that changed, once", async () => {
    await setAgents({ reviewer: { outputStyle: "Concise", permissions: { deny: ["Bash"] } } });
    const sessionId = await saveSession({ name: "reviewer" });
    await setAgents({ reviewer: { outputStyle: "Learning", permissions: { deny: ["Bash", "Write"] } } });
    const { agent, check: result } = await reopen(sessionId);
    assert.equal(agent.name, "reviewer");
    assert.equal(result.status, "changed");
    assert.deepEqual(result.changed, ["permissions.deny", "outputStyle"]);
    assert.notEqual(result.recorded.hash, result.current.hash);
    assert.equal(
      result.message,
      'Agent "reviewer" has changed since this session last ran: permissions.deny, outputStyle.',
    );
    assert.equal((await metaRecords(sessionId)).length, 2);
    assert.equal((await reopen(sessionId)).check.status, "same", "the next resume compares with the new record");
  });

  await check("a deleted Agent falls back to default with a warning", async () => {
    await setAgents({ reviewer: { outputStyle: "Concise" } });
    const sessionId = await saveSession({ name: "reviewer" });
    await setAgents({});
    warnings.length = 0;
    const { agent, check: result } = await reopen(sessionId);
    assert.equal(agent.name, "default");
    assert.deepEqual(agent.selectedBy, { source: "session", sessionId });
    assert.match(
      warnings.join("\n"),
      new RegExp(`The Agent "reviewer" session ${sessionId} last ran with no longer exists; using default`),
    );
    assert.equal(result.status, "deleted");
    assert.equal(
      result.message,
      'This session last ran with Agent "reviewer", which no longer exists; it continues with Agent "default".',
    );
    const { check: again } = await reopen(sessionId);
    assert.equal(again.status, "same", "it now runs with default");
  });

  await check("another Agent selected explicitly runs the session and says which one it last ran with", async () => {
    await setAgents({ reviewer: { outputStyle: "Concise" }, writer: { outputStyle: "Learning" } });
    const sessionId = await saveSession({ name: "reviewer" });
    const { agent, check: result } = await reopen(sessionId, { name: "writer" });
    assert.equal(agent.name, "writer");
    assert.equal(result.status, "other");
    assert.equal(
      result.message,
      'This session last ran with Agent "reviewer"; it continues with Agent "writer", the Agent this runtime runs.',
    );
    assert.equal(
      (await withRuntime(undefined, (runtime) => runtime.readSession(sessionId))).summary.harness.name,
      "writer",
    );
  });

  await check("a spec passed directly is recorded as (inline) and falls back to default", async () => {
    await setAgents({});
    const sessionId = await saveSession({ spec: { outputStyle: "Concise" } });
    assert.equal(
      (await withRuntime(undefined, (runtime) => runtime.readSession(sessionId))).summary.harness.name,
      "(inline)",
    );
    warnings.length = 0;
    const { agent, check: result } = await reopen(sessionId);
    assert.equal(agent.name, "default");
    assert.match(warnings.join("\n"), /last ran with a spec passed directly; using default/);
    assert.equal(result.status, "deleted");
    assert.match(result.message ?? "", /last ran with a spec passed directly, which no longer exists/);
  });

  await check("session: true picks the latest session; an unreadable one selects nothing", async () => {
    await setAgents({ reviewer: { outputStyle: "Concise" } });
    const sessionId = await saveSession({ name: "reviewer" });
    await withRuntime({ session: true }, async (runtime) => {
      const agent = await runtime.getHarness();
      assert.deepEqual([agent.name, agent.selectedBy], ["reviewer", { source: "session", sessionId }]);
    });
    for (const missing of ["00000000-0000-0000-0000-000000000000", "../not-an-id"]) {
      await withRuntime({ session: missing }, async (runtime) => {
        const agent = await runtime.getHarness();
        assert.deepEqual([agent.name, agent.selectedBy], ["default", undefined]);
        await assert.rejects(runtime.resumeSession(missing), (error: unknown) => error instanceof AgentSdkError);
      });
    }
    await assert.rejects(
      sdk.createAgentRuntime({ cwd, services: false, harness: { name: "reviewer", session: sessionId } }),
      (error: unknown) => error instanceof AgentSdkError && error.code === "invalid_argument",
    );
  });

  await check("the Agent a session last ran with must still resolve", async () => {
    await setAgents({ reviewer: { outputStyle: "Concise" }, base: {} });
    const sessionId = await withRuntime({ name: "reviewer" }, async (runtime) => {
      const session = await runtime.createSession();
      await session.close();
      return session.id;
    });
    await setAgents({ reviewer: { extends: "missing" } });
    await assert.rejects(
      sdk.createAgentRuntime({ cwd, services: false, harness: { session: sessionId } }),
      (error: unknown) =>
        error instanceof AgentSdkError &&
        error.code === "harness" &&
        new RegExp(`The Agent "reviewer" session ${sessionId} last ran with does not resolve`).test(error.message),
    );
  });

  await check(
    "a fork keeps the Agent its source last ran with; a session that is not saved records nothing",
    async () => {
      await setAgents({ reviewer: { outputStyle: "Concise" } });
      const sessionId = await saveSession({ name: "reviewer" });
      await withRuntime(undefined, async (runtime) => {
        const fork = await runtime.forkSession(sessionId);
        assert.equal(fork.harness.name, "reviewer");
        assert.deepEqual(
          (await metaRecords(fork.sessionId))[0]!.harness,
          (await metaRecords(sessionId))[0]!.harness,
          "the whole record, digests included",
        );
        const session = await runtime.resumeSession(sessionId, { persist: false });
        assert.equal(session.harnessCheck?.status, "other");
        await session.close();
      });
      assert.equal((await metaRecords(sessionId)).length, 1, "persist: false leaves the transcript alone");
    },
  );

  await check("/resume reports the Agent the session last ran with and records the runtime's", async () => {
    await setAgents({ reviewer: { outputStyle: "Concise" } });
    const target = await saveSession({ name: "reviewer" });
    await withRuntime(undefined, async (runtime) => {
      const session = await runtime.createSession();
      const notices: string[] = [];
      session.subscribe((event) => {
        if (event.type === "notice") notices.push(event.body);
      });
      await session.runCommand("resume", [target]);
      const current = runtime.getSession(target)!;
      assert.match(
        notices.at(-1) ?? "",
        /This session last ran with Agent "reviewer"; it continues with Agent "default"/,
      );
      assert.match(notices.at(-1) ?? "", new RegExp(`restart with eagent --resume ${target} --harness reviewer`));
      await current.close();
    });
    assert.equal(
      (await withRuntime(undefined, (runtime) => runtime.readSession(target))).summary.harness.name,
      "default",
    );
  });
} finally {
  // Windows cannot remove the process's current directory.
  process.chdir(os.tmpdir());
  await rm(root, { recursive: true, force: true });
}

console.log(`\n${passed} session Agent checks passed.`);
