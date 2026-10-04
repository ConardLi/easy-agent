import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Dirent } from "node:fs";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { Usage } from "../types/message.js";
import { getProjectPathInfo } from "../context/memory/memdir.js";
import { getEasyAgentHome } from "../utils/paths.js";
import { appendPrivateFile, ensurePrivateDirectory, writePrivateFile } from "../utils/privateData.js";
import { PersistentDataError, withFileLock } from "../utils/atomicFile.js";

const MAX_SESSIONS = 20;

/** Default transcript retention when `cleanupPeriodDays` is unset. */
export const DEFAULT_CLEANUP_PERIOD_DAYS = 30;

// ─── persistence policy (set once at startup) ────────────────────────────
//
// `cleanupPeriodDays: 0` disables session persistence entirely: no transcripts
// are written and existing ones are deleted at startup. We gate the write
// primitives on this module-level flag so every call site (queryEngine, hooks,
// compaction) honors it without threading a parameter through each one.

let persistenceEnabled = true;

/** Enable/disable transcript writes for this session (driven by cleanupPeriodDays). */
export function configureSessionPersistence(enabled: boolean): void {
  persistenceEnabled = enabled;
}

export function isSessionPersistenceEnabled(): boolean {
  return persistenceEnabled;
}

export interface SessionPaths {
  rootDir: string;
  projectDir: string;
  transcriptPath: string;
  latestPath: string;
}

export interface SessionMetadata {
  sessionId: string;
  cwd: string;
  startedAt: string;
  updatedAt: string;
  model: string;
}

export interface SessionSummary {
  sessionId: string;
  cwd: string;
  startedAt: string;
  updatedAt: string;
  model: string;
  messageCount: number;
  totalUsage: Usage;
  /** The first user prompt, used as a human-readable label (may be empty). */
  firstPrompt: string;
  /** A title the user gave the session, if any. */
  title?: string;
}

/**
 * Serialized file-history snapshot persisted to the transcript so
 * `/rewind` survives `--resume`. Structurally matches fileHistory.ts's
 * FileHistoryBackup / FileHistorySnapshot (kept local here to avoid a
 * session↔session import cycle).
 */
export interface FileHistoryBackupRecord {
  backupFileName: string | null;
  version: number;
  backupTime: string;
}
export interface FileHistorySnapshotRecord {
  messageId: string;
  trackedFileBackups: Record<string, FileHistoryBackupRecord>;
  timestamp: string;
}

export type TranscriptEntry =
  | { type: "session_meta"; sessionId: string; cwd: string; startedAt: string; model: string }
  | { type: "message"; timestamp: string; role: "user" | "assistant"; message: MessageParam; messageId?: string }
  | {
      type: "tool_event";
      timestamp: string;
      name: string;
      phase: "start" | "done";
      resultLength?: number;
      isError?: boolean;
    }
  | { type: "usage"; timestamp: string; turn: Usage; total: Usage }
  | { type: "system"; timestamp: string; level: "info" | "error"; message: string }
  | {
      /**
       * A boundary: resume starts from the messages written after the last
       * one. Compaction writes the compacted conversation after it; clearing
       * the context (`/clear`, a plan approved with a context clear) writes
       * none and marks `reason: "clear"`. Readers that predate `reason` treat
       * a clear as a manual compaction to an empty conversation.
       */
      type: "compaction";
      timestamp: string;
      trigger: "auto" | "manual";
      reason?: "clear";
    }
  | { type: "file_history_snapshot"; timestamp: string; snapshot: FileHistorySnapshotRecord };

export interface RestoredSession {
  summary: SessionSummary;
  messages: MessageParam[];
  /** Reconstructed file-history snapshots (chronological), if any. */
  fileHistorySnapshots: FileHistorySnapshotRecord[];
}

function createEmptyUsage(): Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
  };
}

function isUsage(value: unknown): value is Usage {
  if (!value || typeof value !== "object") return false;
  const usage = value as Record<string, unknown>;
  return typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number";
}

function isMessageParam(value: unknown): value is MessageParam {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (record.role === "user" || record.role === "assistant") && "content" in record;
}

