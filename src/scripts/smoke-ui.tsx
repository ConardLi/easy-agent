/**
 * Visual smoke for the Stage 24 UI refresh. Renders the welcome banner, user
 * message bars and the bordered input via the REAL <Static> + flattenConversation
 * path (matching App.tsx) to a fake 80-col stdout (debug = deterministic frame),
 * then prints the captured frame so the layout / borders / full-width grey bars
 * can be eyeballed without a TTY.
 */
import React from "react";
import { PassThrough } from "node:stream";
import { Box, Static, Text, render } from "ink";
import chalk from "chalk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { WelcomeBanner } from "../ui/components/WelcomeBanner.js";
import { InputPrompt } from "../ui/components/InputPrompt.js";
import { flattenConversation } from "../ui/components/ConversationView.js";
import { theme } from "../ui/theme.js";

chalk.level = 3;

const messages: MessageParam[] = [
  { role: "user", content: "你好呀" },
  {
    role: "assistant",
    content:
      "## 标题\n\n你好呀，小花 👋\n\n我是 **Easy Agent**，行内代码 `npm run dev`，[链接](https://example.com)。\n\n- 列表项一\n- 列表项二",
  },
  {
    role: "user",
    content:
      "帮我看看这段很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长的消息背景会不会占满整行并正确换行",
  },
  {
    role: "assistant",
    content: [
      { type: "text", text: "好的，我来改一下并看看相关文件。" },
      {
        type: "tool_use",
        id: "t1",
        name: "Edit",
        input: {
          file_path: "src/ui/theme.ts",
          old_string: "  brand: \"#D77757\",\n  brandLight: \"#F59575\",\n  assistant: \"#D77757\",",
          new_string: "  brand: \"#E07A5F\",\n  brandLight: \"#F2A07B\",\n  assistant: \"#E07A5F\",",
        },
      },
      {
        type: "tool_use",
        id: "t2",
        name: "Read",
        input: { file_path: "src/ui/theme.ts" },
      },
      {
        type: "tool_use",
        id: "t3",
        name: "Grep",
        input: { pattern: "brandLight" },
      },
      {
        type: "tool_use",
        id: "t4",
        name: "Write",
        input: { file_path: "src/ui/newFile.ts", content: "export const x = 1;\nexport const y = 2;\nexport const z = 3;" },
      },
      {
        type: "tool_use",
        id: "t5",
        name: "Bash",
        input: { command: "npm run build && ls dist" },
      },
    ] as unknown as MessageParam["content"],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "t1", content: "Updated file: /abs/src/ui/theme.ts\nPreview: ..." },
      { type: "tool_result", tool_use_id: "t2", content: "src/ui/theme.ts (42 lines)\n  1\texport const theme = {\n  2\t  brand: \"#D77757\"," },
      { type: "tool_result", tool_use_id: "t3", content: "src/ui/theme.ts:3:  brandLight: \"#F59575\",\nsrc/ui/WelcomeBanner.tsx:26:  brandLight" },
      { type: "tool_result", tool_use_id: "t4", content: "Created file: /abs/src/ui/newFile.ts (52 chars)" },
      { type: "tool_result", tool_use_id: "t5", content: "Command: npm run build && ls dist\nRead-only: false\nSandbox: disabled\nExit code: 0\n\nSTDOUT:\n> easy-agent@0.1.0 build\n> tsc\n\nentrypoint\ncore\ntools\nui" },
    ] as unknown as MessageParam["content"],
  },
];

const VERBOSE = process.env.SMOKE_VERBOSE === "1";

function Demo(): React.ReactNode {
  const items = [
    { key: "welcome", element: <WelcomeBanner model="MiniMax-M3" version="0.1.0" permissionMode="auto" /> },
    ...flattenConversation(messages, VERBOSE),
  ];
  return (
    <Box flexDirection="column" paddingX={1}>
      <Static items={items}>
        {(item) => (
          <Box key={item.key} flexDirection="column">
            {item.element}
          </Box>
        )}
      </Static>
      <InputPrompt isLoading={false} inputValue="" />
      <Box paddingX={1}>
        <Text color={theme.muted}>? for shortcuts</Text>
        <Text color={theme.muted}>{`   ctrl+o ${VERBOSE ? "collapse" : "expand"} tool output`}</Text>
      </Box>
    </Box>
  );
}

async function main(): Promise<void> {
  const fakeStdout = new PassThrough() as unknown as NodeJS.WriteStream;
  let captured = "";
  (fakeStdout as unknown as PassThrough).on("data", (c) => {
    captured += c.toString();
  });
  const cols = Number(process.env.SMOKE_COLS) || 80;
  (fakeStdout as unknown as { columns: number }).columns = cols;
  (fakeStdout as unknown as { rows: number }).rows = 40;

  const instance = render(<Demo />, { stdout: fakeStdout, debug: true, exitOnCtrlC: false });
  await new Promise((r) => setTimeout(r, 80));
  instance.unmount();
  instance.cleanup();

  process.stdout.write(captured + "\n");
}

void main();
