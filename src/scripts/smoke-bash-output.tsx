import { PassThrough } from "node:stream";
import { Box, render } from "ink";
import chalk from "chalk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { ConversationView } from "../ui/components/ConversationView.js";
import { buildTranscriptLines } from "../ui/utils/transcriptLines.js";

chalk.level = 3;

function toolUse(id: string, name: string, input: Record<string, unknown>) {
  return { type: "tool_use" as const, id, name, input };
}
function toolResult(id: string, content: string, isError = false) {
  return { type: "tool_result" as const, tool_use_id: id, content, is_error: isError };
}

function bashResult(command: string, exitCode: number, stdout?: string, stderr?: string): string {
  return [
    `Command: ${command}`,
    `Read-only: false`,
    `Sandbox: disabled`,
    `Exit code: ${exitCode}`,
    stdout ? `\nSTDOUT:\n${stdout}` : "",
    stderr ? `\nSTDERR:\n${stderr}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const messages: MessageParam[] = [
  { role: "user", content: "run a few commands" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Running commands." },
      toolUse("c1", "Bash", { command: "cat README.md" }),
      toolUse("c2", "Bash", { command: "npm run build" }),
      toolUse("c3", "Bash", { command: "sleep 999" }),
      toolUse("c4", "Bash", { command: "mkdir -p tmp/out" }),
      toolUse("c5", "Bash", { command: "git add ." }),
      toolUse("c6", "Bash", { command: "npm run lint" }),
    ] as unknown as MessageParam["content"],
  },
  {
    role: "user",
    content: [
      toolResult("c1", bashResult("cat README.md", 0, "line one\nline two\nline three\nline four\nline five")),
      toolResult("c2", bashResult("npm run build", 0, "> tsc\ncompiling…", "warning: deprecated flag --foo")),
      toolResult("c3", "Command timed out after 120000ms", true),
      toolResult("c4", bashResult("mkdir -p tmp/out", 0)),
      toolResult("c5", bashResult("git add .", 0)),
      toolResult("c6", bashResult("npm run lint", 1, "", "src/a.ts:3:1 error: unexpected token\n1 problem"), true),
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

  process.stdout.write("=== CONDENSED (default history) ===\n");
  process.stdout.write(captured + "\n");

  process.stdout.write("=== TRANSCRIPT (Ctrl+O, verbose) ===\n");
  for (const row of buildTranscriptLines(messages, 84)) process.stdout.write(row + "\n");
}

void main();