function parseJsonLine(line: string): TranscriptEntry | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;

    if (parsed.type === "session_meta") {
      if (
        typeof parsed.sessionId === "string" &&
        typeof parsed.cwd === "string" &&
        typeof parsed.startedAt === "string" &&
        typeof parsed.model === "string"
      ) {
        return {
          type: "session_meta",
          sessionId: parsed.sessionId,
          cwd: parsed.cwd,
          startedAt: parsed.startedAt,
          model: parsed.model,
        };
      }
      return null;
    }

    if (parsed.type === "message") {
      if (
        typeof parsed.timestamp === "string" &&
        (parsed.role === "user" || parsed.role === "assistant") &&
        isMessageParam(parsed.message)
      ) {
        return {
          type: "message",
          timestamp: parsed.timestamp,
          role: parsed.role,
          message: parsed.message,
          // Optional for back-compat: transcripts written before file
          // history existed have no per-message id. Snapshots bind to this
          // id, so resume relies on it being preserved when present.
          ...(typeof parsed.messageId === "string" ? { messageId: parsed.messageId } : {}),
        };
      }
      return null;
    }

    if (parsed.type === "tool_event") {
      if (
        typeof parsed.timestamp === "string" &&
        typeof parsed.name === "string" &&
        (parsed.phase === "start" || parsed.phase === "done")
      ) {
        return {
          type: "tool_event",
          timestamp: parsed.timestamp,
          name: parsed.name,
          phase: parsed.phase,
          ...(typeof parsed.resultLength === "number" ? { resultLength: parsed.resultLength } : {}),
          ...(typeof parsed.isError === "boolean" ? { isError: parsed.isError } : {}),
        };
      }
      return null;
    }

    if (parsed.type === "usage") {
      if (typeof parsed.timestamp === "string" && isUsage(parsed.turn) && isUsage(parsed.total)) {
        return {
          type: "usage",
          timestamp: parsed.timestamp,
          turn: parsed.turn,
          total: parsed.total,
        };
      }
      return null;
    }

    if (parsed.type === "system") {
      if (
        typeof parsed.timestamp === "string" &&
        (parsed.level === "info" || parsed.level === "error") &&
        typeof parsed.message === "string"
      ) {
        return {
          type: "system",
          timestamp: parsed.timestamp,
          level: parsed.level,
          message: parsed.message,
        };
      }
      return null;
    }

    if (parsed.type === "compaction") {
      if (typeof parsed.timestamp === "string" && (parsed.trigger === "auto" || parsed.trigger === "manual")) {
        return {
          type: "compaction",
          timestamp: parsed.timestamp,
          trigger: parsed.trigger,
          ...(parsed.reason === "clear" ? { reason: "clear" as const } : {}),
        };
      }
      return null;
    }

    if (parsed.type === "file_history_snapshot") {
      const snap = parsed.snapshot as Record<string, unknown> | undefined;
      if (
        typeof parsed.timestamp === "string" &&
        snap &&
        typeof snap === "object" &&
        typeof snap.messageId === "string" &&
        typeof snap.trackedFileBackups === "object" &&
        snap.trackedFileBackups !== null &&
        typeof snap.timestamp === "string"
      ) {
        return {
          type: "file_history_snapshot",
          timestamp: parsed.timestamp,
          snapshot: snap as unknown as FileHistorySnapshotRecord,
        };
      }
      return null;
    }

    return null;
  } catch {
    return null;
  }
}

function getLastUpdatedAt(entries: TranscriptEntry[], fallback: string): string {
  const latest = [...entries]
    .reverse()
    .find((entry): entry is Extract<TranscriptEntry, { timestamp: string }> => "timestamp" in entry);

  return latest?.timestamp ?? fallback;
}

/**
 * The first user prompt of a session, used as its human-readable label in the
 * `/resume` picker. XML command/skill
 * markers are stripped so a `/foo` invocation shows its text, not raw tags.
 */
/**
 * Context the engine adds to the conversation on its own. Transcripts keep
 * these so a resumed session sees the same context, but they are never the
 * prompt a person typed.
 */
const HIDDEN_PROMPT_PREFIXES = [
  "[session-start]",
  "[plan_mode_attachment]",
  "[plan_mode_exit]",
  "[ultrathink]",
  "[context_update]",
  "[task-notification]",
  "[skill_invocation:",
  "[command_invocation:",
  "[CompactBoundary]",
  "This session is being continued from a previous conversation",
];

function messageText(message: MessageParam): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => (block as { type?: string }).type === "text")
    .map((block) => (block as { text?: string }).text ?? "")
    .join(" ");
}

