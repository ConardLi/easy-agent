import { PassThrough } from "node:stream";
import { Box, render } from "ink";
import chalk from "chalk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { ConversationView } from "../ui/components/ConversationView.js";

chalk.level = 3;

function toolUse(id: string, name: string, input: Record<string, unknown>) {
  return { type: "tool_use" as const, id, name, input };
}
function toolResult(id: string, content: string) {
  return { type: "tool_result" as const, tool_use_id: id, content, is_error: false };
}

const messages: MessageParam[] = [
  { role: "user", content: "analyze the project" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Let me look around." },
      toolUse("r1", "Read", { file_path: "package.json" }),
      toolUse("r2", "Read", { file_path: "tsconfig.json" }),
      toolUse("r3", "Read", { file_path: "src/ui/App.tsx" }),
      toolUse("r4", "Read", { file_path: "src/core/agenticLoop.ts" }),
      toolUse("g1", "Grep", { pattern: "TODO" }),
      toolUse("g2", "Grep", { pattern: "FIXME" }),
      toolUse("b1", "Bash", { command: "ls -la src" }),
      toolUse("b2", "Bash", { command: "cat README.md" }),
      toolUse("b3", "Bash", { command: "rg 'collapseReadSearch' src" }),
      toolUse("m1", "mcp__slack__search", { query: "deploy" }),
      toolUse("mem1", "MemoryWrite", { file_path: ".easy-agent/memory/notes.md", content: "x" }),
      toolUse("e1", "Edit", { file_path: "src/ui/theme.ts", old_string: "a", new_string: "b" }),
    ] as unknown as MessageParam["content"],
  },
  {
    role: "user",
    content: [
      toolResult("r1", "63 lines"),
      toolResult("r2", "22 lines"),
      toolResult("r3", "300 lines"),
      toolResult("r4", "780 lines"),
      toolResult("g1", "12 matches"),
      toolResult("g2", "3 matches"),
      toolResult("b1", "STDOUT:\nsrc listing"),
      toolResult("b2", "STDOUT:\n# README"),
      toolResult("b3", "STDOUT:\nsrc/x.ts:1:collapseReadSearch"),
      toolResult("m1", "[]"),
      toolResult("mem1", "Updated .easy-agent/memory/notes.md"),
      toolResult("e1", "edited"),
    ] as unknown as MessageParam["content"],
  },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Now let me run the action commands." },
      toolUse("a1", "Bash", { command: "npm run build" }),
      toolUse("a4", "Bash", { command: 'grep -rn "foo" src' }),
      toolUse("a2", "Bash", { command: "vitest run" }),
      toolUse("a5", "Bash", { command: "ls -la" }),
      toolUse("a3", "Bash", { command: "git status" }),
    ] as unknown as MessageParam["content"],
  },
  {
    role: "user",
    content: [
      toolResult("a1", "Command: npm run build\nExit code: 0\nSTDOUT:\nbuilt ok"),
      toolResult("a4", "Command: grep -rn foo src\nExit code: 0\nSTDOUT:\nsrc/a.ts:1:foo"),
      toolResult("a2", "Command: vitest run\nExit code: 0\nSTDOUT:\n5 passed"),
      toolResult("a5", "Command: ls -la\nExit code: 0\nSTDOUT:\ntotal 0"),
      toolResult("a3", "Command: git status\nExit code: 0\nSTDOUT:\nclean"),
    ] as unknown as MessageParam["content"],
  },
];

async function main(): Promise<void> {
  const fakeStdout = new PassThrough() as unknown as NodeJS.WriteStream;
  let captured = "";
  (fakeStdout as unknown as PassThrough).on("data", (c) => {
    captured += c.toString();
  });
  (fakeStdout as unknown as { columns: number }).columns = Number(process.env.SMOKE_COLS) || 84;
  (fakeStdout as unknown as { rows: number }).rows = 50;

  const instance = render(
    <Box flexDirection="column" paddingX={1}>
      <ConversationView messages={messages} />
    </Box>,
    { stdout: fakeStdout, debug: true, exitOnCtrlC: false },
  );
  await new Promise((r) => setTimeout(r, 80));
  instance.unmount();
  instance.cleanup();

  process.stdout.write(captured + "\n");
}

void main();
