/**
 * Rewind command group — `/rewind` (alias `/checkpoint`).
 *
 * Extracted verbatim from queryEngine.ts; behavior is unchanged. Restores
 * tracked files to the state at the start of the n-th-from-last user turn
 * (default 1 = undo the most recent turn's edits). Only files are rewound; the
 * conversation log is left intact.
 */

import { relative as relativePath } from "node:path";
import {
  fileHistoryEnabled,
  fileHistoryGetDiffStats,
  fileHistoryRewind,
  getSnapshotByOffset,
  snapshotCount,
} from "../../../session/fileHistory.js";
import type { QueryEngineEvent } from "../types.js";
import type { CommandContext } from "./context.js";

/**
 * `/rewind [n]` (alias `/checkpoint`). Restores tracked files to
 * the state at the start of the n-th-from-last user turn (default 1 = undo
 * the most recent turn's edits). Shows the affected file list + diff stats,
 * then applies the rewind. Only files are rewound; the conversation is left
 * intact.
 */
export async function* handleRewindCommand(
  ctx: CommandContext,
  args: string[],
): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
  if (!fileHistoryEnabled()) {
    yield {
      type: "command",
      kind: "info",
      message: "File history is disabled (checkpointingEnabled: false). Nothing to rewind.",
    };
    return { handled: true };
  }

  const total = snapshotCount();
  if (total === 0) {
    yield {
      type: "command",
      kind: "info",
      message: "No file-history snapshots yet — make an edit first.",
    };
    return { handled: true };
  }

  // Parse the step count (how many turns to go back). Default 1.
  let steps = 1;
  const rawArg = args[0]?.trim();
  if (rawArg) {
    const parsed = Number(rawArg);
    if (!Number.isInteger(parsed) || parsed < 1) {
      yield {
        type: "command",
        kind: "error",
        message: `Invalid step count: ${rawArg}. Usage: /rewind [n] where n ≥ 1.`,
      };
      return { handled: true };
    }
    steps = parsed;
  }

  const target = getSnapshotByOffset(steps);
  if (!target) {
    yield {
      type: "command",
      kind: "error",
      message: `Cannot rewind ${steps} step(s): only ${total} snapshot(s) available.`,
    };
    return { handled: true };
  }

  const cwd = ctx.cwd;
  const rel = (p: string): string => {
    const r = relativePath(cwd, p);
    return r && !r.startsWith("..") ? r : p;
  };

  // Preview the changes the rewind would make.
  const stats = await fileHistoryGetDiffStats(target.messageId);

  let changed: string[];
  try {
    changed = await fileHistoryRewind(target.messageId);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    yield { type: "command", kind: "error", message: `Rewind failed: ${msg}` };
    return { handled: true };
  }

  if (changed.length === 0) {
    yield {
      type: "command",
      kind: "info",
      message: `Already at that state — no files changed (rewound ${steps} turn(s)).`,
    };
    return { handled: true };
  }

  const lines = [
    `Rewound ${steps} turn(s). Restored ${changed.length} file(s) (+${stats.insertions} -${stats.deletions}):`,
    ...changed.map((p) => `  ${rel(p)}`),
  ];
  yield { type: "command", kind: "info", message: lines.join("\n") };
  return { handled: true };
}
