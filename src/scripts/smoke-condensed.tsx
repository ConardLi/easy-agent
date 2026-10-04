import { PassThrough } from "node:stream";
import { Box, render } from "ink";
import chalk from "chalk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { ConversationView } from "../ui/components/ConversationView.js";
import { buildTranscriptLines } from "../ui/utils/transcriptLines.js";

chalk.level = 3;

function tu(id: string, name: string, input: Record<string, unknown>) {
  return { type: "tool_use" as const, id, name, input };
}
function tr(id: string, content: string) {
  return { type: "tool_result" as const, tool_use_id: id, content, is_error: false };
}

const messages: MessageParam[] = [
  { role: "user", content: "edit some files" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Reading." },
      tu("r1", "Read", { file_path: "src/ui/App.tsx" }),
      { type: "text", text: "Searching." },
      tu("g1", "Grep", { pattern: "useAgentSession" }),
      { type: "text", text: "Globbing." },
      tu("gl1", "Glob", { pattern: "src/**/*.tsx" }),
      { type: "text", text: "Editing." },
      tu("e1", "Edit", {
        file_path: "src/ui/theme.ts",
        old_string: "const a = 1;\nconst b = 2;",
        new_string: "const a = 10;\nconst b = 2;\nconst c = 3;",
      }),
      { type: "text", text: "Writing." },
      tu("w1", "Write", { file_path: "src/new.ts", content: "export const x = 1;\nexport const y = 2;" }),
    ] as unknown as MessageParam["content"],
  },
  {
    role: "user",
    content: [
      tr("r1", "src/ui/App.tsx (300 lines)\n...numbered body..."),
      tr("g1", "src/ui/App.tsx:10:import { useAgentSession }"),
      tr("gl1", "Matched files under src:\nsrc/ui/App.tsx\nsrc/ui/x.tsx"),
      tr("e1", "Updated src/ui/theme.ts"),
      tr("w1", "Created src/new.ts"),
    ] as unknown as MessageParam["content"],
  },
];

async function main(): Promise<void> {
  const fakeStdout = new PassThrough() as unknown as NodeJS.WriteStream;
  let captured = "";
  (fakeStdout as unknown as PassThrough).on("data", (c) => {
    captured += c.toString();
  });
  (fakeStdout as unknown as { columns: number }).columns = 84;
  (fakeStdout as unknown as { rows: number }).rows = 60;

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
