import { expect, test } from "@playwright/test";
import { replacementDiff, toolCall } from "../../src/renderer/agent/tools";

test("shell cards show the output sections and a failing exit code", () => {
  const result = "Command: ls\nRead-only: true\nSandbox: disabled\nExit code: 2\n\nSTDOUT:\na\nb\n\nSTDERR:\nboom\n";
  const card = toolCall({ id: "1", name: "Bash", input: { command: "ls" }, result: { text: result, isError: true }, running: false });
  expect(card).toMatchObject({ name: "Bash", target: "ls", status: "error", summary: "退出码 2", output: "a\nb\n\nboom" });
});

test("MCP and unknown tools keep their real names", () => {
  expect(toolCall({ id: "1", name: "mcp__github__create_issue", input: { title: "x" }, running: true })).toMatchObject({
    name: "mcp",
    server: "github",
    label: "create_issue",
    status: "running",
  });
  expect(toolCall({ id: "2", name: "Skill", input: { skill: "review" }, running: false })).toMatchObject({
    name: "other",
    label: "Skill",
    target: "review",
    status: "interrupted",
  });
});

test("paths inside the workspace are shown relative to it", () => {
  const card = toolCall({ id: "1", name: "Read", input: { file_path: "/w/src/a.ts" }, running: true, cwd: "/w" });
  expect(card.target).toBe("src/a.ts");
});

test("a replacement diff keeps shared lines as context", () => {
  const diff = replacementDiff("a\nb\nc\nd", "a\nB\nC\nd");
  expect(diff.lines.map((l) => `${l.type}:${l.text}`)).toEqual(["ctx:a", "del:b", "del:c", "add:B", "add:C", "ctx:d"]);
  expect([diff.added, diff.removed]).toEqual([2, 2]);
});

test("Agent calls become sub-agent cards", () => {
  const card = toolCall({ id: "1", name: "Agent", input: { description: "Find it", subagent_type: "Explore" }, running: true });
  expect(card).toMatchObject({ name: "Task", target: "Find it", status: "running", agent: { type: "Explore", steps: [] } });
});
