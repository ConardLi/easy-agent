/**
 * Session SDK contract tests.
 *
 * Drives `AgentRuntime` / `AgentSession` directly (no terminal UI) against a
 * scripted Anthropic fixture and checks:
 *   - turn and event semantics, and the interaction request lifecycle;
 *   - plan approval follow-ups and the `busy` guard;
 *   - security boundaries: deny rules, safe defaults without a frontend,
 *     and workspace trust;
 *   - isolation of two sessions sharing one process;
 *   - `/resume` replacing the session handle.
 *
 * Run: node --import tsx src/scripts/test-sdk-session.ts
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "easy-agent-sdk-")));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
await Promise.all([
  mkdir(path.join(home, ".easy-agent"), { recursive: true }),
  mkdir(path.join(cwd, ".easy-agent"), { recursive: true }),
]);
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.EASY_AGENT_DISABLE_HOOKS = "1";
process.env.EASY_AGENT_ENABLE_TOOL_SEARCH = "false";
process.chdir(cwd);
// A user-level deny rule the SDK must never let a handler override.
await writeFile(path.join(home, ".easy-agent", "settings.json"), JSON.stringify({ deny: ["WebFetch"] }));
// Project config that only applies once the workspace is trusted.
await writeFile(path.join(cwd, ".easy-agent", "settings.json"), JSON.stringify({ allow: ["Write"] }));

const { createAnthropicFixture, FIXTURE_MODEL } = await import("./fixtures/anthropicFixture.js");
const fixture = createAnthropicFixture();
await fixture.start();

const sdk = await import("../sdk/index.js");
const { runInScopeOf } = await import("../sdk/session.js");
const { getPlanFilePath, writePlan } = await import("../context/plans.js");
const { enqueuePendingNotification } = await import("../state/notificationStore.js");
const { getSessionPaths } = await import("../session/storage.js");
type AgentRuntime = import("../sdk/index.js").AgentRuntime;
type AgentSession = import("../sdk/index.js").AgentSession;
type SessionEvent = import("../sdk/index.js").SessionEvent;

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(label: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await sleep(5);
  }
}

/** Record every event of a session. */
function record(session: AgentSession): SessionEvent[] {
  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  return events;
}

const types = (events: SessionEvent[], ...wanted: SessionEvent["type"][]) =>
  events.filter((event) => wanted.includes(event.type)).map((event) => event.type);

const opened = (events: SessionEvent[]) =>
  events.flatMap((event) => (event.type === "request_opened" ? [event.request] : []));

async function transcriptTypes(sessionId: string): Promise<string[]> {
  const { transcriptPath } = await getSessionPaths(cwd, sessionId);
  return (await readFile(transcriptPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const entry = JSON.parse(line) as { type: string; role?: string; phase?: string };
      return entry.type === "message"
        ? `message:${entry.role}`
        : entry.phase
          ? `${entry.type}:${entry.phase}`
          : entry.type;
    });
}

let runtime: AgentRuntime = await sdk.createAgentRuntime({ cwd, services: false, logger: { warn() {}, error() {} } });

