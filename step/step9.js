/**
 * Step 9 - Session persistence with JSONL transcripts
 *
 * Goal:
 * - persist a conversation as append-only JSONL
 * - group sessions by project
 * - restore messages from disk after process restart
 * - list recent sessions for the current project
 *
 * This file keeps the core ideas in one place for learning.
 * The production code in src/session/* is more complete.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const EASY_AGENT_HOME = path.join(os.homedir(), ".easy-agent");
const PROJECTS_DIR = path.join(EASY_AGENT_HOME, "projects");
const MAX_SESSIONS = 20;

function createEmptyUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
  };
}

// A session id uniquely identifies one conversation.
export function createSessionId() {
  return crypto.randomUUID();
}

// Hash the project path so every workspace gets its own folder.
export function getProjectHash(cwd) {
  return crypto
    .createHash("sha256")
    .update(path.resolve(cwd))
    .digest("hex")
    .slice(0, 16);
}

export function getSessionPaths(cwd, sessionId) {
  const projectHash = getProjectHash(cwd);
  const projectDir = path.join(PROJECTS_DIR, projectHash);

  return {
    rootDir: EASY_AGENT_HOME,
    projectDir,
    transcriptPath: path.join(projectDir, sessionId + ".jsonl"),
    latestPath: path.join(projectDir, "latest"),
  };
}

async function ensureSessionDir(paths) {
  await fs.mkdir(paths.projectDir, { recursive: true });
}

// Transcript protocol: one JSON object per line.
export function createSessionMetaEntry({ sessionId, cwd, startedAt, model }) {
  return {
    type: "session_meta",
    sessionId,
    cwd,
    startedAt,
    model,
  };
}

export function createMessageEntry({ role, message, timestamp = new Date().toISOString() }) {
  return {
    type: "message",
    timestamp,
    role,
    message,
  };
}

export function createToolEventEntry({ name, phase, resultLength, isError, timestamp = new Date().toISOString() }) {
  return {
    type: "tool_event",
    timestamp,
    name,
    phase,
    ...(typeof resultLength === "number" ? { resultLength } : {}),
    ...(typeof isError === "boolean" ? { isError } : {}),
  };
}

export function createUsageEntry({ turn, total, timestamp = new Date().toISOString() }) {
  return {
    type: "usage",
    timestamp,
    turn,
    total,
  };
}

export function createSystemEntry({ level, message, timestamp = new Date().toISOString() }) {
  return {
    type: "system",
    timestamp,
    level,
    message,
  };
}

export async function initSessionStorage(metadata) {
  const paths = getSessionPaths(metadata.cwd, metadata.sessionId);
  await ensureSessionDir(paths);

  const sessionMeta = createSessionMetaEntry(metadata);
  await fs.writeFile(paths.transcriptPath, JSON.stringify(sessionMeta) + "\n", { flag: "a" });
  await fs.writeFile(paths.latestPath, metadata.sessionId + "\n", "utf8");

  return paths;
}

export async function appendTranscriptEntry(cwd, sessionId, entry) {
  const paths = getSessionPaths(cwd, sessionId);
  await ensureSessionDir(paths);
  await fs.appendFile(paths.transcriptPath, JSON.stringify(entry) + "\n", "utf8");
  await fs.writeFile(paths.latestPath, sessionId + "\n", "utf8");
}

function isUsage(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.input_tokens === "number" &&
      typeof value.output_tokens === "number",
  );
}

function isMessageParam(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value.role === "user" || value.role === "assistant") &&
      "content" in value,
  );
}

// Parse carefully so a bad line does not crash the whole restore flow.
export function parseJsonLine(line) {
  try {
    const parsed = JSON.parse(line);

    if (parsed.type === "session_meta") {
      return {
        type: "session_meta",
        sessionId: parsed.sessionId,
        cwd: parsed.cwd,
        startedAt: parsed.startedAt,
        model: parsed.model,
      };
    }

    if (
      parsed.type === "message" &&
      typeof parsed.timestamp === "string" &&
      (parsed.role === "user" || parsed.role === "assistant") &&
      isMessageParam(parsed.message)
    ) {
      return parsed;
    }

    if (
      parsed.type === "tool_event" &&
      typeof parsed.timestamp === "string" &&
      typeof parsed.name === "string" &&
      (parsed.phase === "start" || parsed.phase === "done")
    ) {
      return parsed;
    }

    if (
      parsed.type === "usage" &&
      typeof parsed.timestamp === "string" &&
      isUsage(parsed.turn) &&
      isUsage(parsed.total)
    ) {
      return parsed;
    }

    if (
      parsed.type === "system" &&
      typeof parsed.timestamp === "string" &&
      (parsed.level === "info" || parsed.level === "error") &&
      typeof parsed.message === "string"
    ) {
      return parsed;
    }

    return null;
  } catch {
    return null;
  }
}

export async function readTranscriptEntries(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseJsonLine)
    .filter(Boolean);
}

export async function getLatestSessionId(cwd) {
  const { latestPath } = getSessionPaths(cwd, "placeholder");
  try {
    const value = (await fs.readFile(latestPath, "utf8")).trim();
    return value || null;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function getLastUpdatedAt(entries, fallback) {
  const reversed = [...entries].reverse();
  const latestTimedEntry = reversed.find((entry) => typeof entry.timestamp === "string");
  return latestTimedEntry?.timestamp || fallback;
}

export async function restoreSession(cwd, sessionId) {
  const resolvedSessionId = sessionId || (await getLatestSessionId(cwd));
  if (!resolvedSessionId) {
    throw new Error("No saved session found for this project.");
  }

  const { transcriptPath } = getSessionPaths(cwd, resolvedSessionId);
  const entries = await readTranscriptEntries(transcriptPath);
  if (entries.length === 0) {
    throw new Error("Session is empty or unreadable.");
  }

  const meta = entries.find((entry) => entry.type === "session_meta");
  if (!meta) {
    throw new Error("Session is missing session metadata.");
  }

  const messages = entries
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);

  const latestUsage = [...entries]
    .reverse()
    .find((entry) => entry.type === "usage");

  return {
    summary: {
      sessionId: meta.sessionId,
      cwd: meta.cwd,
      startedAt: meta.startedAt,
      updatedAt: getLastUpdatedAt(entries, meta.startedAt),
      model: meta.model,
      messageCount: messages.length,
      totalUsage: latestUsage?.total || createEmptyUsage(),
    },
    messages,
  };
}

export async function listProjectSessions(cwd, limit = MAX_SESSIONS) {
  const { projectDir } = getSessionPaths(cwd, "placeholder");

  let dirEntries;
  try {
    dirEntries = await fs.readdir(projectDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const sessionFiles = dirEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(projectDir, entry.name));

  const sessions = await Promise.all(
    sessionFiles.map(async (filePath) => {
      const entries = await readTranscriptEntries(filePath);
      const meta = entries.find((entry) => entry.type === "session_meta");
      if (!meta) return null;

      const messages = entries.filter((entry) => entry.type === "message");
      const latestUsage = [...entries]
        .reverse()
        .find((entry) => entry.type === "usage");

      return {
        sessionId: meta.sessionId,
        cwd: meta.cwd,
        startedAt: meta.startedAt,
        updatedAt: getLastUpdatedAt(entries, meta.startedAt),
        model: meta.model,
        messageCount: messages.length,
        totalUsage: latestUsage?.total || createEmptyUsage(),
      };
    }),
  );

  return sessions
    .filter(Boolean)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

export async function formatProjectSessionHistory(cwd) {
  const sessions = await listProjectSessions(cwd);
  if (sessions.length === 0) {
    return "No saved sessions found for this project.";
  }

  const lines = ["Recent sessions:"];
  for (const session of sessions) {
    const total = session.totalUsage.input_tokens + session.totalUsage.output_tokens;
    lines.push(
      [
        "- " + session.sessionId,
        "  Updated: " + session.updatedAt,
        "  Started: " + session.startedAt,
        "  Messages: " + session.messageCount,
        "  Usage: " + session.totalUsage.input_tokens + " in / " + session.totalUsage.output_tokens + " out / " + total + " total",
        "  Model: " + session.model,
      ].join("\n"),
    );
  }

  return lines.join("\n");
}
