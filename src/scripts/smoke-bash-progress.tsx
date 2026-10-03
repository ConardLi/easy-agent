
import { PassThrough } from "node:stream";
import { Box, render } from "ink";
import chalk from "chalk";
import { ToolCallList } from "../ui/components/ToolCallList.js";
import type { ToolCallInfo } from "../ui/types.js";

chalk.level = 3;

const TWO_MIN = 120000;

// A 12-line output where the preview buffer kept only the tail → `~N lines`.
const bigTail = Array.from({ length: 6 }, (_, i) => `line ${i + 7}: still building module-${i}`).join("\n");

const toolCalls: ToolCallInfo[] = [
  {
    id: "p0",
    name: "Bash",
    input: { command: "sleep 30" },
    status: "running",
    bashProgress: {
      output: "",
      totalLines: 0,
      totalBytes: 0,
      startTime: Date.now() - 3000,
      timeoutMs: TWO_MIN,
      done: false,
    },
  },
  {
    id: "p1",
    name: "Bash",
    input: { command: "npm install" },
    status: "running",
    // 8 lines fully retained (totalLines === retained) → exact `+3 lines`.
    bashProgress: {
      output: [
        "added 12 packages",
        "added 30 packages",
        "added 5 packages",
        "removed 1 package",
        "audited 197 packages",
        "found 0 vulnerabilities",
        "running postinstall…",
        "building fresh packages…",
      ].join("\n"),
      totalLines: 8,
      totalBytes: 4096,
      startTime: Date.now() - 6000,
      timeoutMs: TWO_MIN,
      done: false,
    },
  },
  {
    id: "p2",
    name: "Bash",
    input: { command: "npm run build" },
    status: "running",
    // retained buffer is 6 lines but totalLines=240 → preview dropped lines → `~240 lines`
    bashProgress: {
      output: bigTail,
      totalLines: 240,
      totalBytes: 1024 * 1024 * 1.5,
      startTime: Date.now() - 42000,
      timeoutMs: 600000,
      done: false,
    },
  },
  {
    id: "p3",
    name: "Bash",
    input: { command: "tail -f log.txt" },
    status: "running",
    bashProgress: {
      output: "request 1 ok\nrequest 2 ok\nrequest 3 ok",
      totalLines: 3,
      totalBytes: 96,
      startTime: Date.now() - 12000,
      // no timeoutMs → time hint omits the `timeout` suffix
      done: false,
    },
  },
];

async function main(): Promise<void> {
  const fakeStdout = new PassThrough() as unknown as NodeJS.WriteStream;
  let captured = "";
  (fakeStdout as unknown as PassThrough).on("data", (c) => {
    captured += c.toString();
  });
  (fakeStdout as unknown as { columns: number }).columns = 84;
  (fakeStdout as unknown as { rows: number }).rows = 50;

  const instance = render(
    <Box flexDirection="column" paddingX={1}>
      <ToolCallList toolCalls={toolCalls} />
    </Box>,
    { stdout: fakeStdout, debug: true, exitOnCtrlC: false },
  );
  await new Promise((r) => setTimeout(r, 80));
  instance.unmount();
  instance.cleanup();

  process.stdout.write(captured + "\n");
}

void main();
