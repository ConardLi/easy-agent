import { expect, test } from "@playwright/test";
import { changesOf, exportMarkdown } from "../../src/renderer/agent/projector/derive";
import { viewFromState } from "../../src/renderer/agent/projector/session";
import type { SessionState } from "../../src/shared/agent";
import { aliasFor, listSlash, matchSlash } from "../../src/renderer/lib/slash";

function view(messages: unknown[]) {
  return viewFromState(
    "w1",
    {
      sessionId: "s1",
      cwd: "/w",
      busy: false,
      turnId: null,
      model: "m",
      modelSource: "default",
      permissionMode: "default",
      taskMode: "todo",
      thinking: { type: "adaptive" },
      effort: null,
      messages,
      usage: { total: { input_tokens: 0, output_tokens: 0 }, turn: null, lastCall: null, context: null },
      pendingRequests: [],
      todos: [],
      tasks: [],
      backgroundAgents: [],
    } as unknown as SessionState,
    0,
  );
}

const call = (id: string, name: string, input: Record<string, unknown>) => ({ role: "assistant", content: [{ type: "tool_use", id, name, input }] });
const result = (id: string, content: string, isError = false) => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }],
});

test("changes add up per file and skip failed calls", () => {
  const v = view([
    { role: "user", content: "go" },
    call("1", "Write", { file_path: "/w/a.ts", content: "one\ntwo" }),
    result("1", "Created file: a.ts (7 chars)"),
    call("2", "Edit", { file_path: "/w/a.ts", old_string: "two", new_string: "three" }),
    result("2", "Updated file: a.ts"),
    call("3", "Edit", { file_path: "/w/b.ts", old_string: "x", new_string: "y" }),
    result("3", "String not found", true),
  ]);
  const changes = changesOf(v);
  expect(changes).toHaveLength(1);
  expect(changes[0]).toMatchObject({ path: "a.ts", kind: "added", added: 3, removed: 1 });
});

test("the export has the conversation and leaves thinking out", () => {
  const v = view([
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret" },
        { type: "text", text: "Hi there." },
      ],
    },
  ]);
  const md = exportMarkdown(v, "标题", new Date(0));
  expect(md).toContain("# 标题");
  expect(md).toContain("## 你\n\nhello");
  expect(md).toContain("## Easy Agent\n\nHi there.");
  expect(md).not.toContain("secret");
});

test("slash lists skills, commands, and Agent commands; aliases need two letters", () => {
  const entries = listSlash({ skills: [{ name: "review", description: "Review code" }], userCommands: [{ name: "kit:standup", description: "Standup" }] });
  expect(entries.map((e) => `${e.group}:${e.name}`)).toEqual(["skill:review", "command:kit:standup", "agent:compact", "agent:init"]);
  expect(entries[1]?.source).toBe("插件 kit");
  expect(matchSlash(entries, "m").some((e) => e.group === "action")).toBe(false);
  expect(matchSlash(entries, "mo").find((e) => e.group === "action")?.action).toBe("model");
  expect(aliasFor("diff")?.action).toBe("changes");
});
