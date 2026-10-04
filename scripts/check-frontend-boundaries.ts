/**
 * Frontends talk to the session SDK, not to the session internals.
 *
 * The terminal UI (`src/ui/`) and the entry points (`src/entrypoint/`) must
 * not load the modules that hold conversation state or run turns; those are
 * reached through `src/sdk/`. Type-only imports are allowed: they carry no
 * runtime coupling.
 *
 * Run: node --import tsx scripts/check-frontend-boundaries.ts
 */

import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

interface Boundary {
  /** Module path under src/, without extension. A trailing `/` matches a directory. */
  module: string;
  reason: string;
}

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(PROJECT_ROOT, "src");
const FRONTEND_DIRS = ["ui", "entrypoint"];

const FORBIDDEN: Boundary[] = [
  { module: "core/queryEngine", reason: "turns run through AgentSession" },
  { module: "core/agenticLoop", reason: "turns run through AgentSession" },
  { module: "session/storage", reason: "the session records its transcript; read history through AgentRuntime" },
  { module: "session/fileHistory", reason: "checkpoints belong to the session" },
  { module: "state/", reason: "session state arrives as SDK events and snapshots" },
  { module: "context/plans", reason: "plan content arrives with the plan_approval request" },
  { module: "utils/thinking", reason: "thinking settings are part of SessionState" },
  { module: "utils/teammateMailbox", reason: "background wake-ups are handled by the session" },
  { module: "permissions/permissions", reason: "confirmations are interaction requests" },
  { module: "tools/bashTool", reason: "use AgentSession.runShell" },
];

/** Frontend-only stores that hold presentation state, not conversation state. */
const ALLOWED: Boundary[] = [
  { module: "state/uiNoticeStore", reason: "startup notices rendered by the terminal" },
  { module: "state/teammateViewStore", reason: "which teammate transcript the terminal shows" },
];

const IMPORT = /\bimport\s+(type\s+)?([^;"']*?)\s+from\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

function isTypeOnly(prefix: string | undefined, clause: string): boolean {
  if (prefix) return true;
  const named = clause.match(/^\{([\s\S]*)\}$/);
  if (!named) return false;
  const specifiers = named[1]!
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return specifiers.length > 0 && specifiers.every((specifier) => specifier.startsWith("type "));
}

function matches(boundary: Boundary, module: string): boolean {
  return boundary.module.endsWith("/") ? module.startsWith(boundary.module) : module === boundary.module;
}

async function collect(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(absolute)));
    else if (/\.tsx?$/.test(entry.name)) files.push(absolute);
  }
  return files;
}

const violations: string[] = [];
let scanned = 0;
for (const dir of FRONTEND_DIRS) {
  for (const file of await collect(path.join(SRC, dir))) {
    scanned += 1;
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(IMPORT)) {
      const specifier = match[3] ?? match[4]!;
      if (!specifier.startsWith(".")) continue;
      if (match[3] && isTypeOnly(match[1], match[2]!.trim())) continue;
      const module = path
        .relative(SRC, path.resolve(path.dirname(file), specifier))
        .split(path.sep)
        .join("/")
        .replace(/\.(?:js|ts|tsx)$/, "");
      if (ALLOWED.some((boundary) => matches(boundary, module))) continue;
      const boundary = FORBIDDEN.find((candidate) => matches(candidate, module));
      if (boundary) {
        const line = text.slice(0, match.index).split("\n").length;
        violations.push(`${path.relative(PROJECT_ROOT, file)}:${line} imports ${module} (${boundary.reason})`);
      }
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(`Frontend boundary violations:\n${violations.map((v) => `  ${v}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`Frontend boundaries: scanned ${scanned} file(s), 0 violation(s).\n`);
