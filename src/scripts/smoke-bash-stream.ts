#!/usr/bin/env tsx
/**
 * Smoke: BashTool live streaming (stage 24.4).
 *
 * Runs a command that emits lines over time and confirms the bashProgressStore
 * receives incremental snapshots while the command runs, then a final `done`
 * snapshot — the side-channel the live UI card subscribes to.
 */

import { bashTool } from "../tools/bashTool.js";
import { toolResultText } from "../tools/Tool.js";
import { subscribeBashProgress, type BashProgress } from "../state/bashProgressStore.js";

const TOOL_USE_ID = "smoke-stream-1";

async function main(): Promise<void> {
  const snapshots: BashProgress[] = [];
  let sawRunning = false;

  const unsubscribe = subscribeBashProgress((id, snap) => {
    if (id !== TOOL_USE_ID || snap === null) return;
    snapshots.push({ ...snap });
    if (!snap.done && snap.totalLines > 0) sawRunning = true;
  });

  const result = await bashTool.call(
    { command: "for i in 1 2 3 4 5; do echo line$i; sleep 0.1; done" },
    { cwd: process.cwd(), toolUseId: TOOL_USE_ID },
  );

  unsubscribe();

  const last = snapshots[snapshots.length - 1];
  const checks: [string, boolean][] = [
    ["received at least one snapshot", snapshots.length > 0],
    ["saw a mid-run (not-done, lines>0) snapshot", sawRunning],
    ["final snapshot is done", last?.done === true],
    ["final tail contains last line", (last?.output ?? "").includes("line5")],
    ["tool result succeeded", result.isError !== true],
    ["tool result has all output", toolResultText(result.content).includes("line5")],
  ];

  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`${pass ? "✓" : "✗"} ${label}`);
    if (!pass) ok = false;
  }
  console.log(`\nsnapshots=${snapshots.length} finalLines=${last?.totalLines}`);

  if (!ok) {
    console.error("\n[FAIL] bash streaming smoke failed");
    process.exit(1);
  }
  console.log("\n[OK] bash streaming smoke passed");
}

void main();