try {
  console.log("\n[1] runtime");

  await check("a second runtime in the same process is rejected", async () => {
    await assert.rejects(sdk.createAgentRuntime({ cwd, services: false }), (error: unknown) =>
      sdk.isAgentSdkError(error, "runtime_active"),
    );
  });

  await check("capabilities list built-in commands and agents", async () => {
    const capabilities = runtime.getCapabilities();
    assert.ok(capabilities.builtinCommands.includes("help"));
    assert.deepEqual(capabilities.builtinCommands, [...capabilities.builtinCommands].sort());
    assert.ok(capabilities.agents.length > 0);
  });

  console.log("\n[2] turns and events");

  await check("a text turn streams, records, and reports its result", async () => {
    const session = await runtime.createSession({ model: FIXTURE_MODEL });
    const events = record(session);
    assert.equal(events[0]?.type, "state_snapshot", "subscribers start with a snapshot");
    fixture.script([{ kind: "text", text: "Hello there." }]);
    const result = await session.send("Say hello.");
    assert.equal(result.handled, true);
    assert.equal(result.reason, "completed");
    assert.equal(result.toolTurns, 1);
    assert.deepEqual(result.followUps, []);
    assert.deepEqual(types(events, "turn_started", "text_delta", "assistant_message", "turn_completed"), [
      "turn_started",
      "text_delta",
      "assistant_message",
      "turn_completed",
    ]);
    const seqs = events.slice(1).map((event) => event.seq);
    assert.deepEqual(
      seqs,
      seqs.map((_, i) => seqs[0]! + i),
      "sequence numbers are consecutive",
    );
    assert.ok(events.every((event) => event.sessionId === session.id));
    const state = session.getState();
    assert.equal(state.busy, false);
    assert.equal(state.messages.length, 2);
    assert.equal(state.usage.total.output_tokens, 5);
    assert.ok(state.usage.context && state.usage.context.window > 0);
    assert.deepEqual(await transcriptTypes(session.id), [
      "session_meta",
      "file_history_snapshot",
      "message:user",
      "message:assistant",
      "usage",
    ]);
    assert.doesNotThrow(() => JSON.stringify(events), "events are JSON-serializable");
    await session.close();
  });

  await check("empty input with nothing queued does nothing", async () => {
    const session = await runtime.createSession({ model: FIXTURE_MODEL });
    const before = fixture.requests.length;
    assert.deepEqual(await session.send("   "), { turnId: null, handled: false, followUps: [] });
    assert.equal(fixture.requests.length, before);
    await session.close();
  });

  await check("a permission request opens, is answered, and resolves", async () => {
    const session = await runtime.createSession({ model: FIXTURE_MODEL });
    const events = record(session);
    fixture.script([
      { kind: "tool", name: "Write", input: { file_path: "sdk-allowed.txt", content: "ok\n" } },
      { kind: "text", text: "Done." },
    ]);
    const done = session.send("Write a file.");
    await until("permission request", () => opened(events).length === 1);
    const [request] = opened(events);
    assert.equal(request?.kind, "permission");
    assert.deepEqual(session.getState().pendingRequests, [request]);
    assert.equal(session.respond(request!.id, { decision: "allow_once" }), "resolved");
    assert.equal(session.respond(request!.id, { decision: "allow_once" }), "stale");
    await done;
    assert.equal(await readFile(path.join(cwd, "sdk-allowed.txt"), "utf8"), "ok\n");
    const resolved = events.find((event) => event.type === "request_resolved");
    assert.ok(resolved?.type === "request_resolved" && resolved.resolution === "response");
    assert.deepEqual(session.getState().pendingRequests, []);
    await session.close();
  });

  await check("a response of the wrong kind is rejected", async () => {
    const session = await runtime.createSession({ model: FIXTURE_MODEL });
    const events = record(session);
    fixture.script([
      { kind: "tool", name: "Write", input: { file_path: "sdk-wrong.txt", content: "x" } },
      { kind: "text", text: "Done." },
    ]);
    const done = session.send("Write a file.");
    await until("permission request", () => opened(events).length === 1);
    const request = opened(events)[0]!;
    assert.throws(() => session.respond(request.id, { answers: {} }), TypeError);
    session.respond(request.id, { decision: "deny" });
    await done;
    await session.close();
  });

  await check("interrupting an open permission request denies it and ends the turn", async () => {
    const session = await runtime.createSession({ model: FIXTURE_MODEL });
    const events = record(session);
    fixture.script([{ kind: "tool", name: "Write", input: { file_path: "sdk-interrupted.txt", content: "x" } }]);
    const before = fixture.requests.length;
    const done = session.send("Write a file.");
    await until("permission request", () => opened(events).length === 1);
    assert.equal(session.interrupt(), "permission_denied");
    const result = await done;
    assert.equal(result.reason, "aborted");
    assert.equal(fixture.requests.length, before + 1, "the model is not called again");
    const messages = session.getState().messages;
    assert.match(JSON.stringify(messages.at(-1)), /Permission denied for Write/, "the tool call still gets a result");
    assert.equal(fixture.remaining(), 0);
    assert.equal(session.interrupt(), "idle");
    await session.close();
  });

  await check("interrupting an open question cancels it and ends the turn", async () => {
    const session = await runtime.createSession({ model: FIXTURE_MODEL });
    const events = record(session);
    fixture.script([
      {
        kind: "tool",
        name: "AskUserQuestion",
        input: { questions: [{ question: "Size?", header: "Size", options: [{ label: "S" }, { label: "L" }] }] },
      },
    ]);
    const done = session.send("Ask me.");
    await until("question", () => opened(events).length === 1);
    assert.equal(session.interrupt(), "question_cancelled");
    assert.equal((await done).reason, "aborted");
    const resolutions = events.flatMap((event) => (event.type === "request_resolved" ? [event.resolution] : []));
    assert.deepEqual(resolutions, ["interrupt"]);
    await session.close();
  });

  await check("interrupting while the model responds aborts the turn without an error", async () => {
    const session = await runtime.createSession({ model: FIXTURE_MODEL });
    const events = record(session);
    fixture.script([{ kind: "text", text: "Too late.", delayMs: 3_000 }]);
    const requests = fixture.requests.length;
    const done = session.send("Take your time.");
    await until("model request", () => fixture.requests.length > requests);
    assert.equal(session.interrupt(), "turn_aborted");
    assert.equal((await done).reason, "aborted");
    assert.ok(!events.some((event) => event.type === "error"), "an interrupt is not reported as a model error");
    await session.close();
  });

  await check("an interrupt right after send stops the turn before the model is called", async () => {
    const session = await runtime.createSession({ model: FIXTURE_MODEL });
    fixture.script([{ kind: "text", text: "Should not be requested." }]);
    const requests = fixture.requests.length;
    const done = session.send("Never mind.");
    assert.equal(session.interrupt(), "turn_aborted");
    assert.equal((await done).reason, "aborted");
    assert.equal(fixture.requests.length, requests, "no model request");
    fixture.script([{ kind: "text", text: "Next turn runs." }]);
    assert.equal((await session.send("Go on.")).reason, "completed", "the interrupt does not leak into the next turn");
    await session.close();
  });

  await check("a second send while a turn runs is rejected as busy, waitForIdle queues it", async () => {
    const session = await runtime.createSession({ model: FIXTURE_MODEL });
    const events = record(session);
    fixture.script([
      { kind: "tool", name: "Write", input: { file_path: "sdk-busy.txt", content: "x" } },
      { kind: "text", text: "First." },
      { kind: "text", text: "Second." },
    ]);
    const first = session.send("First.");
    await until("permission request", () => opened(events).length === 1);
    assert.equal(session.getState().busy, true);
    await assert.rejects(session.send("Second."), (error: unknown) => sdk.isAgentSdkError(error, "busy"));
    const queued = session.waitForIdle().then(() => session.send("Second."));
    session.respond(opened(events)[0]!.id, { decision: "deny" });
    await first;
    assert.equal((await queued).reason, "completed");
    await session.close();
  });

  await check("model, thinking, effort, and mode switch right away, also during a turn", async () => {
    const session = await runtime.createSession({ model: FIXTURE_MODEL });
    const events = record(session);
    fixture.script([{ kind: "text", text: "Slow.", delayMs: 300 }]);
    const running = session.send("Go.");
    await until("turn running", () => session.getState().busy);
    session.setModel("other-model");
    session.setThinking("off");
    session.setEffort("high");
    session.setPermissionMode("plan");
    let state = session.getState();
    assert.equal(state.busy, true, "the switches did not wait for the turn");
    await running;
    state = session.getState();
    assert.equal(state.model, "other-model");
    assert.equal(state.modelSource, "session");
    assert.deepEqual(state.thinking, { type: "disabled" });
    assert.equal(state.effort, "high");
    assert.equal(state.permissionMode, "plan");
    assert.deepEqual(types(events, "model_changed", "thinking_changed", "mode_changed"), [
      "model_changed",
      "thinking_changed",
      "thinking_changed",
      "mode_changed",
    ]);

    session.setModel("default");
    session.setPermissionMode("default");
    assert.equal(session.getState().modelSource, "default");
    await session.runCommand("effort", ["low"]);
    const last = events.filter((event) => event.type === "thinking_changed").at(-1);
    assert.equal(last?.type === "thinking_changed" && last.effort, "low", "/effort reports the change too");
    assert.throws(
      () => session.setThinking(0),
      (error: unknown) => sdk.isAgentSdkError(error, "invalid_argument"),
    );
    assert.throws(
      () => session.setModel(" "),
      (error: unknown) => sdk.isAgentSdkError(error, "invalid_argument"),
    );
    await session.close();
  });

  console.log("\n[3] plan approval");

  await check("approving with a context clear runs the implementation turn", async () => {
    const session = await runtime.createSession({ model: FIXTURE_MODEL, permissionMode: "plan" });
    const events = record(session);
    await runInScopeOf(session, () => writePlan("1. Ship it.\n"));
    fixture.script([
      { kind: "tool", name: "ExitPlanMode", input: { summary: "Ship it" } },
      { kind: "text", text: "Implementing." },
    ]);
    const done = session.send("Plan it.");
    await until("plan approval", () => opened(events).length === 1);
    const request = opened(events)[0]!;
    assert.equal(request.kind, "plan_approval");
    assert.ok(request.kind === "plan_approval" && request.planContent === "1. Ship it.\n");
    session.respond(request.id, { decision: "approve", clearContext: true });
    const result = await done;
    assert.equal(result.reason, "aborted", "the planning turn stops after ExitPlanMode");
    assert.equal(result.followUps.length, 1);
    assert.equal(result.followUps[0]?.reason, "completed");
    const sources = events.flatMap((event) => (event.type === "turn_started" ? [event.source] : []));
    assert.deepEqual(sources, ["user", "plan_followup"]);
    const completed = events.find((event) => event.type === "turn_completed");
    assert.ok(completed?.type === "turn_completed" && completed.continuation === "plan_followup");
    const last = fixture.requests.at(-1)!.messages as Array<{ content: unknown }>;
    assert.equal(last.length, 1);
    assert.match(JSON.stringify(last[0]!.content), /Implement the following plan/);
    assert.equal(session.getState().permissionMode, "default");
    await session.close();
  });

  await check("rejecting with feedback runs a revision turn", async () => {
    const session = await runtime.createSession({ model: FIXTURE_MODEL, permissionMode: "plan" });
    const events = record(session);
    fixture.script([
      { kind: "tool", name: "ExitPlanMode", input: { summary: "Ship it" } },
      { kind: "text", text: "Noted." },
      { kind: "text", text: "Revised." },
    ]);
    const done = session.send("Plan it.");
    await until("plan approval", () => opened(events).length === 1);
    session.respond(opened(events)[0]!.id, { decision: "reject", feedback: "Add tests." });
    const result = await done;
    assert.equal(result.followUps[0]?.reason, "completed");
    assert.match(JSON.stringify(fixture.requests.at(-1)!.messages), /User rejected the plan\. Feedback: Add tests\./);
    await session.close();
  });

  console.log("\n[4] security boundaries");

  await check("a deny rule holds even when a handler would allow everything", async () => {
    let handlerCalls = 0;
    const session = await runtime.createSession({
      model: FIXTURE_MODEL,
      handlers: {
        permission: () => {
          handlerCalls += 1;
          return { decision: "allow_once" };
        },
      },
    });
    const events = record(session);
    fixture.script([
      { kind: "tool", name: "WebFetch", input: { url: "https://example.com", prompt: "summarize" } },
      { kind: "text", text: "Blocked." },
    ]);
    await session.send("Fetch it.");
    assert.equal(handlerCalls, 0);
    assert.equal(opened(events).length, 0);
    const completed = events.find((event) => event.type === "tool_completed");
    assert.ok(completed?.type === "tool_completed" && completed.result.isError === true);
    await session.close();
  });

  await check("without a frontend or handler, asks are denied and questions cancelled", async () => {
    const session = await runtime.createSession({ model: FIXTURE_MODEL, interactions: [], persist: false });
    const events = record(session);
    fixture.script([
      { kind: "tool", name: "Write", input: { file_path: "sdk-denied.txt", content: "x" } },
      {
        kind: "tool",
        name: "AskUserQuestion",
        input: { questions: [{ question: "Size?", header: "Size", options: [{ label: "S" }, { label: "L" }] }] },
      },
      { kind: "text", text: "Done." },
    ]);
    await session.send("Do two things.");
    assert.equal(opened(events).length, 0, "nothing is published to a frontend that cannot answer");
    const results = events.flatMap((event) => (event.type === "tool_completed" ? [event] : []));
    assert.equal(results[0]?.result.isError, true);
    assert.match(String(results[1]?.result.content), /declined to answer/);
    await assert.rejects(readFile(path.join(cwd, "sdk-denied.txt")));
    await session.close();
  });

  await check("project allow rules are ignored until the workspace is trusted", async () => {
    const untrusted = await runtime.createSession({ model: FIXTURE_MODEL, interactions: [] });
    fixture.script([
      { kind: "tool", name: "Write", input: { file_path: "sdk-trust.txt", content: "x" } },
      { kind: "text", text: "Denied." },
    ]);
    await untrusted.send("Write it.");
    await assert.rejects(readFile(path.join(cwd, "sdk-trust.txt")), "an untrusted project cannot allow Write");
    await untrusted.close();

    await runtime.dispose();
    runtime = await sdk.createAgentRuntime({
      cwd,
      trust: "session",
      services: false,
      logger: { warn() {}, error() {} },
    });
    assert.equal(runtime.report.projectTrusted, true);
    const trusted = await runtime.createSession({ model: FIXTURE_MODEL, interactions: [] });
    fixture.script([
      { kind: "tool", name: "Write", input: { file_path: "sdk-trust.txt", content: "x" } },
      { kind: "text", text: "Written." },
    ]);
    await trusted.send("Write it.");
    assert.equal(await readFile(path.join(cwd, "sdk-trust.txt"), "utf8"), "x");
    await trusted.close();
  });

  console.log("\n[5] sessions sharing a process");

  await check("session state is isolated", async () => {
    const a = await runtime.createSession({ model: FIXTURE_MODEL });
    const b = await runtime.createSession({ model: FIXTURE_MODEL });
    await a.runCommand("think", ["off"]);
    await a.runCommand("effort", ["low"]);
    await a.runCommand("tasks", ["todo"]);
    assert.equal(a.getState().thinking.type, "disabled");
    assert.equal(a.getState().effort, "low");
    assert.equal(a.getState().taskMode, "todo");
    assert.notEqual(b.getState().thinking.type, "disabled");
    assert.equal(b.getState().effort, null);
    assert.equal(b.getState().taskMode, "task");
    assert.notEqual(
      runInScopeOf(a, () => getPlanFilePath()),
      runInScopeOf(b, () => getPlanFilePath()),
      "each session has its own plan file",
    );
    await Promise.all([a.close(), b.close()]);
  });

  await check("concurrent turns in two sessions keep separate transcripts", async () => {
    const a = await runtime.createSession({ model: FIXTURE_MODEL });
    const b = await runtime.createSession({ model: FIXTURE_MODEL });
    fixture.script([
      { kind: "text", text: "One." },
      { kind: "text", text: "Two." },
    ]);
    await Promise.all([a.send("From A."), b.send("From B.")]);
    const first = (s: AgentSession) => JSON.stringify(s.getState().messages[0]);
    assert.match(first(a), /From A\./);
    assert.match(first(b), /From B\./);
    assert.deepEqual(await transcriptTypes(a.id), await transcriptTypes(b.id));
    await Promise.all([a.close(), b.close()]);
  });

  await check("a background result wakes only the session that launched it", async () => {
    const a = await runtime.createSession({ model: FIXTURE_MODEL });
    const b = await runtime.createSession({ model: FIXTURE_MODEL });
    const eventsA = record(a);
    const eventsB = record(b);
    fixture.script([{ kind: "text", text: "Saw the result." }]);
    runInScopeOf(a, () => enqueuePendingNotification({ mode: "task-notification", text: "<task-notification/>" }));
    await until("wake-up turn", () => types(eventsA, "turn_completed").length === 1);
    const started = eventsA.find((event) => event.type === "turn_started");
    assert.ok(started?.type === "turn_started" && started.source === "background");
    await sleep(50);
    assert.equal(types(eventsB, "turn_started").length, 0);
    await Promise.all([a.close(), b.close()]);
  });

  console.log("\n[6] transcript and resume");

  await check("resume restores the conversation the model saw, hidden messages included", async () => {
    const session = await runtime.createSession({ model: FIXTURE_MODEL, permissionMode: "plan" });
    fixture.script([{ kind: "text", text: "Here is a plan." }]);
    await session.send("Plan something.");
    const seen = session.getState().messages;
    assert.match(JSON.stringify(seen[0]), /plan_mode_attachment/, "plan mode adds a hidden reminder");
    const id = session.id;
    await session.close();
    const resumed = await runtime.resumeSession(id);
    assert.deepEqual(resumed.getState().messages, seen);
    await resumed.close();
  });

  await check("a background wake-up turn is restored with the notification that started it", async () => {
    const session = await runtime.createSession({ model: FIXTURE_MODEL });
    const events = record(session);
    fixture.script([{ kind: "text", text: "Noted." }]);
    runInScopeOf(session, () =>
      enqueuePendingNotification({ mode: "task-notification", text: "<task-notification/>" }),
    );
    await until("wake-up turn", () => types(events, "turn_completed").length === 1);
    const id = session.id;
    await session.close();
    const resumed = await runtime.resumeSession(id);
    const messages = resumed.getState().messages;
    assert.equal(messages.length, 2);
    assert.match(JSON.stringify(messages[0]), /\[task-notification\]/);
    await resumed.close();
  });

  await check("/clear is recorded, so resume starts after it", async () => {
    const session = await runtime.createSession({ model: FIXTURE_MODEL });
    fixture.script([
      { kind: "text", text: "Before." },
      { kind: "text", text: "After." },
    ]);
    await session.send("First topic.");
    await session.runCommand("clear");
    await session.send("Second topic.");
    const id = session.id;
    await session.close();
    const resumed = await runtime.resumeSession(id);
    const messages = resumed.getState().messages;
    assert.equal(messages.length, 2);
    assert.match(JSON.stringify(messages[0]), /Second topic\./);
    await resumed.close();
  });

  await check("a plan implemented in a fresh context resumes from the implementation turn", async () => {
    const session = await runtime.createSession({ model: FIXTURE_MODEL, permissionMode: "plan" });
    const events = record(session);
    await runInScopeOf(session, () => writePlan("1. Ship it.\n"));
    fixture.script([
      { kind: "tool", name: "ExitPlanMode", input: { summary: "Ship it" } },
      { kind: "text", text: "Implementing." },
    ]);
    const done = session.send("Plan it.");
    await until("plan approval", () => opened(events).length === 1);
    session.respond(opened(events)[0]!.id, { decision: "approve", clearContext: true });
    await done;
    const id = session.id;
    await session.close();
    const resumed = await runtime.resumeSession(id);
    const messages = resumed.getState().messages;
    assert.equal(messages.length, 2);
    assert.match(JSON.stringify(messages[0]), /Implement the following plan/);
    await resumed.close();
  });

  await check("a session that does not persist leaves no transcript", async () => {
    const session = await runtime.createSession({ model: FIXTURE_MODEL, persist: false });
    fixture.script([{ kind: "text", text: "Ephemeral." }]);
    await session.send("Hello.");
    const { transcriptPath, latestPath } = await getSessionPaths(cwd, session.id);
    await assert.rejects(readFile(transcriptPath));
    assert.notEqual((await readFile(latestPath, "utf8").catch(() => "")).trim(), session.id);
    assert.notEqual((await readFile(latestPath, "utf8").catch(() => "")).trim(), "default");
    await session.close();
  });

  await check("a permission request names the tool call it guards", async () => {
    const session = await runtime.createSession({ model: FIXTURE_MODEL });
    const events = record(session);
    fixture.script([
      // The trusted project allows Write, so use a tool it still asks about.
      { kind: "tool", name: "Edit", input: { file_path: "sdk-allowed.txt", old_string: "ok", new_string: "x" } },
      { kind: "text", text: "Denied." },
    ]);
    const done = session.send("Write it.");
    await until("permission request", () => opened(events).length === 1);
    const request = opened(events)[0]!;
    const started = events.find((event) => event.type === "tool_started");
    assert.ok(request.kind === "permission" && started?.type === "tool_started");
    assert.equal(request.toolUseId, started.toolUseId);
    session.respond(request.id, { decision: "deny" });
    await done;
    await session.close();
  });

  await check("saved sessions can be renamed, forked, and deleted", async () => {
    const session = await runtime.createSession({ model: FIXTURE_MODEL, permissionMode: "plan" });
    fixture.script([{ kind: "text", text: "Planned." }]);
    await session.send("Plan the work.");
    const id = session.id;
    await assert.rejects(runtime.deleteSession(id), (error: unknown) => sdk.isAgentSdkError(error, "already_open"));
    await session.close();

    const summary = (await runtime.listSessions()).find((entry) => entry.sessionId === id)!;
    assert.equal(summary.firstPrompt, "Plan the work.", "hidden plan-mode context is not the label");
    assert.equal((await runtime.renameSession(id, "  Work plan  ")).title, "Work plan");
    assert.equal((await runtime.listSessions()).find((entry) => entry.sessionId === id)?.title, "Work plan");
    assert.equal((await runtime.renameSession(id, "")).title, undefined);

    const fork = await runtime.forkSession(id, { title: "Alternative" });
    assert.notEqual(fork.sessionId, id);
    assert.equal(fork.title, "Alternative");
    assert.deepEqual((await runtime.readSession(fork.sessionId)).messages, (await runtime.readSession(id)).messages);
    const forked = await runtime.resumeSession(fork.sessionId, { model: FIXTURE_MODEL });
    fixture.script([{ kind: "text", text: "Diverged." }]);
    await forked.send("Go another way.");
    await forked.close();
    assert.equal((await runtime.readSession(id)).messages.length, 3, "the original is unchanged");

    const { latestPath } = await getSessionPaths(cwd, fork.sessionId);
    assert.equal((await readFile(latestPath, "utf8")).trim(), fork.sessionId);
    await mkdir(path.join(home, ".easy-agent", "file-history", fork.sessionId), { recursive: true });
    await runtime.deleteSession(fork.sessionId);
    await assert.rejects(runtime.readSession(fork.sessionId), (error: unknown) =>
      sdk.isAgentSdkError(error, "not_found"),
    );
    await assert.rejects(readFile(path.join(home, ".easy-agent", "file-history", fork.sessionId)));
    assert.notEqual(
      (await readFile(latestPath, "utf8")).trim(),
      fork.sessionId,
      "latest moves off the deleted session",
    );
    await assert.rejects(runtime.deleteSession(fork.sessionId), (error: unknown) =>
      sdk.isAgentSdkError(error, "not_found"),
    );
  });

  await check("session ids from callers never reach a path unchecked", async () => {
    for (const bad of ["../escape", "a/b", "", ".hidden"]) {
      await assert.rejects(runtime.readSession(bad), (error: unknown) =>
        sdk.isAgentSdkError(error, "invalid_argument"),
      );
      await assert.rejects(runtime.deleteSession(bad), (error: unknown) =>
        sdk.isAgentSdkError(error, "invalid_argument"),
      );
      await assert.rejects(runtime.renameSession(bad, "x"), (error: unknown) =>
        sdk.isAgentSdkError(error, "invalid_argument"),
      );
    }
  });

  console.log("\n[7] lifecycle");

  await check("/resume hands out a new session handle", async () => {
    const saved = await runtime.createSession({ model: FIXTURE_MODEL });
    fixture.script([{ kind: "text", text: "Saved." }]);
    await saved.send("Remember this.");
    const savedId = saved.id;
    await saved.close();

    const session = await runtime.createSession({ model: FIXTURE_MODEL });
    const events = record(session);
    await session.send(`/resume ${savedId}`);
    const replaced = events.find((event) => event.type === "session_replaced");
    assert.ok(replaced?.type === "session_replaced" && replaced.sessionId === savedId);
    assert.equal(session.replacedBy, savedId);
    await assert.rejects(session.send("Hi"), (error: unknown) => sdk.isAgentSdkError(error, "replaced"));
    const successor = runtime.getSession(savedId);
    assert.ok(successor);
    assert.equal(successor.getState().messages.length, 2);
    fixture.script([{ kind: "text", text: "Still here." }]);
    await successor.send("Continue.");
    assert.equal(events.at(-1)?.sessionId, savedId, "the original subscription follows the conversation");
    await successor.close();
  });

  await check("closing ends event streams and rejects new turns", async () => {
    const session = await runtime.createSession({ model: FIXTURE_MODEL });
    const stream = session.events();
    const first = await stream.next();
    assert.equal(first.value?.type, "state_snapshot");
    await session.close();
    assert.equal((await stream.next()).done, true);
    await assert.rejects(session.send("Hi"), (error: unknown) => sdk.isAgentSdkError(error, "closed"));
    assert.equal(runtime.getSession(session.id), undefined);
  });
} finally {
  await runtime.dispose();
  await fixture.close();
  process.chdir(os.tmpdir());
  await rm(root, { recursive: true, force: true });
}

console.log(`\nSession SDK: ${passed} passed, 0 failed.`);
process.exit(0);