function extractFirstPrompt(messages: MessageParam[]): string {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = messageText(message).trimStart();
    if (!text || HIDDEN_PROMPT_PREFIXES.some((prefix) => text.startsWith(prefix))) continue;
    return text
      .replace(/^\[user-context\]\s*/, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

/** Session ids are generated UUIDs; anything else is rejected before it reaches a path. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

function assertSessionId(sessionId: string): void {
  if (!isValidSessionId(sessionId)) throw new Error(`Invalid session id: ${JSON.stringify(sessionId)}`);
}

export function createSessionId(): string {
  return crypto.randomUUID();
}

export async function getProjectHash(cwd: string): Promise<string> {
  const info = await getProjectPathInfo(cwd);
  return info.projectKey;
}

export async function getSessionPaths(cwd: string, sessionId: string): Promise<SessionPaths> {
  const info = await getProjectPathInfo(cwd);
  return {
    rootDir: getEasyAgentHome(),
    projectDir: info.projectDir,
    transcriptPath: path.join(info.projectDir, `${sessionId}.jsonl`),
    latestPath: path.join(info.projectDir, "latest"),
  };
}

async function ensureSessionDir(paths: SessionPaths): Promise<void> {
  await ensurePrivateDirectory(paths.projectDir);
}

export async function initSessionStorage(metadata: SessionMetadata): Promise<SessionPaths> {
  const paths = await getSessionPaths(metadata.cwd, metadata.sessionId);
  // Persistence disabled (cleanupPeriodDays:0): return valid paths so the UI
  // keeps working, but never touch disk — no dir, no transcript, no pointer.
  if (!persistenceEnabled) return paths;
  await ensureSessionDir(paths);

  const metaEntry: TranscriptEntry = {
    type: "session_meta",
    sessionId: metadata.sessionId,
    cwd: metadata.cwd,
    startedAt: metadata.startedAt,
    model: metadata.model,
  };

  await withFileLock(paths.transcriptPath, () =>
    appendPrivateFile(paths.transcriptPath, `${JSON.stringify(metaEntry)}\n`),
  );
  await writePrivateFile(paths.latestPath, `${metadata.sessionId}\n`);
  return paths;
}

/**
 * Persist a file-history snapshot to the transcript. Called by
 * fileHistory.ts whenever a snapshot is created (makeSnapshot) or updated
 * (trackEdit). On `--resume`, restoreSession folds these back into the
 * in-memory FileHistoryState so `/rewind` keeps working. No-op when
 * persistence is disabled (handled by appendTranscriptEntry).
 */
export async function recordFileHistorySnapshot(
  cwd: string,
  sessionId: string,
  snapshot: FileHistorySnapshotRecord,
): Promise<void> {
  await appendTranscriptEntry(cwd, sessionId, {
    type: "file_history_snapshot",
    timestamp: new Date().toISOString(),
    snapshot,
  });
}

export async function appendTranscriptEntry(cwd: string, sessionId: string, entry: TranscriptEntry): Promise<void> {
  if (!persistenceEnabled) return;
  const paths = await getSessionPaths(cwd, sessionId);
  await ensureSessionDir(paths);
  await withFileLock(paths.transcriptPath, () => appendPrivateFile(paths.transcriptPath, `${JSON.stringify(entry)}\n`));
  await writePrivateFile(paths.latestPath, `${sessionId}\n`);
}

async function readTranscriptEntries(filePath: string): Promise<TranscriptEntry[]> {
  return withFileLock(filePath, async () => {
    const raw = await fs.readFile(filePath, "utf-8");
    const entries: TranscriptEntry[] = [];
    const lines = raw.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!.trim();
      if (!line) continue;
      const entry = parseJsonLine(line);
      if (!entry) {
        throw new PersistentDataError(filePath, `invalid transcript record at line ${index + 1}`);
      }
      entries.push(entry);
    }
    return entries;
  });
}

export async function getLatestSessionId(cwd: string): Promise<string | null> {
  const { latestPath } = await getSessionPaths(cwd, "placeholder");
  try {
    const value = (await fs.readFile(latestPath, "utf-8")).trim();
    return value || null;
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") return null;
    throw error;
  }
}

export async function restoreSession(cwd: string, sessionId?: string): Promise<RestoredSession> {
  const resolvedSessionId = sessionId ?? (await getLatestSessionId(cwd));
  if (!resolvedSessionId) {
    throw new Error("No saved session found for this project.");
  }

  const { transcriptPath } = await getSessionPaths(cwd, resolvedSessionId);
  const entries = await readTranscriptEntries(transcriptPath);
  if (entries.length === 0) {
    throw new Error(`Session ${resolvedSessionId} is empty or unreadable.`);
  }

  const meta = entries.find(
    (entry): entry is Extract<TranscriptEntry, { type: "session_meta" }> => entry.type === "session_meta",
  );
  if (!meta) {
    throw new Error(`Session ${resolvedSessionId} is missing session metadata.`);
  }

  // Find the last compaction marker; only use messages after it
  let startIndex = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.type === "compaction") {
      startIndex = i + 1;
      break;
    }
  }
  const messages = entries
    .slice(startIndex)
    .filter((entry): entry is Extract<TranscriptEntry, { type: "message" }> => entry.type === "message")
    .map((entry) => entry.message);

  const latestUsage = [...entries]
    .reverse()
    .find((entry): entry is Extract<TranscriptEntry, { type: "usage" }> => entry.type === "usage");

  // Rebuild the file-history snapshot chain: keep the LAST record per
  // messageId (trackEdit appends updated copies of the most-recent snapshot
  // after makeSnapshot creates it), preserving first-appearance order so the
  // snapshots array stays chronological.
  const fhMap = new Map<string, FileHistorySnapshotRecord>();
  for (const entry of entries) {
    if (entry.type === "file_history_snapshot") {
      fhMap.set(entry.snapshot.messageId, entry.snapshot);
    }
  }

  return {
    summary: {
      sessionId: meta.sessionId,
      cwd: meta.cwd,
      startedAt: meta.startedAt,
      updatedAt: getLastUpdatedAt(entries, meta.startedAt),
      model: meta.model,
      messageCount: messages.length,
      totalUsage: latestUsage?.total ?? createEmptyUsage(),
      firstPrompt: extractFirstPrompt(messages),
      ...(await readTitleAt(transcriptPath.replace(/\.jsonl$/, TITLE_SUFFIX))),
    },
    messages,
    fileHistorySnapshots: [...fhMap.values()],
  };
}

