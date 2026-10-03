/**
 * Visual smoke for the upgraded input line (stage 24.3). Renders InputPrompt in
 * several states — cursor mid-string, multi-line buffer, and `!` bash mode — so
 * the block cursor, continuation indent, and mode caret can be eyeballed without
 * a TTY. Also renders the `@` FileSuggestions palette.
 */
import type React from "react";
import { PassThrough } from "node:stream";
import { Box, Text, render } from "ink";
import chalk from "chalk";
import { InputPrompt } from "../ui/components/InputPrompt.js";
import { FileSuggestions } from "../ui/components/FileSuggestions.js";
import type { FileSuggestion } from "../ui/types.js";

chalk.level = 3;

const files: FileSuggestion[] = [
  { path: "src/", isDirectory: true, isSelected: false },
  { path: "src/ui/", isDirectory: true, isSelected: true },
  { path: "src/ui/App.tsx", isDirectory: false, isSelected: false },
  { path: "package.json", isDirectory: false, isSelected: false },
];

function Demo(): React.ReactNode {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text dimColor>— cursor mid-string (cursor=5) —</Text>
      <InputPrompt isLoading={false} inputValue="hello world" cursor={5} />

      <Text dimColor>— trigger highlight: /command + @file —</Text>
      <InputPrompt isLoading={false} inputValue="/review @src/ui/App.tsx now" cursor={27} />

      <Text dimColor>— multi-line buffer (cursor on line 2) —</Text>
      <InputPrompt isLoading={false} inputValue={"first line\nsecond line\nthird"} cursor={17} />

      <Text dimColor>— bash mode (`!` caret) —</Text>
      <InputPrompt isLoading={false} inputValue="!npm run build" cursor={14} />

      <Text dimColor>— @ file typeahead palette —</Text>
      <InputPrompt isLoading={false} inputValue="open @src/ui" cursor={12} />
      <FileSuggestions items={files} />
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
