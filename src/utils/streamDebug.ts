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

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEBUG_STREAM = process.env.EASY_AGENT_DEBUG_STREAM === "1";

let cachedLogPath: string | null = null;

function resolveLogPath(): string {
  if (cachedLogPath) return cachedLogPath;
  const dir = join(homedir(), ".easy-agent");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore — appendFileSync will surface any real failure */
  }
  cachedLogPath = join(dir, "stream-debug.log");
  return cachedLogPath;
}

/**
 * Append a single JSON record to the debug log. Safe to call when
 * debug mode is off — it becomes a no-op.
 */
export function writeStreamDebug(kind: string, payload: unknown): void {
  if (!DEBUG_STREAM) return;
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), kind, payload }) + "\n";
    appendFileSync(resolveLogPath(), line);
  } catch {
    /* swallow — logging must never break the stream */
  }
}

export function isStreamDebugEnabled(): boolean {
  return DEBUG_STREAM;
}