export async function appendCompactionSnapshot(
  cwd: string,
  sessionId: string,
  trigger: "auto" | "manual",
  messages: MessageParam[],
  options: { reason?: "clear" } = {},
): Promise<void> {
  if (!persistenceEnabled) return;
  const paths = await getSessionPaths(cwd, sessionId);
  await ensureSessionDir(paths);
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: "compaction",
      timestamp: new Date().toISOString(),
      trigger,
      ...(options.reason ? { reason: options.reason } : {}),
    }),
  );
  for (const msg of messages) {
    lines.push(
      JSON.stringify({
        type: "message",
        timestamp: new Date().toISOString(),
        role: msg.role,
        message: msg,
      }),
    );
  }
  await withFileLock(paths.transcriptPath, () => appendPrivateFile(paths.transcriptPath, lines.join("\n") + "\n"));
}

/**
 * Apply the `cleanupPeriodDays` retention policy at startup. Reads the merged
 * setting (default 30), sets the persistence flag, and prunes this project's
 * transcript directory:
 *
 *   - `0`             → persistence OFF. Delete ALL transcripts + the `latest`
 *                       pointer for this project; future writes no-op.
 *   - `N > 0`         → delete `*.jsonl` whose mtime is older than N days.
 *   - unset / invalid → default 30 days.
 *
 * Best-effort: a read/delete failure never blocks startup.
 */
export async function applySessionRetentionPolicy(cwd: string): Promise<{ periodDays: number; enabled: boolean }> {
  let periodDays = DEFAULT_CLEANUP_PERIOD_DAYS;
  try {
    const { readMergedNumberSetting } = await import("../utils/settings.js");
    const configured = await readMergedNumberSetting(cwd, "cleanupPeriodDays");
    if (typeof configured === "number" && Number.isFinite(configured) && configured >= 0) {
      periodDays = Math.floor(configured);
    }
  } catch {
    // keep default
  }

  const enabled = periodDays !== 0;
  configureSessionPersistence(enabled);

  try {
    const { projectDir, latestPath } = await getSessionPaths(cwd, "placeholder");
    let entries: Dirent[];
    try {
      entries = await fs.readdir(projectDir, { withFileTypes: true });
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === "ENOENT") return { periodDays, enabled };
      throw error;
    }

    const cutoffMs = Date.now() - periodDays * 24 * 60 * 60 * 1000;
    const removeSession = async (filePath: string): Promise<void> => {
      await fs.rm(filePath, { force: true }).catch(() => {});
      await fs.rm(filePath.replace(/\.jsonl$/, TITLE_SUFFIX), { force: true }).catch(() => {});
    };
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filePath = path.join(projectDir, entry.name);
      if (periodDays === 0) {
        await removeSession(filePath);
        continue;
      }
      try {
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs < cutoffMs) await removeSession(filePath);
      } catch {
        // skip files we can't stat
      }
    }

    // With persistence off, drop the dangling `latest` pointer too so a stray
    // --resume doesn't try to restore a transcript we just deleted.
    if (periodDays === 0) {
      await fs.rm(latestPath, { force: true }).catch(() => {});
    }
  } catch {
    // best-effort cleanup
  }

  return { periodDays, enabled };
}

