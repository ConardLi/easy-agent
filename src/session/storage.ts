import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Dirent } from "node:fs";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { Usage } from "../types/message.js";

const EASY_AGENT_HOME = path.join(os.homedir(), ".easy-agent");
const PROJECTS_DIR = path.join(EASY_AGENT_HOME, "projects");
const MAX_SESSIONS = 20;

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
}

export type TranscriptEntry =
  | { type: "session_meta"; sessionId: string; cwd: string; startedAt: string; model: string }
  | { type: "message"; timestamp: string; role: "user" | "assistant"; message: MessageParam }
  | { type: "tool_event"; timestamp: string; name: string; phase: "start" | "done"; resultLength?: number; isError?: boolean }
  | { type: "usage"; timestamp: string; turn: Usage; total: Usage }
  | { type: "system"; timestamp: string; level: "info" | "error"; message: string };

export interface RestoredSession {
  summary: SessionSummary;
  messages: MessageParam[];
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

export function createSessionId(): string {
  return crypto.randomUUID();
}

export function getProjectHash(cwd: string): string {
  return crypto.createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 16);
}

export function getSessionPaths(cwd: string, sessionId: string): SessionPaths {
  const projectDir = path.join(PROJECTS_DIR, getProjectHash(cwd));
  return {
    rootDir: EASY_AGENT_HOME,
    projectDir,
    transcriptPath: path.join(projectDir, `${sessionId}.jsonl`),
    latestPath: path.join(projectDir, "latest"),
  };
}

async function ensureSessionDir(paths: SessionPaths): Promise<void> {
  await fs.mkdir(paths.projectDir, { recursive: true });
}

export async function initSessionStorage(metadata: SessionMetadata): Promise<SessionPaths> {
  const paths = getSessionPaths(metadata.cwd, metadata.sessionId);
  await ensureSessionDir(paths);

  const metaEntry: TranscriptEntry = {
    type: "session_meta",
    sessionId: metadata.sessionId,
    cwd: metadata.cwd,
    startedAt: metadata.startedAt,
    model: metadata.model,
  };

  await fs.writeFile(paths.transcriptPath, `${JSON.stringify(metaEntry)}\n`, { flag: "a" });
  await fs.writeFile(paths.latestPath, `${metadata.sessionId}\n`, "utf-8");
  return paths;
}

export async function appendTranscriptEntry(cwd: string, sessionId: string, entry: TranscriptEntry): Promise<void> {
  const paths = getSessionPaths(cwd, sessionId);
  await ensureSessionDir(paths);
  await fs.appendFile(paths.transcriptPath, `${JSON.stringify(entry)}\n`, "utf-8");
  await fs.writeFile(paths.latestPath, `${sessionId}\n`, "utf-8");
}

async function readTranscriptEntries(filePath: string): Promise<TranscriptEntry[]> {
  const raw = await fs.readFile(filePath, "utf-8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseJsonLine)
    .filter((entry): entry is TranscriptEntry => entry !== null);
}

export async function getLatestSessionId(cwd: string): Promise<string | null> {
  const { latestPath } = getSessionPaths(cwd, "placeholder");
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

  const { transcriptPath } = getSessionPaths(cwd, resolvedSessionId);
  const entries = await readTranscriptEntries(transcriptPath);
  if (entries.length === 0) {
    throw new Error(`Session ${resolvedSessionId} is empty or unreadable.`);
  }

  const meta = entries.find((entry): entry is Extract<TranscriptEntry, { type: "session_meta" }> => entry.type === "session_meta");
  if (!meta) {
    throw new Error(`Session ${resolvedSessionId} is missing session metadata.`);
  }

  const messages = entries
    .filter((entry): entry is Extract<TranscriptEntry, { type: "message" }> => entry.type === "message")
    .map((entry) => entry.message);

  const latestUsage = [...entries]
    .reverse()
    .find((entry): entry is Extract<TranscriptEntry, { type: "usage" }> => entry.type === "usage");

  return {
    summary: {
      sessionId: meta.sessionId,
      cwd: meta.cwd,
      startedAt: meta.startedAt,
      updatedAt: getLastUpdatedAt(entries, meta.startedAt),
      model: meta.model,
      messageCount: messages.length,
      totalUsage: latestUsage?.total ?? createEmptyUsage(),
    },
    messages,
  };
}

export async function listProjectSessions(cwd: string, limit = MAX_SESSIONS): Promise<SessionSummary[]> {
  const projectDir = getSessionPaths(cwd, "placeholder").projectDir;
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
      const meta = transcriptEntries.find((entry): entry is Extract<TranscriptEntry, { type: "session_meta" }> => entry.type === "session_meta");
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
      } satisfies SessionSummary;
    }),
  );

  return sessions
    .filter((session): session is SessionSummary => session !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}
