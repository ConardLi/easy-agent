/**
 * File history & checkpointing — per-edit backups bound to user turns.
 *
 * Reference: claude-code-source-code/src/utils/fileHistory.ts
 *
 * Model (two-phase, turn-bound — same as source):
 *   - `fileHistoryMakeSnapshot(messageId)` fires at the START of each user
 *     turn. It creates a new snapshot bound to that turn's messageId, backing
 *     up every currently-tracked file (creating a new version only when the
 *     file changed since its last backup). The snapshot therefore captures the
 *     filesystem state *before* this turn's edits.
 *   - `fileHistoryTrackEdit(filePath, messageId)` fires BEFORE each Edit/Write.
 *     It backs up the file's pre-edit content (version 1) and attaches it to
 *     the most-recent snapshot, so a later rewind to that turn restores the
 *     original content.
 *   - `fileHistoryRewind(messageId)` writes/deletes tracked files on disk to
 *     match a target snapshot.
 *
 * Backups are full file copies stored under
 *   ~/.easy-agent/file-history/{sessionId}/{pathHash}@v{N}
 * Snapshot metadata is held in-process (a module singleton, since the CLI runs
 * one session per process) and — from stage 26 step 3 — also persisted to the
 * transcript for resume.
 *
 * All IO is best-effort: a backup/restore failure is swallowed so file history
 * can never break the agent loop.
 */

import { createHash } from "node:crypto";
import { Stats } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { diffLines } from "diff";
import { getEasyAgentHome } from "../utils/paths.js";
import { readMergedBooleanSetting, readMergedNumberSetting } from "../utils/settings.js";
import {
  DEFAULT_CLEANUP_PERIOD_DAYS,
  recordFileHistorySnapshot,
  type FileHistorySnapshotRecord,
} from "./storage.js";

/** null backupFileName means "the file did not exist in this version". */
export type BackupFileName = string | null;

export interface FileHistoryBackup {
  backupFileName: BackupFileName;
  version: number;
  backupTime: string;
}

export interface FileHistorySnapshot {
  /** The user-turn id this snapshot binds to. */
  messageId: string;
  /** Map of tracking path → backup for this version. */
  trackedFileBackups: Record<string, FileHistoryBackup>;
  timestamp: string;
}

export interface FileHistoryState {
  snapshots: FileHistorySnapshot[];
  trackedFiles: Set<string>;
  /** Monotonic counter; increments on every snapshot even after eviction. */
  snapshotSequence: number;
}

export interface DiffStats {
  filesChanged: string[];
  insertions: number;
  deletions: number;
}

const MAX_SNAPSHOTS = 100;

// ─── module singleton state ──────────────────────────────────────────────

let enabled = true;
let sessionId = "default";
let cwd = process.cwd();
let state: FileHistoryState = emptyState();

function emptyState(): FileHistoryState {
  return { snapshots: [], trackedFiles: new Set(), snapshotSequence: 0 };
}

function isEnvTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Read the `checkpointingEnabled` setting (default on) and bind the session
 * id + cwd used for backup paths / path shortening. Called once at startup,
 * mirroring storage.ts's `configureSessionPersistence`. An explicit
 * `checkpointingEnabled: false` or the `EASY_AGENT_DISABLE_CHECKPOINTING`
 * env var disables the whole feature.
 */
export async function configureFileHistory(
  projectCwd: string,
  currentSessionId: string,
): Promise<void> {
  cwd = projectCwd;
  sessionId = currentSessionId;
  state = emptyState();
  let setting: boolean | undefined;
  try {
    setting = await readMergedBooleanSetting(projectCwd, "checkpointingEnabled");
  } catch {
    setting = undefined;
  }
  enabled =
    setting !== false &&
    !isEnvTruthy(process.env.EASY_AGENT_DISABLE_CHECKPOINTING);
}

export function fileHistoryEnabled(): boolean {
  return enabled;
}

/**
 * Prune stale backup directories under ~/.easy-agent/file-history. Mirrors
 * source's `cleanupOldFileHistoryBackups`: each *session* directory is removed
 * wholesale once its mtime is older than the retention cutoff. Retention reuses
 * the same `cleanupPeriodDays` setting as transcripts (default 30); a value of
 * `0` (persistence disabled) prunes everything. Best-effort and run at startup.
 */
