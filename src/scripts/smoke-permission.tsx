/**
 * Visual smoke for the file-aware permission prompt (stage 24.4). Renders the
 * PermissionRequestCard for Edit / Write / Bash so the diff / content / command
 * previews can be eyeballed without a TTY.
 */
import type React from "react";
import { PassThrough } from "node:stream";
import { Box, render } from "ink";
import chalk from "chalk";
import { PermissionRequestCard } from "../ui/components/PermissionRequestCard.js";
import type { PermissionPromptState } from "../ui/types.js";

chalk.level = 3;

const edit: PermissionPromptState = {
  toolName: "Edit",
  summary: "file_path=src/ui/theme.ts",
  risk: "modifies a file",
  ruleHint: "Edit(src/ui/theme.ts)",
  input: {
    file_path: `${process.cwd()}/src/ui/theme.ts`,
    old_string: '  brand: "#D77757",\n  brandLight: "#F59575",',
    new_string: '  brand: "#E07A5F",\n  brandLight: "#F2A07B",\n  accent: "#7AA2D6",',
  },
};

const write: PermissionPromptState = {
  toolName: "Write",
  summary: "file_path=src/ui/newFile.ts",
  risk: "creates a file",
  ruleHint: "Write(src/ui/newFile.ts)",
  input: {
    file_path: `${process.cwd()}/src/ui/newFile.ts`,
    content: 'export function hello(): string {\n  return "hi";\n}\n',
  },
};

const bash: PermissionPromptState = {
  toolName: "Bash",
  summary: "command=rm -rf dist && npm run build",
  risk: "runs a shell command",
  ruleHint: "Bash(rm:*)",
  input: { command: "rm -rf dist && npm run build" },
};

function Demo(): React.ReactNode {
  return (
    <Box flexDirection="column" paddingX={1}>
      <PermissionRequestCard prompt={edit} />
      <PermissionRequestCard prompt={write} />
      <PermissionRequestCard prompt={bash} />
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
