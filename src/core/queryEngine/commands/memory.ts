/**
 * Memory command group — `/memory`.
 *
 * Extracted verbatim from queryEngine.ts; behavior is unchanged. Lists the
 * editable memory files (the AGENT.md chain + the project memdir) and opens one
 * in `$EDITOR`. The actual editor launch happens in the UI layer (it owns the
 * TTY), driven by the `open_editor` event this handler yields.
 */

import { writeFile, stat as fsStat, mkdir } from "node:fs/promises";
import {
  join as joinPath,
  basename as basenamePath,
  dirname as dirnamePath,
  relative as relativePath,
  resolve as resolvePath,
} from "node:path";
import { AGENT_MD_NAME, getAgentMdFiles } from "../../../context/claudeMd.js";
import { loadMemoryHeaders, getProjectMemoryDir, MEMORY_ENTRYPOINT } from "../../../context/memory/memdir.js";
import { getGlobalAgentMdPath } from "../../../utils/paths.js";
import { createPrivateFileIfMissing } from "../../../utils/privateData.js";
import type { QueryEngineEvent } from "../types.js";
import type { CommandContext } from "./context.js";

interface MemoryTarget {
  label: string;
  path: string;
  exists: boolean;
  size: number;
}

/**
 * Build the ordered, numbered list of editable memory targets:
 *   - global AGENT.md (always, even if missing — so it can be created)
 *   - any AGENTS.md / AGENT.md in the root→cwd chain that exists, plus the
 *     cwd AGENT.md when the cwd has neither file
 *   - the project memory index (MEMORY.md) + each topic memory file
 * The index is the selector used by `/memory edit <n>`, so it must be stable.
 */
export async function collectMemoryTargets(cwd: string): Promise<MemoryTarget[]> {
  const stat = async (fp: string): Promise<{ exists: boolean; size: number }> => {
    try {
      const st = await fsStat(fp);
      return { exists: st.isFile(), size: st.size };
    } catch {
      return { exists: false, size: 0 };
    }
  };

  const targets: MemoryTarget[] = [];

  const globalPath = getGlobalAgentMdPath();
  const projectDir = resolvePath(cwd);
  const agentFiles = await Promise.all(
    (await getAgentMdFiles(cwd)).map(async (fp, i) => ({
      fp,
      ...(await stat(fp)),
      isGlobal: fp === globalPath || i === 0,
    })),
  );
  const projectHasMemoryFile = agentFiles.some((f) => f.exists && !f.isGlobal && dirnamePath(f.fp) === projectDir);
  for (const { fp, exists, size, isGlobal } of agentFiles) {
    const name = basenamePath(fp);
    const isCwd = !isGlobal && dirnamePath(fp) === projectDir;
    // Skip missing files, except the global AGENT.md and — when the project
    // has no memory file yet — the project AGENT.md, so either can be created.
    const creatable = isGlobal || (isCwd && name === AGENT_MD_NAME && !projectHasMemoryFile);
    if (!exists && !creatable) continue;
    targets.push({
      label: isGlobal ? "global AGENT.md" : isCwd ? `project ${name}` : name,
      path: fp,
      exists,
      size,
    });
  }

  // Project memory dir (memdir). Don't create it just to list — only read if
  // it already exists.
  try {
    const memDir = await getProjectMemoryDir(cwd);
    const dirStat = await fsStat(memDir).catch(() => null);
    if (dirStat?.isDirectory()) {
      const entrypoint = joinPath(memDir, MEMORY_ENTRYPOINT);
      const ep = await stat(entrypoint);
      if (ep.exists) {
        targets.push({ label: "memory index (MEMORY.md)", path: entrypoint, ...ep });
      }
      const headers = await loadMemoryHeaders(cwd).catch(() => []);
      for (const h of headers) {
        const s = await stat(h.filePath);
        targets.push({ label: `memory: ${h.title}`, path: h.filePath, ...s });
      }
    }
  } catch {
    // memory dir resolution failed (e.g. no git root) — AGENT.md targets only
  }

  return targets;
}

/**
 * `/memory`. Lists the editable memory files (AGENT.md chain +
 * project memdir) and opens one in `$EDITOR`.
 *   - (no args) | list  → numbered list with paths + size/existence
 *   - edit <n> | <n>    → open target #n in $EDITOR (creating it if missing)
 * The actual editor launch happens in the UI layer (it owns the TTY), driven
 * by the `open_editor` event.
 */
export async function* handleMemoryCommand(
  ctx: CommandContext,
  args: string[],
): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
  const cwd = ctx.cwd;
  const first = (args[0] ?? "").toLowerCase();

  const formatSize = (n: number): string => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

  // Resolve a selection index from either `/memory edit <n>` or `/memory <n>`.
  let editArg: string | undefined;
  if (first === "edit" || first === "open") editArg = args[1]?.trim();
  else if (first && /^\d+$/.test(first)) editArg = first;

  if (editArg !== undefined) {
    const targets = await collectMemoryTargets(cwd);
    const idx = Number(editArg);
    if (!Number.isInteger(idx) || idx < 1 || idx > targets.length) {
      yield {
        type: "command",
        kind: "error",
        message: `Invalid selection: ${editArg}. Use /memory to list (1–${targets.length}).`,
      };
      return { handled: true };
    }
    const target = targets[idx - 1]!;
    // Create the file (and parents) if it doesn't exist yet, so $EDITOR opens
    // on a real path.
    if (!target.exists) {
      try {
        if (target.path === getGlobalAgentMdPath()) {
          await createPrivateFileIfMissing(target.path);
        } else {
          await mkdir(dirnamePath(target.path), { recursive: true });
          await writeFile(target.path, "", { encoding: "utf-8", flag: "wx" }).catch((e: unknown) => {
            if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
          });
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        yield { type: "command", kind: "error", message: `Cannot create ${target.path}: ${msg}` };
        return { handled: true };
      }
    }
    yield { type: "open_editor", filePath: target.path, label: target.label };
    return { handled: true };
  }

  const targets = await collectMemoryTargets(cwd);

  // `/memory list` → static text panel (used in headless / when the user
  // explicitly wants a non-interactive dump).
  if (first === "list") {
    const lines = ["Memory files", ""];
    if (targets.length === 0) {
      lines.push("(no memory files found)");
    } else {
      targets.forEach((t, i) => {
        const rel = relativePath(cwd, t.path);
        const shown = rel && !rel.startsWith("..") ? rel : t.path;
        const meta = t.exists ? formatSize(t.size) : "missing";
        lines.push(`  ${i + 1}. ${t.label}`);
        lines.push(`     ${shown}  (${meta})`);
      });
    }
    lines.push("", "Usage: /memory edit <n>   open a file in $EDITOR (set $EDITOR or $VISUAL)");
    yield { type: "command", kind: "info", message: lines.join("\n") };
    return { handled: true };
  }

  // `/memory` (no args) → interactive picker overlay. The UI owns the keyboard; selecting a row re-invokes
  // `/memory edit <n>` so the $EDITOR launch path is shared.
  yield { type: "memory_picker", items: targets };
  return { handled: true };
}
