import { expect, test } from "@playwright/test";
import { applyEvent, blocksOf, type SessionView, viewFromState } from "../../src/renderer/agent/projector/session";
import type { SessionEvent, SessionState } from "../../src/shared/agent";

const SESSION = "s1";

function state(patch: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: SESSION,
    cwd: "/work/demo",
    busy: false,
    turnId: null,
    model: "fixture-model",
    modelSource: "default",
    permissionMode: "default",
    taskMode: "todo",
    thinking: { type: "adaptive" },
    effort: null,
    messages: [],
    usage: { total: { input_tokens: 0, output_tokens: 0 }, turn: null, lastCall: null, context: null },
    pendingRequests: [],
    todos: [],
    tasks: [],
    backgroundAgents: [],
    ...patch,
  } as SessionState;
}

/** Apply event bodies in order, numbering them like the SDK does. */
function run(view: SessionView, bodies: Record<string, unknown>[]): SessionView {
  let seq = view.seq;
  return bodies.reduce((v, body) => applyEvent(v, { sessionId: SESSION, seq: ++seq, ...body } as SessionEvent, 1000 + seq * 10), view);
}

const start = () => viewFromState("w1", state(), 0);
const user = (text: string) => ({ role: "user", content: text });

test("a streamed reply shows live and is replaced by the committed message", () => {
  let view = run(start(), [
    { type: "turn_started", turnId: "t1", input: "hi", source: "user", runsModel: true },
    { type: "messages_changed", messages: [user("hi")] },
    { type: "text_delta", text: "Hel" },
    { type: "text_delta", text: "lo" },
  ]);
  expect(blocksOf(view).map((b) => [b.kind, "text" in b ? b.text : ""])).toEqual([
    ["user", "hi"],
    ["assistant", "Hello"],
  ]);
  expect(blocksOf(view)[1]).toMatchObject({ streaming: true });

  view = run(view, [
    { type: "messages_changed", messages: [user("hi"), { role: "assistant", content: [{ type: "text", text: "Hello" }] }] },
    { type: "turn_completed", turnId: "t1", handled: true, reason: "completed" },
  ]);
  const blocks = blocksOf(view);
  expect(blocks).toHaveLength(2);
  expect(blocks[1]).toMatchObject({ kind: "assistant", text: "Hello" });
  expect(blocks[1]).not.toHaveProperty("streaming");
  expect(view.busy).toBe(false);
});

test("duplicate and stale events are ignored", () => {
  const view = run(start(), [{ type: "text_delta", text: "a" }]);
  const again = applyEvent(view, { sessionId: SESSION, seq: view.seq, type: "text_delta", text: "a" } as SessionEvent);
  expect(again).toBe(view);
});

test("a tool call shows its input, live output, and result", () => {
  let view = run(start(), [
    { type: "turn_started", turnId: "t1", input: "run", source: "user", runsModel: true },
    { type: "messages_changed", messages: [user("run")] },
    { type: "tool_started", toolUseId: "tu1", name: "Bash" },
  ]);
  expect(blocksOf(view).at(-1)).toMatchObject({ kind: "tool", tool: { name: "Bash", status: "running" } });

  const assistant = { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "npm test" } }] };
  view = run(view, [
    { type: "messages_changed", messages: [user("run"), assistant] },
    {
      type: "tool_progress",
      toolUseId: "tu1",
      progress: { kind: "bash", progress: { output: "running…", totalLines: 1, totalBytes: 8, startTime: 0, done: false } },
    },
  ]);
  expect(blocksOf(view).at(-1)).toMatchObject({ kind: "tool", tool: { target: "npm test", status: "running", output: "running…" } });

  view = run(view, [
    { type: "tool_completed", toolUseId: "tu1", name: "Bash", input: { command: "npm test" }, result: { content: "ok" } },
    {
      type: "messages_changed",
      messages: [user("run"), assistant, { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] }],
    },
    { type: "turn_completed", turnId: "t1", handled: true, reason: "completed" },
  ]);
  const tool = blocksOf(view).find((b) => b.kind === "tool");
  expect(tool).toMatchObject({ tool: { status: "success", output: "ok" } });
  expect(tool?.kind === "tool" && tool.tool.durationMs).toBeGreaterThan(0);
});

