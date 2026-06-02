/**
 * Smoke test for stage 26 step 2 — the fileHistory module in isolation
 * (no agent loop). Exercises trackEdit → makeSnapshot → getDiffStats →
 * rewind across edits, new files, and deletes, then asserts the filesystem
 * was restored correctly.
 *
 *   npm run test:filehistory
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  cleanupOldFileHistoryBackups,
  configureFileHistory,
  fileHistoryGetDiffStats,
  fileHistoryMakeSnapshot,
  fileHistoryRewind,
  fileHistoryTrackEdit,
  getSnapshotByOffset,
  restoreFileHistorySnapshots,
  snapshotCount,
} from "../session/fileHistory.js";
import { getSessionPaths, initSessionStorage, restoreSession } from "../session/storage.js";

let failures = 0;
function check(label: string, cond: boolean): void {
  console.log(`${cond ? "  ✓" : "  ✗"} ${label}`);
  if (!cond) failures += 1;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "easy-agent-fh-"));
  const a = path.join(tmp, "a.txt");
  const b = path.join(tmp, "b.txt");

  await fs.writeFile(a, "line1\nline2\n", "utf-8");

  const sessionId = `smoke-${Date.now()}`;
  await configureFileHistory(tmp, sessionId);

  // ── Turn 1 ──────────────────────────────────────────────────────────
  console.log("Turn 1: snapshot, then edit a.txt and create b.txt");
  await fileHistoryMakeSnapshot("t1");

  // pre-edit backup of a.txt (v1 = "line1\nline2\n")
  await fileHistoryTrackEdit(a, "t1");
  await fs.writeFile(a, "line1-EDITED\nline2\nline3\n", "utf-8");

  // b.txt does not exist yet → null backup, then create it.
  await fileHistoryTrackEdit(b, "t1");
  await fs.writeFile(b, "brand new file\n", "utf-8");

  // ── Turn 2 ──────────────────────────────────────────────────────────
  console.log("Turn 2: snapshot (captures post-turn-1 state), edit a.txt again");
  await fileHistoryMakeSnapshot("t2");
  await fileHistoryTrackEdit(a, "t2");
  await fs.writeFile(a, "totally different\n", "utf-8");

  check("two snapshots recorded", snapshotCount() === 2);
  check("offset 1 → latest (t2) snapshot", getSnapshotByOffset(1)?.messageId === "t2");
  check("offset 2 → first (t1) snapshot", getSnapshotByOffset(2)?.messageId === "t1");
  check("offset 3 → undefined (out of range)", getSnapshotByOffset(3) === undefined);

  const backupDir = path.join(os.homedir(), ".easy-agent", "file-history", sessionId);
  check("backup directory created", await exists(backupDir));
  const backups = await fs.readdir(backupDir).catch(() => [] as string[]);
  check(`backup files written (found ${backups.length})`, backups.length >= 2);

  // ── Diff stats preview for rewinding to t1 ──────────────────────────
  const stats = await fileHistoryGetDiffStats("t1");
  console.log(
    `Rewind-to-t1 preview: ${stats.filesChanged.length} file(s), +${stats.insertions} -${stats.deletions}`,
  );
  check("diff preview reports changed files", stats.filesChanged.length >= 1);
  check("diff preview counts line changes", stats.insertions + stats.deletions > 0);

  // ── Rewind to t1: a.txt back to original, b.txt deleted ─────────────
  const changed = await fileHistoryRewind("t1");
  console.log(`Rewound, changed ${changed.length} file(s)`);

  const aContent = await fs.readFile(a, "utf-8");
  check("a.txt restored to original content", aContent === "line1\nline2\n");
  check("b.txt deleted (did not exist at t1)", !(await exists(b)));

  // ── Rewind to a missing snapshot throws ─────────────────────────────
  let threw = false;
  try {
    await fileHistoryRewind("does-not-exist");
  } catch {
    threw = true;
  }
  check("rewind to unknown snapshot throws", threw);

  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});

  // ── Auto-cleanup: stale session dirs prune, fresh ones survive ──────
  console.log("Cleanup: stale backup dir prunes, recent one survives");
  const historyRoot = path.join(os.homedir(), ".easy-agent", "file-history");
  const staleDir = path.join(historyRoot, `smoke-stale-${Date.now()}`);
  const freshDir = path.join(historyRoot, `smoke-fresh-${Date.now()}`);
  await fs.mkdir(staleDir, { recursive: true });
  await fs.mkdir(freshDir, { recursive: true });
  // Backdate the stale dir 40 days (past the 30-day default retention).
  const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  await fs.utimes(staleDir, fortyDaysAgo, fortyDaysAgo);

  // cleanup reads cleanupPeriodDays from cwd settings; tmp2 has none → 30d.
  const tmp2 = await fs.mkdtemp(path.join(os.tmpdir(), "easy-agent-fh-cwd-"));
  await cleanupOldFileHistoryBackups(tmp2);

  check("stale (40-day-old) backup dir pruned", !(await exists(staleDir)));
  check("recent backup dir kept", await exists(freshDir));

  await fs.rm(freshDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(staleDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(tmp2, { recursive: true, force: true }).catch(() => {});

  // ── Resume round-trip: snapshots persist + restore, /rewind survives ─
  console.log("Resume: snapshots persist to transcript, restore, rewind still works");
  const tmp3 = await fs.mkdtemp(path.join(os.tmpdir(), "easy-agent-fh-resume-"));
  const a3 = path.join(tmp3, "a.txt");
  await fs.writeFile(a3, "orig\n", "utf-8");
  const sid = `smoke-resume-${Date.now()}`;
  const nowIso = new Date().toISOString();
  await initSessionStorage({ sessionId: sid, cwd: tmp3, startedAt: nowIso, updatedAt: nowIso, model: "m" });
  await configureFileHistory(tmp3, sid);

  await fileHistoryMakeSnapshot("r1");
  await fileHistoryTrackEdit(a3, "r1");
  await fs.writeFile(a3, "edited\n", "utf-8");
  await fileHistoryMakeSnapshot("r2");
  // recordFileHistorySnapshot is fire-and-forget; let the appends flush.
  await new Promise((r) => setTimeout(r, 300));

  const restored = await restoreSession(tmp3, sid);
  check("transcript persisted 2 snapshots", restored.fileHistorySnapshots.length === 2);

  // Simulate --resume: reset in-memory state, then restore from transcript.
  await configureFileHistory(tmp3, sid);
  check("state reset on (re)configure", snapshotCount() === 0);
  restoreFileHistorySnapshots(restored.fileHistorySnapshots);
  check("restored 2 snapshots from transcript", snapshotCount() === 2);
  check("restored offset 1 = r2", getSnapshotByOffset(1)?.messageId === "r2");
  check("restored offset 2 = r1", getSnapshotByOffset(2)?.messageId === "r1");

  await fileHistoryRewind("r1");
  check("rewind works after resume", (await fs.readFile(a3, "utf-8")) === "orig\n");

  const paths = await getSessionPaths(tmp3, sid);
  await fs.rm(tmp3, { recursive: true, force: true }).catch(() => {});
  await fs.rm(path.dirname(paths.transcriptPath), { recursive: true, force: true }).catch(() => {});
  await fs.rm(path.join(os.homedir(), ".easy-agent", "file-history", sid), { recursive: true, force: true }).catch(() => {});

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
