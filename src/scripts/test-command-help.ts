/**
 * Built-in command help: `eagent --help` and the REPL `/help` panel list the
 * same commands, every reserved built-in name is documented, and the REPL
 * commands stay in their own section of `--help`.
 *
 * Run: node --import tsx src/scripts/test-command-help.ts
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { BUILTIN_COMMAND_NAMES } from "../commands/builtinCommandNames.js";
import { BUILTIN_COMMAND_HELP, formatBuiltinCommandHelpLines } from "../commands/builtinCommandHelp.js";
import { buildCommandNotice } from "../ui/hooks/useAgentSession/notices.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const CLI_PATH = path.join(PROJECT_ROOT, "src", "entrypoint", "cli.ts");
const TSX_IMPORT = import.meta.resolve("tsx");

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function runHelp(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", TSX_IMPORT, CLI_PATH, "--help"], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`--help exited ${code}: ${stderr}`)),
    );
  });
}

/** Lines of the `--help` section that starts with `heading`, up to the next blank line. */
function helpSection(stdout: string, heading: string): string[] {
  const lines = stdout.split(/\r?\n/);
  const start = lines.indexOf(heading);
  assert.notEqual(start, -1, `--help has a "${heading}" section`);
  const end = lines.findIndex((line, i) => i > start && line.trim() === "");
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

const help = await runHelp();
const replSection = helpSection(help, "Commands (in REPL):");

await check("every reserved built-in name is documented as a command or an alias", () => {
  const documented = new Set(
    BUILTIN_COMMAND_HELP.flatMap(({ usage, description }) => `${usage} ${description}`.match(/\/[a-z][a-z-]*/g) ?? []),
  );
  const missing = [...BUILTIN_COMMAND_NAMES].filter((name) => !documented.has(`/${name.replace(/_/g, "-")}`));
  assert.deepEqual(missing, []);
});

await check("--help lists every command in the REPL section, in order", () => {
  const usages = replSection.filter((line) => line.startsWith("  /")).map((line) => line.trim());
  assert.deepEqual(
    usages.map((line) => BUILTIN_COMMAND_HELP.find(({ usage }) => line.startsWith(usage))?.usage),
    BUILTIN_COMMAND_HELP.map(({ usage }) => usage),
  );
  for (const { description } of BUILTIN_COMMAND_HELP) {
    assert.ok(
      replSection.some((line) => line.endsWith(description)),
      `--help describes: ${description}`,
    );
  }
});

await check("no REPL command appears after the REPL section", () => {
  const lines = help.split(/\r?\n/);
  const sectionEnd = lines.indexOf("Commands (in REPL):") + replSection.length;
  const stray = lines.slice(sectionEnd + 1).filter((line) => /^ {2}\/[a-z]/.test(line));
  assert.deepEqual(stray, []);
});

await check("/help panel shows the same list", () => {
  const notice = buildCommandNotice("Commands:", "info");
  assert.equal(notice.title, "Available commands");
  assert.equal(notice.body, formatBuiltinCommandHelpLines());
  assert.deepEqual(
    notice.body.split("\n").map((line) => line.split(" — ")[0]),
    BUILTIN_COMMAND_HELP.map(({ usage }) => usage),
  );
});

console.log(`\ncommand help: ${passed} passed`);