export async function listProjectSessions(cwd: string, limit = MAX_SESSIONS): Promise<SessionSummary[]> {
  const projectDir = (await getSessionPaths(cwd, "placeholder")).projectDir;
  let entries: Dirent[];

  try {
    entries = await fs.readdir(projectDir, { withFileTypes: true });
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") return [];
    throw error;
  }

  const sessionFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(projectDir, entry.name));

  const sessions = await Promise.all(
    sessionFiles.map(async (filePath) => {
      const transcriptEntries = await readTranscriptEntries(filePath);
      const meta = transcriptEntries.find(
        (entry): entry is Extract<TranscriptEntry, { type: "session_meta" }> => entry.type === "session_meta",
      );
      if (!meta) return null;

      const messages = transcriptEntries.filter((entry) => entry.type === "message");
      const latestUsage = [...transcriptEntries]
        .reverse()
        .find((entry): entry is Extract<TranscriptEntry, { type: "usage" }> => entry.type === "usage");

      return {
        sessionId: meta.sessionId,
        cwd: meta.cwd,
        startedAt: meta.startedAt,
        updatedAt: getLastUpdatedAt(transcriptEntries, meta.startedAt),
        model: meta.model,
        messageCount: messages.length,
        totalUsage: latestUsage?.total ?? createEmptyUsage(),
        firstPrompt: extractFirstPrompt(messages.map((m) => m.message)),
        ...(await readTitleAt(path.join(projectDir, `${meta.sessionId}${TITLE_SUFFIX}`))),
      } satisfies SessionSummary;
    }),
  );

  return sessions
    .filter((session): session is SessionSummary => session !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

// ─── Titles and deletion ─────────────────────────────────────────────────
//
// A title lives next to the transcript in `<session-id>.title.json`, outside
// the JSONL, so earlier versions that reject unknown transcript records still
// read every session. They also ignore the extra file when listing.

const TITLE_SUFFIX = ".title.json";
const MAX_TITLE_LENGTH = 200;

async function readTitleAt(titlePath: string): Promise<{ title?: string }> {
  try {
    const parsed = JSON.parse(await fs.readFile(titlePath, "utf-8")) as { title?: unknown };
    return typeof parsed.title === "string" && parsed.title.trim() ? { title: parsed.title } : {};
  } catch {
    // Missing or unreadable: the session simply has no title.
    return {};
  }
}

async function getTitlePath(cwd: string, sessionId: string): Promise<string> {
  assertSessionId(sessionId);
  const { projectDir } = await getSessionPaths(cwd, sessionId);
  return path.join(projectDir, `${sessionId}${TITLE_SUFFIX}`);
}

export async function readSessionTitle(cwd: string, sessionId: string): Promise<string | undefined> {
  return (await readTitleAt(await getTitlePath(cwd, sessionId))).title;
}

/** Set or, with an empty title, clear the title of a saved session. */
export async function writeSessionTitle(cwd: string, sessionId: string, title: string): Promise<void> {
  const titlePath = await getTitlePath(cwd, sessionId);
  const { transcriptPath, projectDir } = await getSessionPaths(cwd, sessionId);
  await fs.access(transcriptPath);
  const trimmed = title.trim().slice(0, MAX_TITLE_LENGTH);
  if (!trimmed) {
    await fs.rm(titlePath, { force: true });
    return;
  }
  await ensurePrivateDirectory(projectDir);
  await writePrivateFile(titlePath, `${JSON.stringify({ title: trimmed })}\n`);
}

/**
 * Remove a saved session's transcript and title. When `latest` pointed at it,
 * the pointer moves to the most recently updated remaining session, or is
 * removed when none is left.
 */
export async function deleteSessionTranscript(cwd: string, sessionId: string): Promise<void> {
  const titlePath = await getTitlePath(cwd, sessionId);
  const { transcriptPath, latestPath } = await getSessionPaths(cwd, sessionId);
  await fs.access(transcriptPath);
  await withFileLock(transcriptPath, () => fs.rm(transcriptPath, { force: true }));
  await fs.rm(titlePath, { force: true });
  if ((await getLatestSessionId(cwd)) !== sessionId) return;
  const [next] = await listProjectSessions(cwd, 1);
  if (next) await writePrivateFile(latestPath, `${next.sessionId}\n`);
  else await fs.rm(latestPath, { force: true });
}
