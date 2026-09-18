/**
 * Stream debug logger.
 *
 * Opt-in via the `EASY_AGENT_DEBUG_STREAM=1` environment variable.
 * When enabled, every raw SSE event — plus request / assembled / error
 * markers — is appended as a single-line JSON record to
 * `~/.easy-agent/stream-debug.log`.
 *
 * This is invaluable when debugging Anthropic-compatible endpoints
 * (MiniMax, LiteLLM, OpenAI → Anthropic shims, etc.) whose streaming
 * translation often mis-handles tool_use or thinking blocks.
 *
 * Keep this file dependency-free and side-effect-safe: logging must
 * never throw or affect the stream itself.
 */

import { chmodSync, existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { redactSettingValue } from "../config/redaction.js";
import {
  appendPrivateFileSync,
  ensurePrivateDirectorySync,
  PRIVATE_FILE_MODE,
} from "./privateData.js";
import { getEasyAgentHome, getStreamDebugLogPath } from "./paths.js";

const DEBUG_STREAM = process.env.EASY_AGENT_DEBUG_STREAM === "1";
const MAX_LOG_BYTES = 10 * 1024 * 1024;
const RETAINED_LOGS = 3;

let cachedLogPath: string | null = null;

function resolveLogPath(): string {
  if (cachedLogPath) return cachedLogPath;
  try {
    ensurePrivateDirectorySync(getEasyAgentHome());
  } catch {
    /* ignore — the append path will surface any real failure */
  }
  cachedLogPath = getStreamDebugLogPath();
  return cachedLogPath;
}

export function rotateStreamDebugLog(
  filePath: string,
  maxBytes = MAX_LOG_BYTES,
  retainedLogs = RETAINED_LOGS,
  incomingBytes = 0,
): void {
  let size = 0;
  try {
    size = statSync(filePath).size;
  } catch {
    return;
  }
  if (size + incomingBytes <= maxBytes) return;

  try {
    const oldest = `${filePath}.${retainedLogs}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let index = retainedLogs - 1; index >= 1; index -= 1) {
      const source = `${filePath}.${index}`;
      if (!existsSync(source)) continue;
      const destination = `${filePath}.${index + 1}`;
      renameSync(source, destination);
      if (process.platform !== "win32") chmodSync(destination, PRIVATE_FILE_MODE);
    }
    renameSync(filePath, `${filePath}.1`);
    if (process.platform !== "win32") chmodSync(`${filePath}.1`, PRIVATE_FILE_MODE);
  } catch {
    // Rotation is best-effort; logging itself remains non-fatal.
  }
}

/**
 * Append a single JSON record to the debug log. Safe to call when
 * debug mode is off — it becomes a no-op.
 */
export function writeStreamDebug(kind: string, payload: unknown): void {
  if (!DEBUG_STREAM) return;
  try {
    const safePayload = redactSettingValue("", payload);
    const line = JSON.stringify({ ts: new Date().toISOString(), kind, payload: safePayload }) + "\n";
    const logPath = resolveLogPath();
    rotateStreamDebugLog(logPath, MAX_LOG_BYTES, RETAINED_LOGS, Buffer.byteLength(line));
    appendPrivateFileSync(logPath, line);
  } catch {
    /* swallow — logging must never break the stream */
  }
}

export function isStreamDebugEnabled(): boolean {
  return DEBUG_STREAM;
}
