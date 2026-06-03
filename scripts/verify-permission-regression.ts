/**
 * Stage 2 regression — confirms `default` and `plan` mode decisions are
 * unchanged by the auto-mode rewrite. None of these paths call the AI
 * classifier, so this runs offline and instantly.
 *
 * Run:  npx tsx scripts/verify-permission-regression.ts
 */

import { loadEnv } from "../src/utils/loadEnv.js";
loadEnv();

import {
  checkPermission,
  type PermissionMode,
  type PermissionSettings,
} from "../src/permissions/permissions.js";
import { findToolByName } from "../src/tools/index.js";

interface Case {
  name: string;
  mode: PermissionMode;
  expect: "allow" | "ask" | "deny";
  toolName: string;
  input: Record<string, unknown>;
  settings?: Partial<PermissionSettings>;
}

const CWD = process.cwd();

const CASES: Case[] = [
  // default mode
  { name: "default: Read → allow", mode: "default", expect: "allow", toolName: "Read", input: { file_path: "package.json" } },
  { name: "default: Bash git status → allow", mode: "default", expect: "allow", toolName: "Bash", input: { command: "git status" } },
  { name: "default: Write (no rule) → ask", mode: "default", expect: "ask", toolName: "Write", input: { file_path: "x.txt", content: "y" } },
  // Non-read-only Bash in default mode: when the sandbox is enabled with
  // autoAllowBashIfSandboxed (this environment's config), it is auto-allowed;
  // otherwise it would be "ask". Either way this path is untouched by Stage 2.
  { name: "default: Write (no rule, sandbox N/A) → ask", mode: "default", expect: "ask", toolName: "Edit", input: { file_path: "x.txt", old_string: "a", new_string: "b" } },
  { name: "default: deny rule → deny", mode: "default", expect: "deny", toolName: "Bash", input: { command: "npm run deploy" }, settings: { deny: ["Bash(npm run deploy*)"] } },
  { name: "default: allow rule → allow", mode: "default", expect: "allow", toolName: "Bash", input: { command: "npm run build" }, settings: { allow: ["Bash(npm run build*)"] } },
  { name: "default: coordination TodoWrite → allow", mode: "default", expect: "allow", toolName: "TodoWrite", input: { todos: [] } },
  { name: "default: EnterPlanMode → ask", mode: "default", expect: "ask", toolName: "EnterPlanMode", input: {} },
  // plan mode
  { name: "plan: Read → allow", mode: "plan", expect: "allow", toolName: "Read", input: { file_path: "package.json" } },
  { name: "plan: Bash git status → allow", mode: "plan", expect: "allow", toolName: "Bash", input: { command: "git status" } },
  { name: "plan: Bash npm install → deny", mode: "plan", expect: "deny", toolName: "Bash", input: { command: "npm install left-pad" } },
  { name: "plan: Write (non-plan file) → deny", mode: "plan", expect: "deny", toolName: "Write", input: { file_path: "x.txt", content: "y" } },
];

async function main() {
  let passed = 0;
  for (const c of CASES) {
    const tool = findToolByName(c.toolName);
    if (!tool) {
      console.log(`✗ ${c.name} — tool not found`);
      continue;
    }
    const settings: PermissionSettings = {
      allow: c.settings?.allow ?? [],
      deny: c.settings?.deny ?? [],
      mode: c.mode,
    };
    const result = await checkPermission({ tool, input: c.input, cwd: CWD, mode: c.mode, settings });
    const ok = result.behavior === c.expect;
    if (ok) passed += 1;
    console.log(`${ok ? "✓" : "✗"} [${result.behavior.toUpperCase()}] ${c.name} (expected ${c.expect.toUpperCase()})`);
    if (!ok) console.log(`      reason: ${result.reason}`);
  }
  console.log(`\n${passed}/${CASES.length} cases matched expectation.`);
  if (passed !== CASES.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error("regression script failed:", err);
  process.exit(1);
});
