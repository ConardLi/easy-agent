import { PassThrough } from "node:stream";
import { render } from "ink";
import chalk from "chalk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { TranscriptOverlay } from "../ui/components/TranscriptOverlay.js";
import { buildTranscriptLines } from "../ui/utils/transcriptLines.js";

chalk.level = 3;

const messages: MessageParam[] = [
  { role: "user", content: "帮我把主题色改一下，再跑个构建" },
  {
    role: "assistant",
    content: "好的，我来改 `theme.ts` 并验证一下。\n\n- 先改色值\n- 再跑 `npm run build`",
  },
  {
    role: "assistant",
    content: [
      { type: "text", text: "开始动手。" },
      {
        type: "tool_use",
        id: "t1",
        name: "Edit",
        input: {
          file_path: "src/ui/theme.ts",
          old_string: '  brand: "#D77757",\n  brandLight: "#F59575",',
          new_string: '  brand: "#E07A5F",\n  brandLight: "#F2A07B",',
        },
      },
      { type: "tool_use", id: "t2", name: "Read", input: { file_path: "src/ui/theme.ts" } },
      { type: "tool_use", id: "t3", name: "Bash", input: { command: "npm run build && ls dist" } },
    ] as unknown as MessageParam["content"],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "t1", content: "Updated file: /abs/src/ui/theme.ts" },
      { type: "tool_result", tool_use_id: "t2", content: "src/ui/theme.ts (42 lines)\n  1\texport const theme = {" },
      {
        type: "tool_result",
        tool_use_id: "t3",
        content:
          "Command: npm run build && ls dist\nRead-only: false\nSandbox: disabled\nExit code: 0\n\nSTDOUT:\n> easy-agent@0.1.0 build\n> tsc\n\nentrypoint\ncore\ntools\nui",
      },
    ] as unknown as MessageParam["content"],
  },
  { role: "assistant", content: "改完了，构建通过 ✅。主题色已切换到更暖的橙调。" },
];

async function main(): Promise<void> {
  const cols = Number(process.env.SMOKE_COLS) || 90;
  const rows = Number(process.env.SMOKE_ROWS) || 24;
  const lines = buildTranscriptLines(messages, cols - 2);
  const viewport = Math.max(1, rows - 2);
  const maxScroll = Math.max(0, lines.length - viewport);
  const scroll = process.env.SMOKE_SCROLL !== undefined ? Number(process.env.SMOKE_SCROLL) : maxScroll;

  const fakeStdout = new PassThrough() as unknown as NodeJS.WriteStream;
  let captured = "";
  (fakeStdout as unknown as PassThrough).on("data", (c) => {
    captured += c.toString();
  });
  (fakeStdout as unknown as { columns: number }).columns = cols;
  (fakeStdout as unknown as { rows: number }).rows = rows;

  const instance = render(<TranscriptOverlay lines={lines} scroll={scroll} viewportHeight={viewport} rows={rows} />, {
    stdout: fakeStdout,
    debug: true,
    exitOnCtrlC: false,
  });
  await new Promise((r) => setTimeout(r, 80));
  instance.unmount();
  instance.cleanup();

  process.stdout.write(`[total lines: ${lines.length}, viewport: ${viewport}, scroll: ${scroll}]\n`);
  process.stdout.write(captured + "\n");
}

void main();
