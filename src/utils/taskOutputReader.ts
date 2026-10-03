/**
 * Read + parse the JSONL `.output` file that background sub-agents
 * append to during their run. Used by the teammate transcript viewer:
 * when the user enters viewing mode the UI calls
 * `readTaskOutputEvents` to render what's there, then sets up a polling
 * loop via `useTaskOutputLive` for incremental updates.
 *
 * Why polling and not fs.watch:
 *   - fs.watch is unreliable on macOS for tail-style growth (often
 *     fires once for the inode change but not for subsequent appends).
 *   - The .output file grows at ~1 event per tool call, i.e. seconds
 *     apart. A 1s polling interval is more than fast enough and uses
 *     a single stat() per tick.
 *   - The viewer is only mounted while the user is actively looking
 *     at one teammate — total cost is negligible.
 *
 * Robustness:
 *   - Files may not exist yet when the viewer mounts (the agent might
 *     have just been launched and not written its first event). We
 *     return [] for ENOENT and let the caller render an "initializing"
 *     placeholder; the polling loop will catch the first event.
 *   - Partial last lines (process crashed mid-write) are dropped
 *     instead of throwing — JSONL is designed for this.
 *   - Each event already carries a `timestamp` field (added by
 *     `appendTaskOutput`), so no need for line numbers as a poor-man
 *     ordering key.
 */

import * as fs from "node:fs/promises";
import type { TaskOutputEvent } from "./taskOutput.js";

/**
 * Parsed line — the raw event plus the timestamp prepended by
 * `appendTaskOutput`. Splitting them out at the type level (instead of
 * intersecting) keeps consumers from forgetting to render `timestamp`.
 */
export interface TaskOutputRecord {
  timestamp: string;
  event: TaskOutputEvent;
}

/** Read every JSONL record from disk. Returns [] when the file is missing. */
export async function readTaskOutputEvents(
  filePath: string,
): Promise<TaskOutputRecord[]> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const lines = text.split("\n");
  const out: TaskOutputRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      // We expect at least { timestamp, type }; everything else lives
      // inside the event. Strip timestamp out and pack the rest into
      // `event` so the record type matches the discriminated union.
      const { timestamp, ...rest } = parsed;
      if (typeof timestamp !== "string") continue;
      out.push({ timestamp, event: rest as unknown as TaskOutputEvent });
    } catch {
      // Most common cause: the agent was mid-append when we read. The
      // partial line is necessarily the LAST one — drop it and move
      // on. Mid-file corruption is unlikely because every append is a
      // single fs.appendFile (atomic on macOS/linux for sub-page writes).
      if (i === lines.length - 1) break;
    }
  }
  return out;
}

/**
 * Format one TaskOutputEvent into a single human-readable line.
 * Centralized here (vs. inline in the React component) so tests can
 * snapshot the rendering without spinning up Ink.
 *
 * The rendering style intentionally mirrors the main session's
 * conversation cards:
 *   text         →            "<text…>"  (truncated to 160 chars)
 *   tool_use     → "⚡ Read"
 *   tool_result  → "  └ ok (1.2k chars)" / "  └ error: <preview>"
 *   turn_usage   → dimmed "  · turn 3: 12.3k tokens"
 *   completed    → "✓ Done · <reason> · <durationMs>ms"
 *   failed       → "✗ Failed: <error>"
 *   started      → "⏵ Started <agentType>" (used as the first line)
 */
export function formatRecordLine(record: TaskOutputRecord): string {
  const e = record.event;
  switch (e.type) {
    case "started":
      return `⏵ Started ${e.agentType}${e.description ? ` — ${e.description}` : ""}`;
    case "text": {
      const oneLine = e.text.replace(/\s+/g, " ").trim();
      return oneLine.length > 160 ? `${oneLine.slice(0, 157)}…` : oneLine;
    }
    case "tool_use":
      return `⚡ ${e.toolName}`;
    case "tool_result": {
      const preview = e.preview.replace(/\s+/g, " ").trim();
      const trimmed = preview.length > 100 ? `${preview.slice(0, 97)}…` : preview;
      return e.isError ? `  └ error: ${trimmed}` : `  └ ok (${e.preview.length} chars)${trimmed ? `: ${trimmed}` : ""}`;
    }
    case "turn_usage":
      return `  · turn ${e.turn}: ${e.totalTokens} tokens (in ${e.inputTokens}, out ${e.outputTokens})`;
    case "completed":
      return `✓ Done · ${e.reason} · ${e.durationMs}ms · ${e.toolUseCount} tool uses · ${e.totalTokens} tokens`;
    case "failed":
      return `✗ Failed: ${e.error} (${e.durationMs}ms)`;
  }
}