test("denied and unfinished calls get their own status", () => {
  const messages = [
    user("go"),
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "a", name: "Write", input: { file_path: "/work/demo/x.ts", content: "one\ntwo" } },
        { type: "tool_use", id: "b", name: "Edit", input: { file_path: "/work/demo/y.ts", old_string: "a\nb\nc", new_string: "a\nB\nc" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "Permission denied for Write.", is_error: true }] },
  ];
  const tools = blocksOf(viewFromState("w1", state({ messages: messages as SessionState["messages"] }), 0)).filter((b) => b.kind === "tool");
  expect(tools[0]).toMatchObject({ tool: { name: "Write", status: "denied", target: "x.ts", added: 2, removed: 0 } });
  expect(tools[1]).toMatchObject({ tool: { name: "Edit", status: "interrupted", added: 1, removed: 1 } });
  expect(tools[1]?.kind === "tool" && tools[1].tool.diff?.map((l) => l.type)).toEqual(["ctx", "del", "add", "ctx"]);
});

test("context the Agent adds is hidden and command markers show what was typed", () => {
  const messages = [
    user("[session-start]\nhook output"),
    user("<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>src</command-args>"),
    user("[skill_invocation:review]\nRun skill…"),
    user("[user-context]\nsome context\n\nreal question"),
  ];
  const blocks = blocksOf(viewFromState("w1", state({ messages: messages as SessionState["messages"] }), 0));
  expect(blocks.map((b) => (b.kind === "user" ? b.text : b.kind))).toEqual(["/review src", "real question"]);
});

test("notices sit where they happened, and clearing keeps the old conversation visible", () => {
  let view = run(start(), [
    { type: "messages_changed", messages: [user("one"), { role: "assistant", content: "first" }] },
    { type: "mode_changed", mode: "plan", previousMode: "default" },
    { type: "messages_changed", messages: [user("one"), { role: "assistant", content: "first" }, user("two")] },
  ]);
  expect(blocksOf(view).map((b) => b.kind)).toEqual(["user", "assistant", "notice", "user"]);
  expect(view.permissionMode).toBe("plan");

  view = run(view, [{ type: "session_cleared" }, { type: "messages_changed", messages: [] }, { type: "messages_changed", messages: [user("three")] }]);
  const texts = blocksOf(view).map((b) => (b.kind === "notice" ? b.text : b.kind === "user" ? b.text : b.kind));
  expect(texts).toEqual(["one", "assistant", "已切换到计划模式", "two", "上下文已清空", "three"]);
});

test("output of the picker commands is replaced by a notice of the change", () => {
  const view = run(start(), [
    { type: "turn_started", turnId: "t1", input: "/model other", source: "user", runsModel: false },
    { type: "command_output", kind: "info", message: "Switched model to other" },
    { type: "model_changed", model: "other", source: "session" },
    { type: "turn_completed", turnId: "t1", handled: true },
    { type: "turn_started", turnId: "t2", input: "/cost", source: "user", runsModel: false },
    { type: "command_output", kind: "info", message: "Total cost: $0" },
    { type: "turn_completed", turnId: "t2", handled: true },
  ]);
  expect(blocksOf(view)).toEqual([
    expect.objectContaining({ kind: "notice", icon: "model", text: "模型已切换为 other" }),
    expect.objectContaining({ kind: "notice", icon: "command", text: "/cost", detail: "Total cost: $0" }),
  ]);
  expect(view.model).toBe("other");
});

test("an interrupted reply keeps its partial text and says it was interrupted", () => {
  const view = run(start(), [
    { type: "turn_started", turnId: "t1", input: "go", source: "user", runsModel: true },
    { type: "messages_changed", messages: [user("go")] },
    { type: "text_delta", text: "partial" },
    { type: "turn_completed", turnId: "t1", handled: true, reason: "aborted" },
  ]);
  expect(blocksOf(view).map((b) => [b.kind, "text" in b ? b.text : ""])).toEqual([
    ["user", "go"],
    ["assistant", "partial"],
    ["notice", "已中断"],
  ]);
});

test("a state snapshot replaces the view, also from a restarted process", () => {
  const view = run(start(), [{ type: "text_delta", text: "x" }]);
  const restarted = applyEvent(view, {
    sessionId: SESSION,
    seq: 0,
    type: "state_snapshot",
    state: state({ messages: [user("saved")] as SessionState["messages"] }),
  } as SessionEvent);
  expect(restarted.seq).toBe(0);
  expect(blocksOf(restarted).map((b) => b.kind)).toEqual(["user"]);
  const next = applyEvent(restarted, { sessionId: SESSION, seq: 1, type: "text_delta", text: "y" } as SessionEvent);
  expect(next.stream.text).toBe("y");
});

