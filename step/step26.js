/**
 * Step 26 - File history and rewind
 *
 * Goal:
 * - attach file snapshots to user message turns
 * - back up pre-edit content before Write/Edit changes a file
 * - restore the workspace to an earlier message snapshot
 * - preview rewind impact with file and line statistics
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// -----------------------------------------------------------------------------
// 1. Transcript messages now carry stable messageId values
// -----------------------------------------------------------------------------

export function createTranscriptMessage(role, content, extra = {}) {
  return {
    messageId: extra.messageId || randomUUID(),
    role,
    content,
    timestamp: extra.timestamp || new Date().toISOString(),
    ...extra,
  };
}

export class TranscriptStore {
  constructor() {
    this.entries = [];
  }

  appendMessage(role, content, extra = {}) {
    const message = createTranscriptMessage(role, content, extra);
    this.entries.push({ type: "message", message });
    return message;
  }

  appendFileHistorySnapshot(sessionId, snapshot) {
    this.entries.push({
      type: "file_history_snapshot",
      sessionId,
      snapshot,
    });
  }

  restoreFileHistorySnapshots(sessionId) {
    return this.entries
      .filter((entry) => entry.type === "file_history_snapshot" && entry.sessionId === sessionId)
      .map((entry) => entry.snapshot);
  }
}

// -----------------------------------------------------------------------------
// 2. File history store
// -----------------------------------------------------------------------------

const MAX_SNAPSHOTS = 100;

export function getEasyAgentHome() {
  return process.env.EASY_AGENT_HOME || path.join(os.homedir(), ".easy-agent");
}

export function createFileHistoryStore(options = {}) {
  const sessionId = options.sessionId || "default";
  const cwd = path.resolve(options.cwd || process.cwd());
  const transcript = options.transcript || null;
  const enabled = options.enabled !== false;

  const state = {
    snapshots: [],
    trackedFiles: new Set(),
    snapshotSequence: 0,
  };

  function maybeShorten(filePath) {
    const absolute = path.resolve(cwd, filePath);
    return absolute.startsWith(cwd) ? path.relative(cwd, absolute) : absolute;
  }

  function maybeExpand(trackingPath) {
    return path.isAbsolute(trackingPath) ? trackingPath : path.join(cwd, trackingPath);
  }

  function backupName(filePath, version) {
    const hash = createHash("sha256").update(path.resolve(filePath)).digest("hex").slice(0, 16);
    return `${hash}@v${version}`;
  }

  function backupPath(name) {
    return path.join(getEasyAgentHome(), "file-history", sessionId, name);
  }

  async function createBackup(filePath, version) {
    const time = new Date().toISOString();
    try {
      await fs.stat(filePath);
    } catch (error) {
      if (error.code === "ENOENT") return { backupFileName: null, version, backupTime: time };
      throw error;
    }

    const name = backupName(filePath, version);
    const target = backupPath(name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(filePath, target);
    return { backupFileName: name, version, backupTime: time };
  }

  async function readFileOrNull(filePath) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch {
      return null;
    }
  }

  async function backupContent(backupFileName) {
    if (backupFileName === null) return null;
    return readFileOrNull(backupPath(backupFileName));
  }

  async function fileChangedFromBackup(filePath, backupFileName) {
    const [current, backup] = await Promise.all([readFileOrNull(filePath), backupContent(backupFileName)]);
    return current !== backup;
  }

  function mostRecentSnapshot() {
    return state.snapshots[state.snapshots.length - 1];
  }

  function recordSnapshot(snapshot) {
    transcript?.appendFileHistorySnapshot(sessionId, snapshot);
  }

  async function trackEdit(filePath, messageId) {
    if (!enabled) return;
    const absolute = path.resolve(cwd, filePath);
    const trackingPath = maybeShorten(absolute);

    if (!mostRecentSnapshot()) {
      state.snapshots.push({
        messageId,
        trackedFileBackups: {},
        timestamp: new Date().toISOString(),
      });
      state.snapshotSequence += 1;
    }

    const snapshot = mostRecentSnapshot();
    if (snapshot.trackedFileBackups[trackingPath]) return;

    const backup = await createBackup(absolute, 1);
    state.trackedFiles.add(trackingPath);
    snapshot.trackedFileBackups[trackingPath] = backup;
    recordSnapshot(snapshot);
  }

  async function makeSnapshot(messageId) {
    if (!enabled) return;
    const latest = mostRecentSnapshot();
    const trackedFileBackups = {};

    for (const trackingPath of state.trackedFiles) {
      const absolute = maybeExpand(trackingPath);
      const latestBackup = latest?.trackedFileBackups[trackingPath];
      const version = latestBackup ? latestBackup.version + 1 : 1;

      if (latestBackup && !(await fileChangedFromBackup(absolute, latestBackup.backupFileName))) {
        trackedFileBackups[trackingPath] = latestBackup;
      } else {
        trackedFileBackups[trackingPath] = await createBackup(absolute, version);
      }
    }

    const snapshot = {
      messageId,
      trackedFileBackups,
      timestamp: new Date().toISOString(),
    };

    state.snapshots.push(snapshot);
    if (state.snapshots.length > MAX_SNAPSHOTS) {
      state.snapshots.splice(0, state.snapshots.length - MAX_SNAPSHOTS);
    }
    state.snapshotSequence += 1;
    recordSnapshot(snapshot);
  }

  function getSnapshotById(messageId) {
    return [...state.snapshots].reverse().find((snapshot) => snapshot.messageId === messageId);
  }

  function getSnapshotByOffset(offset) {
    if (offset < 1) return undefined;
    return state.snapshots[state.snapshots.length - offset];
  }

  function earliestBackupFor(trackingPath) {
    for (const snapshot of state.snapshots) {
      const backup = snapshot.trackedFileBackups[trackingPath];
      if (backup?.version === 1) return backup.backupFileName;
    }
    return undefined;
  }

  async function restoreBackup(filePath, backupFileName) {
    if (backupFileName === null) {
      await fs.rm(filePath, { force: true });
      return;
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.copyFile(backupPath(backupFileName), filePath);
  }

  async function applySnapshot(snapshot) {
    const changed = [];

    for (const trackingPath of state.trackedFiles) {
      const absolute = maybeExpand(trackingPath);
      const backup =
        snapshot.trackedFileBackups[trackingPath]?.backupFileName ??
        earliestBackupFor(trackingPath);

      if (backup === undefined) continue;
      if (await fileChangedFromBackup(absolute, backup)) {
        await restoreBackup(absolute, backup);
        changed.push(absolute);
      }
    }

    return changed;
  }

  async function rewind(messageId) {
    if (!enabled) return [];
    const snapshot = getSnapshotById(messageId);
    if (!snapshot) throw new Error(`Snapshot not found: ${messageId}`);
    return applySnapshot(snapshot);
  }

  async function diffStatsForFile(filePath, backupFileName) {
    const [current, backup] = await Promise.all([
      readFileOrNull(filePath),
      backupContent(backupFileName),
    ]);
    const diff = countLineDiff(current ?? "", backup ?? "");
    return diff;
  }

  async function getDiffStats(messageId) {
    const snapshot = getSnapshotById(messageId);
    if (!snapshot) return { filesChanged: [], insertions: 0, deletions: 0 };

    const out = { filesChanged: [], insertions: 0, deletions: 0 };
    for (const trackingPath of state.trackedFiles) {
      const absolute = maybeExpand(trackingPath);
      const backup =
        snapshot.trackedFileBackups[trackingPath]?.backupFileName ??
        earliestBackupFor(trackingPath);

      if (backup === undefined) continue;
      const stats = await diffStatsForFile(absolute, backup);
      if (stats.insertions || stats.deletions) {
        out.filesChanged.push(absolute);
        out.insertions += stats.insertions;
        out.deletions += stats.deletions;
      }
    }
    return out;
  }

  function restoreSnapshots(snapshots) {
    state.snapshots = snapshots.map((snapshot) => ({
      messageId: snapshot.messageId,
      trackedFileBackups: snapshot.trackedFileBackups,
      timestamp: snapshot.timestamp,
    }));
    state.trackedFiles = new Set();
    for (const snapshot of state.snapshots) {
      for (const trackingPath of Object.keys(snapshot.trackedFileBackups)) {
        state.trackedFiles.add(trackingPath);
      }
    }
    state.snapshotSequence = state.snapshots.length;
  }

  return {
    state,
    trackEdit,
    makeSnapshot,
    rewind,
    getDiffStats,
    getSnapshotById,
    getSnapshotByOffset,
    restoreSnapshots,
  };
}

// -----------------------------------------------------------------------------
// 3. Diff preview
// -----------------------------------------------------------------------------

export function countLineDiff(fromText, toText) {
  const from = String(fromText).split(/\r?\n/);
  const to = String(toText).split(/\r?\n/);
  const max = Math.max(from.length, to.length);
  let insertions = 0;
  let deletions = 0;

  for (let i = 0; i < max; i += 1) {
    if (from[i] === to[i]) continue;
    if (from[i] !== undefined) deletions += 1;
    if (to[i] !== undefined) insertions += 1;
  }

  return { insertions, deletions };
}

export function formatRewindPreview(snapshot, stats) {
  if (!snapshot) return ["No snapshot selected"];
  return [
    `Rewind to ${snapshot.messageId}`,
    `${stats.filesChanged.length} files, +${stats.insertions} -${stats.deletions}`,
    ...stats.filesChanged.map((file) => `  ${file}`),
  ];
}

// -----------------------------------------------------------------------------
// 4. Tool integration wrappers
// -----------------------------------------------------------------------------

export async function runWriteToolWithHistory(history, messageId, filePath, content) {
  await history.trackEdit(filePath, messageId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return { ok: true, filePath };
}

export async function runEditToolWithHistory(history, messageId, filePath, oldText, newText) {
  await history.trackEdit(filePath, messageId);
  const current = await fs.readFile(filePath, "utf8");
  if (!current.includes(oldText)) {
    throw new Error("oldText not found");
  }
  await fs.writeFile(filePath, current.replace(oldText, newText), "utf8");
  return { ok: true, filePath };
}

export async function handleRewindCommand(history, argv) {
  const offset = Number(argv[0] || "1");
  const snapshot = history.getSnapshotByOffset(offset);
  if (!snapshot) return { error: `No snapshot at offset ${offset}` };
  const stats = await history.getDiffStats(snapshot.messageId);
  const preview = formatRewindPreview(snapshot, stats);
  const changed = await history.rewind(snapshot.messageId);
  return { preview, changed };
}

// -----------------------------------------------------------------------------
// 5. Demo
// -----------------------------------------------------------------------------

export async function demoStep26() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "easy-agent-step26-"));
  process.env.EASY_AGENT_HOME = path.join(cwd, "home");
  const transcript = new TranscriptStore();
  const history = createFileHistoryStore({ cwd, sessionId: "session-1", transcript });
  const filePath = path.join(cwd, "notes.txt");

  const firstTurn = transcript.appendMessage("user", "create notes");
  await history.makeSnapshot(firstTurn.messageId);
  await runWriteToolWithHistory(history, firstTurn.messageId, filePath, "alpha\nbeta\n");

  const secondTurn = transcript.appendMessage("user", "update notes");
  await history.makeSnapshot(secondTurn.messageId);
  await runEditToolWithHistory(history, secondTurn.messageId, filePath, "beta", "gamma\ndelta");

  const stats = await history.getDiffStats(secondTurn.messageId);
  const changed = await history.rewind(secondTurn.messageId);
  const restored = await fs.readFile(filePath, "utf8").catch(() => null);

  const resumed = createFileHistoryStore({ cwd, sessionId: "session-1", transcript });
  resumed.restoreSnapshots(transcript.restoreFileHistorySnapshots("session-1"));

  return {
    snapshots: history.state.snapshots.length,
    stats,
    changed: changed.map((file) => path.relative(cwd, file)),
    restored,
    resumedSnapshotMessages: new Set(resumed.state.snapshots.map((s) => s.messageId)).size,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await demoStep26(), null, 2));
}
