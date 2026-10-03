import { PassThrough } from "node:stream";
import { Box, Text, render } from "ink";
import chalk from "chalk";
import { ToolCallList } from "../ui/components/ToolCallList.js";
import type { ToolCallInfo } from "../ui/types.js";

chalk.level = 3;

const DONE = { resultLength: 80 } as const;

// A. everything still running → active/present tense.
const active: ToolCallInfo[] = [
  { id: "a1", name: "Grep", input: { pattern: "useAgentSession" }, status: "running" },
  { id: "a2", name: "Read", input: { file_path: "src/ui/App.tsx" }, status: "running" },
  { id: "a3", name: "Read", input: { file_path: "src/core/agenticLoop.ts" }, status: "running" },
  { id: "a4", name: "Read", input: { file_path: "src/ui/hooks/useAgentSession.ts" }, status: "running" },
  { id: "a5", name: "Glob", input: { pattern: "src/**/*.tsx" }, status: "running" },
];

// B. mixed — first three landed, last two still running → still active.
const mixed: ToolCallInfo[] = [
  { id: "b1", name: "Grep", input: { pattern: "TODO" }, ...DONE },
  { id: "b2", name: "Read", input: { file_path: "package.json" }, ...DONE },
  { id: "b3", name: "Read", input: { file_path: "tsconfig.json" }, ...DONE },
  { id: "b4", name: "Read", input: { file_path: "src/ui/theme.ts" }, status: "running" },
  { id: "b5", name: "Read", input: { file_path: "src/ui/types.ts" }, status: "running" },
];

// C. all landed → past tense, green dot. Plus a lone Read (NOT grouped) and a
// non-collapsible Bash action to show the run boundaries.
const done: ToolCallInfo[] = [
  { id: "c1", name: "Grep", input: { pattern: "import" }, ...DONE },
  { id: "c2", name: "Read", input: { file_path: "a.ts" }, ...DONE },
  { id: "c3", name: "Read", input: { file_path: "b.ts" }, ...DONE },
  { id: "c4", name: "Read", input: { file_path: "c.ts" }, ...DONE },
  { id: "c5", name: "Bash", input: { command: "npm run build" }, ...DONE }, // breaks the run
  { id: "c6", name: "Read", input: { file_path: "lonely.ts" }, ...DONE }, // lone → single card
];

async function frame(label: string, toolCalls: ToolCallInfo[]): Promise<void> {
  const fakeStdout = new PassThrough() as unknown as NodeJS.WriteStream;
  let captured = "";
  (fakeStdout as unknown as PassThrough).on("data", (c) => {
    captured += c.toString();
  });
  (fakeStdout as unknown as { columns: number }).columns = 84;
  (fakeStdout as unknown as { rows: number }).rows = 50;

  const instance = render(
    <Box flexDirection="column" paddingX={1}>
      <Text>{`── ${label} ──`}</Text>
      <ToolCallList toolCalls={toolCalls} />
    </Box>,
    { stdout: fakeStdout, debug: true, exitOnCtrlC: false },
  );
  await new Promise((r) => setTimeout(r, 80));
  instance.unmount();
  instance.cleanup();
  // Print only the first stable frame.
  process.stdout.write(
    captured
      .split("\n")
      .slice(0, toolCalls.length + 4)
      .join("\n") + "\n\n",
  );
}

async function main(): Promise<void> {
  await frame("A. active (all running)", active);
  await frame("B. mixed (some done)", mixed);
  await frame("C. done (all landed) + lone read", done);
}

void main();