export async function cleanupOldFileHistoryBackups(cwd: string): Promise<void> {
  let periodDays = DEFAULT_CLEANUP_PERIOD_DAYS;
  try {
    const configured = await readMergedNumberSetting(cwd, "cleanupPeriodDays");
    if (typeof configured === "number" && Number.isFinite(configured) && configured >= 0) {
      periodDays = Math.floor(configured);
    }
  } catch {
    // keep default
  }

  const root = join(getEasyAgentHome(), "file-history");
  let dirents;
  try {
    dirents = await readdir(root, { withFileTypes: true });
  } catch (e) {
    if (isENOENT(e)) return;
    return;
  }

  const cutoffMs = Date.now() - periodDays * 24 * 60 * 60 * 1000;
  await Promise.all(
    dirents
      .filter((d) => d.isDirectory())
      .map(async (d) => {
        const sessionDir = join(root, d.name);
        try {
          // periodDays === 0 → cutoff is "now", so every dir prunes.
          const stats = await stat(sessionDir);
          if (stats.mtimeMs < cutoffMs) {
            await rm(sessionDir, { recursive: true, force: true });
          }
        } catch {
          // best-effort per directory
        }
      }),
  );
}

export function getFileHistoryState(): FileHistoryState {
  return state;
}

/** Test/init hook: replace the in-memory state wholesale (e.g. on resume). */
export function setFileHistoryState(next: FileHistoryState): void {
  state = next;
}

/**
 * Rebuild the in-memory state from snapshots persisted to the transcript
 * (returned by storage.restoreSession). Called on `--resume` after
 * configureFileHistory so `/rewind` can target turns from the prior run.
 * Since easy-agent reuses the session id on resume, the backup files already
 * live under the right directory — no migration needed.
 */
export function restoreFileHistorySnapshots(
  records: FileHistorySnapshotRecord[],
): void {
  if (!enabled || records.length === 0) return;
  const trackedFiles = new Set<string>();
  const snapshots: FileHistorySnapshot[] = records.map((rec) => {
    for (const key of Object.keys(rec.trackedFileBackups)) {
      trackedFiles.add(key);
    }
    return {
      messageId: rec.messageId,
      trackedFileBackups: rec.trackedFileBackups,
      timestamp: rec.timestamp,
    };
  });
  state = { snapshots, trackedFiles, snapshotSequence: snapshots.length };
}

// ─── phase 1: track an edit (backup pre-edit content) ─────────────────────

/**
 * Back up `filePath`'s current content before it is edited/created, attaching
 * the backup to the most-recent snapshot. No-op if the file is already tracked
 * in that snapshot (so repeat edits in the same turn never clobber v1).
 */
export async function fileHistoryTrackEdit(
  filePath: string,
  messageId: string,
): Promise<void> {
  if (!enabled) return;

  const trackingPath = maybeShortenFilePath(filePath);

  // Ensure there's a snapshot to attach to. In normal operation makeSnapshot
  // fires at turn start, but track-before-snapshot must not silently drop the
  // backup, so open an empty snapshot for this turn if none exists.
  if (state.snapshots.length === 0) {
    state.snapshots.push({
      messageId,
      trackedFileBackups: {},
      timestamp: new Date().toISOString(),
    });
    state.snapshotSequence += 1;
  }

  const mostRecent = state.snapshots[state.snapshots.length - 1]!;
  if (mostRecent.trackedFileBackups[trackingPath]) {
    // Already tracked this turn; the next makeSnapshot re-checks for changes.
    return;
  }

  let backup: FileHistoryBackup;
  try {
    backup = await createBackup(filePath, 1);
  } catch {
    return;
  }

  state.trackedFiles.add(trackingPath);
  mostRecent.trackedFileBackups[trackingPath] = backup;

  // Persist the updated snapshot so /rewind survives --resume.
  void recordFileHistorySnapshot(cwd, sessionId, mostRecent).catch(() => {});
}

// ─── phase 2: make a turn snapshot ────────────────────────────────────────

/**
 * Create a snapshot bound to `messageId`, backing up every tracked file
 * (reusing the latest backup when the file is unchanged). Pushes the snapshot
 * and evicts the oldest once past MAX_SNAPSHOTS.
 */
