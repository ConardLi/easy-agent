#!/usr/bin/env tsx
/**
 * End-to-end integration check: exercise BashTool with the sandbox
 * actually engaged. We write a temporary settings.json that flips
 * sandbox.enabled, then invoke bashTool.call() — the same code path
 * the live agent uses. Confirms:
 *   - sandbox wrapping kicks in
 *   - violation tag is appended on policy hit
 *   - regular commands still succeed
 *
 * Skips on non-macOS hosts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bashTool } from "../tools/bashTool.js";
import { toolResultText } from "../tools/Tool.js";
import { isSandboxRuntimeReady } from "../sandbox/index.js";
import { getProjectEasyAgentDir } from "../utils/paths.js";
import { trustProjectForSession } from "../config/globalState.js";

if (!isSandboxRuntimeReady()) {
  console.log("[skip] sandbox-exec not ready");
  process.exit(0);
}

// Use a throwaway working directory so we don't pollute the repo
// settings.json or accidentally run with the real config.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "easy-agent-bash-sb-"));
const easyDir = getProjectEasyAgentDir(work);
fs.mkdirSync(easyDir, { recursive: true });
fs.writeFileSync(
  path.join(easyDir, "settings.json"),
  JSON.stringify({ sandbox: { enabled: true } }, null, 2),
);

const failures: string[] = [];
function expect(label: string, condition: unknown, evidence?: string): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    console.log(`  ✗ ${label}${evidence ? `\n      ${evidence}` : ""}`);
    failures.push(label);
  }
}

async function main(): Promise<void> {
  await trustProjectForSession(work);

  console.log(`\n[1] BashTool runs an allowed command (sandbox engaged)`);
  const ok = await bashTool.call(
    { command: "echo hello-from-sandbox" },
    { cwd: work },
  );
  const okText = toolResultText(ok.content);
  expect("not an error", !ok.isError, okText);
  expect("output mentions Sandbox: enabled", okText.includes("Sandbox: enabled"));
  expect("stdout contains expected echo", okText.includes("hello-from-sandbox"));

  console.log(`\n[2] BashTool blocks a write to /etc and tags violation`);
  const denied = await bashTool.call(
    { command: "echo hijack > /etc/easy-agent-bash-test 2>&1" },
    { cwd: work },
  );
  const deniedText = toolResultText(denied.content);
  expect("is an error", denied.isError === true, deniedText);
  expect("violation tag present in tool result", deniedText.includes("<sandbox_violations>"));
  expect("no rogue file landed in /etc", !fs.existsSync("/etc/easy-agent-bash-test"));

  console.log(`\n[2b] Redirect to /dev/null works under the sandbox`);
  const devnull = await bashTool.call(
    { command: `ls "${work}" 2>/dev/null && echo "---" && echo done` },
    { cwd: work },
  );
  const devnullText = toolResultText(devnull.content);
  expect("not an error", !devnull.isError, devnullText);
  expect("no /dev/null permission violation", !devnullText.includes("Operation not permitted"), devnullText);
  expect("stdout reached the echo after the redirect", devnullText.includes("done"));

  console.log(`\n[3] dangerouslyDisableSandbox + allowUnsandboxedCommands → bypass`);
  const escaped = await bashTool.call(
    { command: "echo escape", dangerouslyDisableSandbox: true },
    { cwd: work },
  );
  expect("not an error", !escaped.isError);
  expect(
    "output marks Sandbox: disabled",
    toolResultText(escaped.content).includes("Sandbox: disabled"),
  );

  console.log("");
  if (failures.length === 0) {
    console.log("  All BashTool sandbox smoke checks passed.");
    process.exit(0);
  } else {
    console.log(`  ${failures.length} failure(s):`);
    for (const f of failures) console.log(`    - ${f}`);
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch {}
  });
