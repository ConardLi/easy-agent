/**
 * Visual smoke for the configurable status line (stage 24.5). Renders the
 * built-in segmented line in a few states plus a custom-command override, so
 * the segments / separators / mode color can be eyeballed without a TTY.
 */
import type React from "react";
import { PassThrough } from "node:stream";
import { Box, Text, render } from "ink";
import chalk from "chalk";
import { StatusLine } from "../ui/components/StatusLine.js";

chalk.level = 3;

function Demo(): React.ReactNode {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text dimColor>— default footer (no statusLine config) —</Text>
      <StatusLine permissionMode="default" />

      <Text dimColor>— non-default mode marker —</Text>
      <StatusLine permissionMode="plan" />

      <Text dimColor>— custom statusLine command output —</Text>
      <StatusLine permissionMode="default" custom="git:main +2 · $0.42 today · context 12%" />
    </Box>
  );
}

async function main(): Promise<void> {
  const fakeStdout = new PassThrough() as unknown as NodeJS.WriteStream;
  let captured = "";
  (fakeStdout as unknown as PassThrough).on("data", (c) => {
    captured += c.toString();
  });
  (fakeStdout as unknown as { columns: number }).columns = Number(process.env.SMOKE_COLS) || 84;
  (fakeStdout as unknown as { rows: number }).rows = 50;

  const instance = render(<Demo />, { stdout: fakeStdout, debug: true, exitOnCtrlC: false });
  await new Promise((r) => setTimeout(r, 80));
  instance.unmount();
  instance.cleanup();

  process.stdout.write(captured + "\n");
}

void main();