test("requests show as cards where they were raised and keep how they ended", () => {
  const request = {
    id: "r1",
    kind: "permission",
    turnId: "t1",
    toolUseId: "tu1",
    toolName: "Write",
    input: { file_path: "/work/demo/a.ts", content: "x" },
    summary: "Write(a.ts)",
    risk: "Medium risk: writes files in the workspace",
    ruleHint: "Write",
  };
  const assistant = { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Write", input: request.input }] };
  let view = run(start(), [
    { type: "turn_started", turnId: "t1", input: "go", source: "user", runsModel: true },
    { type: "messages_changed", messages: [user("go"), assistant] },
    { type: "request_opened", request },
  ]);
  expect(view.pendingRequests).toHaveLength(1);
  expect(blocksOf(view).map((b) => b.kind)).toEqual(["user", "tool", "request"]);

  view = run(view, [{ type: "request_resolved", requestId: "r1", kind: "permission", resolution: "response" }]);
  expect(view.pendingRequests).toHaveLength(0);
  expect(blocksOf(view).at(-1)).toMatchObject({ kind: "request", id: "r1", resolution: "response" });

  // A snapshot with a pending request (e.g. after the window reloads) shows its card once.
  const restored = viewFromState(
    "w1",
    state({ messages: [user("go"), assistant] as SessionState["messages"], pendingRequests: [request] as SessionState["pendingRequests"] }),
    0,
  );
  expect(blocksOf(restored).filter((b) => b.kind === "request")).toHaveLength(1);
});

test("thinking, todos, tasks, and background agents follow their events", () => {
  const view = run(start(), [
    { type: "thinking_changed", thinking: { type: "disabled" }, effort: null },
    { type: "todos_changed", todos: [{ content: "Run tests", activeForm: "Running tests", status: "in_progress" }] },
    { type: "task_mode_changed", mode: "todo" },
    {
      type: "background_agents_changed",
      agents: [{ agentId: "a1", agentType: "Explore", prompt: "p", startedAt: "2026-01-01T00:00:00Z", status: "running", toolUseCount: 2 }],
    },
  ]);
  expect(view.effort).toBe("off");
  expect(view.todos[0]?.status).toBe("in_progress");
  expect(view.taskMode).toBe("todo");
  expect(view.backgroundAgents[0]?.agentId).toBe("a1");
  const high = run(view, [{ type: "thinking_changed", thinking: { type: "adaptive" }, effort: "high" }]);
  expect(high.effort).toBe("high");
});

test("a sub-agent call shows its progress and conclusion", () => {
  const progress = { agentType: "Explore", description: "Find the entry", toolUseCount: 0, startTime: 0, status: "running" };
  let view = run(start(), [
    { type: "turn_started", turnId: "t1", input: "go", source: "user", runsModel: true },
    { type: "tool_started", toolUseId: "ag1", name: "Agent", subAgentProgress: progress },
    { type: "tool_progress", toolUseId: "ag1", progress: { kind: "subagent", progress: { ...progress, toolUseCount: 3, lastToolName: "Grep" } } },
  ]);
  expect(blocksOf(view).at(-1)).toMatchObject({
    kind: "tool",
    tool: { name: "Task", status: "running", target: "Find the entry", agent: { type: "Explore", toolUses: 3, lastTool: "Grep" } },
  });
  const assistant = {
    role: "assistant",
    content: [{ type: "tool_use", id: "ag1", name: "Agent", input: { description: "Find the entry", prompt: "p", subagent_type: "Explore" } }],
  };
  view = run(view, [
    {
      type: "messages_changed",
      messages: [user("go"), assistant, { role: "user", content: [{ type: "tool_result", tool_use_id: "ag1", content: "It is src/cli.ts." }] }],
    },
    { type: "turn_completed", turnId: "t1", handled: true, reason: "completed" },
  ]);
  expect(blocksOf(view).find((b) => b.kind === "tool")).toMatchObject({ tool: { status: "success", agent: { result: "It is src/cli.ts." } } });
});
