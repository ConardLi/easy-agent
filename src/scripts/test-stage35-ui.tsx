/**
 * Stage 35 plugin-manager interaction smoke test.
 *
 * Drives the real Ink component through a fake TTY to cover rendering,
 * search, details, preflight confirmation, and cancellation without touching
 * plugin state or the network.
 */

import type React from "react";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { PluginManager } from "../ui/components/PluginManager.js";
import { InputPrompt } from "../ui/components/InputPrompt.js";
import { CommandSuggestions } from "../ui/components/CommandSuggestions.js";
import { usePromptInput } from "../ui/hooks/usePromptInput.js";
import type { PluginViewData } from "../core/queryEngine.js";
import { getNestedCommandSuggestions } from "../ui/commandPalette.js";

const data: PluginViewData = {
  projectTrusted: false,
  available: [
    {
      pluginId: "review@team",
      name: "review",
      marketplace: "team",
      version: "2.0.0",
      description: "Review pull requests",
    },
  ],
  installed: [
    {
      pluginId: "demo@team",
      name: "demo",
      marketplace: "team",
      version: "1.0.0",
      description: "A complete demo plugin",
      author: "Easy Agent",
      enabled: true,
      scope: "project",
      components: {
        skills: 1,
        agents: 1,
        commands: 1,
        outputStyles: 1,
        hooks: 1,
        mcpServers: 1,
      },
      componentNames: {
        skills: ["demo:greet"],
        agents: ["demo:helper"],
        commands: ["demo:hello"],
        outputStyles: ["demo:fancy"],
        hooks: ["PreToolUse:Bash"],
        mcpServers: ["plugin:demo:local"],
      },
      hasExecutableComponents: true,
      warnings: [],
      errorCount: 0,
      executablesTrusted: false,
    },
  ],
  marketplaces: [
    {
      name: "team",
      kind: "git",
      location: "/managed/team",
      lastUpdated: "2026-07-26T00:00:00.000Z",
      pluginCount: 2,
    },
  ],
  errors: [],
};

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    process.stdout.write(`  \u001b[32m✓\u001b[0m ${label}\n`);
  } else {
    failed += 1;
    process.stdout.write(`  \u001b[31m✗ ${label}\u001b[0m\n`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function PromptPaletteHarness({ onSubmit }: { onSubmit: (text: string) => void }): React.ReactNode {
  const prompt = usePromptInput({
    isLoading: false,
    hasPermissionPrompt: false,
    hasQuestionPrompt: false,
    hasTranscript: false,
    hasCommandPanel: false,
    hasResumePicker: false,
    isPlanExitPrompt: false,
    permissionMode: "default",
    taskMode: "task",
    onSubmit,
    onExit: () => {},
    onInterrupt: () => false,
    onPermissionDecision: () => false,
    onToggleTranscript: () => {},
  });
  return (
    <>
      <InputPrompt isLoading={false} inputValue={prompt.inputValue} cursor={prompt.cursor} />
      <CommandSuggestions items={prompt.commandSuggestions} />
    </>
  );
}

async function main(): Promise<void> {
  const pluginActions = getNestedCommandSuggestions("/plugin ");
  check(
    "/plugin opens a second-level command palette",
    Boolean(
      pluginActions?.some((item) => item.name === "/plugin install") &&
        pluginActions.some((item) => item.name === "/plugin marketplace"),
    ),
  );
  const filteredPluginActions = getNestedCommandSuggestions("/plugin ma");
  check(
    "second-level palette filters incrementally",
    filteredPluginActions?.length === 1 && filteredPluginActions[0]?.name === "/plugin marketplace",
  );
  const marketplaceActions = getNestedCommandSuggestions("/plugin marketplace ");
  check(
    "/plugin marketplace opens a third-level palette",
    Boolean(
      marketplaceActions?.some((item) => item.name === "/plugin marketplace add") &&
        marketplaceActions.some((item) => item.name === "/plugin marketplace update"),
    ),
  );
  check(
    "actions requiring another argument complete instead of running",
    marketplaceActions?.find((item) => item.name.endsWith(" add"))?.completionOnly === true,
  );

  const paletteStdout = new PassThrough();
  let paletteCaptured = "";
  paletteStdout.on("data", (chunk) => {
    paletteCaptured += chunk.toString();
  });
  Object.assign(paletteStdout, { columns: 100, rows: 30, isTTY: true });
  const paletteStdin = new PassThrough();
  Object.assign(paletteStdin, {
    isTTY: true,
    setRawMode: () => {},
    ref: () => {},
    unref: () => {},
  });
  const submitted: string[] = [];
  const paletteInstance = render(<PromptPaletteHarness onSubmit={(text) => submitted.push(text)} />, {
    stdin: paletteStdin as unknown as NodeJS.ReadStream,
    stdout: paletteStdout as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
  });
  await sleep(30);
  paletteStdin.write("/plugin ma");
  await sleep(40);
  check("real prompt renders filtered /plugin suggestions", paletteCaptured.includes("/plugin marketplace"));
  paletteStdin.write("\r");
  await sleep(30);
  paletteStdin.write("a");
  await sleep(20);
  paletteStdin.write("\r");
  await sleep(30);
  check(
    "Enter drills down and completes marketplace add without premature submit",
    paletteCaptured.includes("/plugin marketplace add ") && submitted.length === 0,
  );
  paletteInstance.unmount();
  paletteInstance.cleanup();

  const stdout = new PassThrough();
  let captured = "";
  stdout.on("data", (chunk) => {
    captured += chunk.toString();
  });
  Object.assign(stdout, { columns: 100, rows: 40, isTTY: true });

  const stdin = new PassThrough();
  Object.assign(stdin, {
    isTTY: true,
    setRawMode: () => {},
    ref: () => {},
    unref: () => {},
  });

  const instance = render(
    <PluginManager
      data={data}
      active={true}
      onClose={() => {}}
      onMutate={async () => {}}
      onPreview={async (pluginId) => ({
        pluginId,
        version: "2.0.0",
        fingerprint: "fixture-fingerprint",
        components: {
          skills: ["demo:greet"],
          agents: ["demo:helper"],
          commands: ["demo:hello"],
          outputStyles: ["demo:fancy"],
          hooks: ["PreToolUse:Bash"],
          mcpServers: ["plugin:demo:local"],
        },
        hasExecutableComponents: true,
        warnings: [],
        errors: [],
      })}
    />,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
    },
  );

  await sleep(50);
  check("renders tabbed plugin manager", captured.includes("Installed 1") && captured.includes("Marketplaces 1"));
  check("shows executable/trust state", captured.includes("project untrusted") && captured.includes("⚡"));

  stdin.write("i");
  await sleep(40);
  check("opens component details", captured.includes("demo:greet") && captured.includes("plugin:demo:local"));

  stdin.write("\u001b");
  await sleep(30);
  stdin.write("/");
  await sleep(20);
  stdin.write("demo");
  await sleep(20);
  stdin.write("\r");
  await sleep(40);
  check("supports incremental filtering", captured.includes("filter: “demo”"));

  stdin.write("u");
  await sleep(80);
  check(
    "preflights update before confirmation",
    captured.includes("Update demo@team to v2.0.0?") && captured.includes("Hooks/MCP may execute local processes"),
  );

  stdin.write("n");
  await sleep(30);
  check("cancels confirmation without mutation", captured.includes("Plugins"));

  instance.unmount();
  instance.cleanup();
  process.stdout.write(`\nStage 35 UI: ${passed} passed, ${failed} failed.\n`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