export async function fileHistoryMakeSnapshot(messageId: string): Promise<void> {
  if (!enabled) return;

  const trackedFileBackups: Record<string, FileHistoryBackup> = {};
  const mostRecentSnapshot = state.snapshots[state.snapshots.length - 1];

  await Promise.all(
    Array.from(state.trackedFiles, async (trackingPath) => {
      try {
        const filePath = maybeExpandFilePath(trackingPath);
        const latestBackup = mostRecentSnapshot?.trackedFileBackups[trackingPath];
        const nextVersion = latestBackup ? latestBackup.version + 1 : 1;

        let fileStats: Stats | undefined;
        try {
          fileStats = await stat(filePath);
        } catch (e) {
          if (!isENOENT(e)) throw e;
        }

        if (!fileStats) {
          trackedFileBackups[trackingPath] = {
            backupFileName: null,
            version: nextVersion,
            backupTime: new Date().toISOString(),
          };
          return;
        }

        if (
          latestBackup &&
          latestBackup.backupFileName !== null &&
          !(await checkOriginFileChanged(filePath, latestBackup.backupFileName, fileStats))
        ) {
          trackedFileBackups[trackingPath] = latestBackup;
          return;
        }

        trackedFileBackups[trackingPath] = await createBackup(filePath, nextVersion);
      } catch {
        // best-effort per file
      }
    }),
  );

  const newSnapshot: FileHistorySnapshot = {
    messageId,
    trackedFileBackups,
    timestamp: new Date().toISOString(),
  };
  state.snapshots.push(newSnapshot);
  if (state.snapshots.length > MAX_SNAPSHOTS) {
    state.snapshots = state.snapshots.slice(-MAX_SNAPSHOTS);
  }
  state.snapshotSequence += 1;

  // Persist the new snapshot so /rewind survives --resume.
  void recordFileHistorySnapshot(cwd, sessionId, newSnapshot).catch(() => {});
}

// ─── phase 3: rewind / diff ───────────────────────────────────────────────

/**
 * Resolve a target snapshot by going back `offset` turns (1 = the most recent
 * snapshot). Returns undefined if there aren't that many snapshots.
 */
export function getSnapshotByOffset(offset: number): FileHistorySnapshot | undefined {
  if (offset < 1) return undefined;
  return state.snapshots[state.snapshots.length - offset];
}

export function getSnapshotById(messageId: string): FileHistorySnapshot | undefined {
  return [...state.snapshots].reverse().find((s) => s.messageId === messageId);
}

export function snapshotCount(): number {
  return state.snapshots.length;
}

/**
 * Restore the filesystem to a target snapshot. Returns the list of files that
 * were actually changed on disk (expanded absolute paths).
 */
export async function fileHistoryRewind(messageId: string): Promise<string[]> {
  if (!enabled) return [];
  const target = getSnapshotById(messageId);
  if (!target) {
    throw new Error("The selected snapshot was not found");
  }
  return applySnapshot(target);
}

/**
 * Compute the diff stats (files changed + inserted/deleted lines) that
 * rewinding to `messageId` would produce — used for the `/rewind` preview.
 */
export async function fileHistoryGetDiffStats(messageId: string): Promise<DiffStats> {
  const empty: DiffStats = { filesChanged: [], insertions: 0, deletions: 0 };
  if (!enabled) return empty;
  const target = getSnapshotById(messageId);
  if (!target) return empty;

  const results = await Promise.all(
    Array.from(state.trackedFiles, async (trackingPath) => {
      try {
        const filePath = maybeExpandFilePath(trackingPath);
        const targetBackup = target.trackedFileBackups[trackingPath];
        const backupFileName: BackupFileName | undefined = targetBackup
          ? targetBackup.backupFileName
          : getBackupFileNameFirstVersion(trackingPath);
        if (backupFileName === undefined) return null;

        const stats = await computeDiffStatsForFile(
          filePath,
          backupFileName === null ? undefined : backupFileName,
        );
        if (stats.insertions || stats.deletions) {
          return { filePath, stats };
        }
        return null;
      } catch {
        return null;
      }
    }),
  );

  const out: DiffStats = { filesChanged: [], insertions: 0, deletions: 0 };
  for (const r of results) {
    if (!r) continue;
    out.filesChanged.push(r.filePath);
    out.insertions += r.stats.insertions;
    out.deletions += r.stats.deletions;
  }
  return out;
}

async function applySnapshot(target: FileHistorySnapshot): Promise<string[]> {
  const filesChanged: string[] = [];
  for (const trackingPath of state.trackedFiles) {
    try {
      const filePath = maybeExpandFilePath(trackingPath);
      const targetBackup = target.trackedFileBackups[trackingPath];
      const backupFileName: BackupFileName | undefined = targetBackup
        ? targetBackup.backupFileName
        : getBackupFileNameFirstVersion(trackingPath);

      if (backupFileName === undefined) continue;

      if (backupFileName === null) {
        // File did not exist at the target version; delete it if present.
        try {
          await unlink(filePath);
          filesChanged.push(filePath);
        } catch (e) {
          if (!isENOENT(e)) throw e;
        }
        continue;
      }

      if (await checkOriginFileChanged(filePath, backupFileName)) {
        await restoreBackup(filePath, backupFileName);
        filesChanged.push(filePath);
      }
    } catch {
      // best-effort per file
    }
  }
  return filesChanged;
}

// ─── backup helpers ───────────────────────────────────────────────────────

function getBackupFileName(filePath: string, version: number): string {
  const hash = createHash("sha256").update(filePath).digest("hex").slice(0, 16);
  return `${hash}@v${version}`;
}

