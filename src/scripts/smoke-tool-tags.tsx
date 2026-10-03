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

const messages: MessageParam[] = [
  { role: "user", content: "do a few things" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Working." },
      toolUse("t1", "Bash", { command: "sleep 300", timeout: 300000 }), // custom → [timeout: 5m]
      toolUse("t2", "Bash", { command: "echo hi", timeout: 120000 }), // default → no tag
      toolUse("t3", "Bash", { command: "ls" }), // no timeout → no tag
      toolUse("t4", "WebFetch", { url: "https://example.com/docs", prompt: "summarize" }),
      toolUse("t5", "WebFetch", { url: "https://example.com/missing", prompt: "summarize" }),
      toolUse("t6", "mcp__slack__post_message", { channel: "#general", text: "hi" }),
      toolUse("t7", "Read", { file_path: "src/ui/App.tsx" }),
    ] as unknown as MessageParam["content"],
  },
  {
    role: "user",
    content: [
      toolResult("t1", "Command: sleep 300\nExit code: 0\n"),
      toolResult("t2", "Command: echo hi\nExit code: 0\n\nSTDOUT:\nhi"),
      toolResult("t3", "Command: ls\nExit code: 0\n\nSTDOUT:\nREADME.md\nsrc"),
      toolResult("t4", "Fetched https://example.com/docs (200 OK, 5123 bytes, html→markdown)\n\n# Docs\n…"),
      toolResult("t5", "Fetched https://example.com/missing (404 Not Found, 88 bytes)\n\nNot found"),
      toolResult("t6", "Message posted to #general"),
      toolResult("t7", "     1\tconst x = 1;"),
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
