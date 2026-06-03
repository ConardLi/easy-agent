/**
 * Stage 4 verification — `autoMode` config is honored from trusted scopes
 * (user / flag / policy) only, never from a checked-in project/local file.
 * Offline & deterministic.
 *
 * Run:  npx tsx scripts/verify-auto-mode-stage4.ts
 */

import { loadEnv } from "../src/utils/loadEnv.js";
loadEnv();

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadPermissionSettings } from "../src/permissions/permissions.js";
import { setFlagSettings } from "../src/config/sources.js";

let passed = 0;
let total = 0;
function check(name: string, cond: boolean, extra = "") {
  total += 1;
  if (cond) passed += 1;
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
}

function tmpDir(settingsFile?: string, content?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-stage4-"));
  if (settingsFile && content !== undefined) {
    fs.mkdirSync(path.join(dir, ".easy-agent"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".easy-agent", settingsFile), JSON.stringify(content));
  }
  return dir;
}

async function modeWithFlag(cwd: string, flag: Record<string, unknown> | null): Promise<string> {
  setFlagSettings(flag);
  try {
    return (await loadPermissionSettings(cwd)).mode;
  } finally {
    setFlagSettings(null);
  }
}

async function main() {
  // Ambient baseline (whatever user/policy settings exist in this env).
  const baseline = await modeWithFlag(tmpDir(), null);
  console.log(`baseline mode (clean cwd, no flag): ${baseline}\n`);

  // 1. Trusted flag scope: autoMode:true → auto.
  check("flag autoMode:true → mode auto", (await modeWithFlag(tmpDir(), { autoMode: true })) === "auto");

  // 2. Trusted flag scope: explicit mode still works (regression).
  check("flag mode:'auto' → mode auto", (await modeWithFlag(tmpDir(), { mode: "auto" })) === "auto");

  // 3. Project scope autoMode:true → IGNORED (must equal baseline).
  const projAuto = await modeWithFlag(tmpDir("settings.json", { autoMode: true }), null);
  check("project autoMode:true → IGNORED", projAuto === baseline, `got ${projAuto}, baseline ${baseline}`);

  // 4. Local scope autoMode:true → IGNORED.
  const localAuto = await modeWithFlag(tmpDir("settings.local.json", { autoMode: true }), null);
  check("local autoMode:true → IGNORED", localAuto === baseline, `got ${localAuto}`);

  // 5. Project scope mode:'auto' → IGNORED (existing security invariant).
  const projMode = await modeWithFlag(tmpDir("settings.json", { mode: "auto" }), null);
  check("project mode:'auto' → IGNORED", projMode === baseline, `got ${projMode}`);

  // 6. Flag explicit mode beats flag autoMode is moot (same source); check that
  //    a project autoMode does NOT override a trusted flag default.
  const flagDefaultProjAuto = await modeWithFlag(tmpDir("settings.json", { autoMode: true }), { mode: "default" });
  check("flag mode:'default' + project autoMode:true → default", flagDefaultProjAuto === "default", `got ${flagDefaultProjAuto}`);

  console.log(`\n${passed}/${total} checks passed.`);
  if (passed !== total) process.exitCode = 1;
}

main().catch((err) => {
  console.error("verification script failed:", err);
  process.exit(1);
});