function resolveBackupPath(backupFileName: string): string {
  return join(getEasyAgentHome(), "file-history", sessionId, backupFileName);
}

async function createBackup(
  filePath: string | null,
  version: number,
): Promise<FileHistoryBackup> {
  const backupTime = new Date().toISOString();
  if (filePath === null) {
    return { backupFileName: null, version, backupTime };
  }

  const backupFileName = getBackupFileName(filePath, version);
  const backupPath = resolveBackupPath(backupFileName);

  let srcStats: Stats;
  try {
    srcStats = await stat(filePath);
  } catch (e) {
    if (isENOENT(e)) return { backupFileName: null, version, backupTime };
    throw e;
  }

  try {
    await copyFile(filePath, backupPath);
  } catch (e) {
    if (!isENOENT(e)) throw e;
    await mkdir(dirname(backupPath), { recursive: true });
    await copyFile(filePath, backupPath);
  }
  await chmod(backupPath, srcStats.mode);

  return { backupFileName, version, backupTime };
}

async function restoreBackup(filePath: string, backupFileName: string): Promise<void> {
  const backupPath = resolveBackupPath(backupFileName);
  let backupStats: Stats;
  try {
    backupStats = await stat(backupPath);
  } catch (e) {
    if (isENOENT(e)) return;
    throw e;
  }

  try {
    await copyFile(backupPath, filePath);
  } catch (e) {
    if (!isENOENT(e)) throw e;
    await mkdir(dirname(filePath), { recursive: true });
    await copyFile(backupPath, filePath);
  }
  await chmod(filePath, backupStats.mode);
}

/**
 * Earliest (v1) backup name for a file — used when rewinding to a snapshot
 * that predates the file being tracked. Returns null if the file did not exist
 * in v1, or undefined when no v1 can be found at all.
 */
function getBackupFileNameFirstVersion(trackingPath: string): BackupFileName | undefined {
  for (const snapshot of state.snapshots) {
    const backup = snapshot.trackedFileBackups[trackingPath];
    if (backup !== undefined && backup.version === 1) {
      return backup.backupFileName;
    }
  }
  return undefined;
}

// ─── change detection ───────────────────────────────────────────────────

export async function checkOriginFileChanged(
  originalFile: string,
  backupFileName: string,
  originalStatsHint?: Stats,
): Promise<boolean> {
  const backupPath = resolveBackupPath(backupFileName);

  let originalStats: Stats | null = originalStatsHint ?? null;
  if (!originalStats) {
    try {
      originalStats = await stat(originalFile);
    } catch (e) {
      if (!isENOENT(e)) return true;
    }
  }
  let backupStats: Stats | null = null;
  try {
    backupStats = await stat(backupPath);
  } catch (e) {
    if (!isENOENT(e)) return true;
  }

  // One exists, one missing → changed.
  if ((originalStats === null) !== (backupStats === null)) return true;
  // Both missing → unchanged.
  if (originalStats === null || backupStats === null) return false;
  // Cheap stat comparison first.
  if (originalStats.mode !== backupStats.mode || originalStats.size !== backupStats.size) {
    return true;
  }
  // If original is older than the backup, content can't have diverged.
  if (originalStats.mtimeMs < backupStats.mtimeMs) return false;

  try {
    const [a, b] = await Promise.all([
      readFile(originalFile, "utf-8"),
      readFile(backupPath, "utf-8"),
    ]);
    return a !== b;
  } catch {
    return true;
  }
}

async function computeDiffStatsForFile(
  originalFile: string,
  backupFileName?: string,
): Promise<{ insertions: number; deletions: number }> {
  let insertions = 0;
  let deletions = 0;
  try {
    const backupPath = backupFileName ? resolveBackupPath(backupFileName) : undefined;
    const [originalContent, backupContent] = await Promise.all([
      readFileOrNull(originalFile),
      backupPath ? readFileOrNull(backupPath) : Promise.resolve(null),
    ]);
    if (originalContent === null && backupContent === null) {
      return { insertions, deletions };
    }
    const changes = diffLines(originalContent ?? "", backupContent ?? "");
    for (const c of changes) {
      if (c.added) insertions += c.count ?? 0;
      if (c.removed) deletions += c.count ?? 0;
    }
  } catch {
    // best-effort
  }
  return { insertions, deletions };
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

// ─── path normalization ───────────────────────────────────────────────────

/** Store tracked files relative to cwd when possible (smaller transcript). */
function maybeShortenFilePath(filePath: string): string {
  if (!isAbsolute(filePath)) return filePath;
  if (filePath.startsWith(cwd)) return relative(cwd, filePath);
  return filePath;
}

function maybeExpandFilePath(filePath: string): string {
  if (isAbsolute(filePath)) return filePath;
  return join(cwd, filePath);
}

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
