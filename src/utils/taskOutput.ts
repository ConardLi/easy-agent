/**
 * Task-output file helpers for background sub-agents (stage 20).
 *
 * The model gets back `outputFile: <absolute path>` from a launched
 * background `Agent(...)` call. While the sub-agent runs in the
 * background, every interesting event (text chunk emitted by the model,
 * tool_use_start, tool_use_done with truncated result, completion / error)
 * is appended as a JSON-Lines record to that file. The main agent can
 * `Read` or `Bash tail` it to peek at progress at any time, and the
 * `<task-notification>` injected on completion also references the same
 * path.
 *
 * Path convention (mirrors source's `{projectTmp}/{session}/tasks/{id}.output`,
 * adapted to our `~/.easy-agent/projects/...` layout):
 *
 *   ~/.easy-agent/projects/<sessionId-encoded>/tasks/<agentId>.output
 *
 * Why JSONL and not a plain narrative log:
 *   - One event per line — `tail` and `Read offset` work cleanly.
 *   - Structured (timestamp + type + payload) — when we later add a
 *     dedicated UI viewer it can parse the file without regex hacks.
 *   - Resilient to partial writes: if the process crashes mid-line, the
 *     partial line is the *last* line and consumers can drop it.
 *
 * Design notes:
 *   - Writes are best-effort. We never let an output-file IO error bubble
 *     up to crash the sub-agent loop — the worst case is the user sees an
 *     empty .output file but the result still comes back via the
 *     notification (which is how the source behaves too).
 *   - We append in a single `fs.appendFile` per event (no buffering).
 *     Perf is fine — sub-agents emit O(turns) events, not O(stream tokens).
 *   - Path is derived purely from sessionId + agentId; both are pure
 *     strings, no Date.now() races, so two callers with the same inputs
 *     end up writing to the same file (intentional — that's how the
 *     parent's Read can find it).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getProjectsRoot } from "./paths.js";

/** Make a sessionId safe to use as a single directory segment. */
function encodeSessionDir(sessionId: string): string {
  // Replace any character that isn't [A-Za-z0-9._-] with `-` so a
  // session id like "agent-Explore-abcd/sub-1" doesn't accidentally
  // create nested dirs. Mirrors the same encoder shape as session
  // storage.
  return sessionId.replaceAll(/[^A-Za-z0-9._-]/g, "-");
}

/**
 * Returns the absolute output file path for one async sub-agent.
 *
 * Pure function — does not create the directory or the file. Callers
 * that intend to write to the file should call `ensureTaskOutputFile`.
 */
export function getTaskOutputPath(sessionId: string, agentId: string): string {
  return path.join(
    getProjectsRoot(),
    encodeSessionDir(sessionId),
    "tasks",
    `${agentId}.output`,
  );
}

/**
 * Make sure the `tasks/` directory and the empty .output file both
 * exist. Idempotent — safe to call repeatedly.
 *
 * We pre-create an empty file so the parent's Read tool doesn't error
 * with ENOENT during the brief window between `async_launched` returning
 * and the first event being written.
 */
export async function ensureTaskOutputFile(
  sessionId: string,
  agentId: string,
): Promise<string> {
  const filePath = getTaskOutputPath(sessionId, agentId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // O_CREAT | O_WRONLY behaviour without truncation — a leftover from
  // a previous run with the same agentId stays put.
  const handle = await fs.open(filePath, "a");
  await handle.close();
  return filePath;
}

/** Discriminated union of events written to the .output JSONL stream. */
export type TaskOutputEvent =
  | { type: "started"; agentType: string; description?: string; prompt: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; toolName: string; toolUseId?: string }
  | { type: "tool_result"; toolName: string; isError: boolean; preview: string }
  | { type: "turn_usage"; inputTokens: number; outputTokens: number; totalTokens: number; turn: number }
  | {
      type: "completed";
      reason: string;
      finalText: string;
      durationMs: number;
      totalTokens: number;
      toolUseCount: number;
    }
  | { type: "failed"; error: string; durationMs: number };

/**
 * Append one event to the .output JSONL file. Best-effort — IO errors
 * are silently swallowed so the surrounding sub-agent loop never crashes
 * because of a transient disk issue.
 *
 * `timestamp` is added automatically (ISO string) so callers don't have
 * to remember.
 */
export async function appendTaskOutput(
  filePath: string,
  event: TaskOutputEvent,
): Promise<void> {
  const record = {
    timestamp: new Date().toISOString(),
    ...event,
  };
  try {
    await fs.appendFile(filePath, JSON.stringify(record) + "\n");
  } catch {
    // Intentional — see file header.
  }
}

/** Truncate long tool results before storing them in the .output file. */
export function previewToolResult(content: string, max = 2000): string {
  if (content.length <= max) return content;
  return `${content.slice(0, max)}\n... [truncated ${content.length - max} chars]`;
}
