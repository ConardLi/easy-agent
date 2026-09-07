/**
 * QueryEngine characterization (golden-master) test.
 *
 * Purpose: a behavior-locking safety net for the queryEngine.ts refactor.
 * It drives every LOCAL (non-LLM) slash command through the real
 * `QueryEngine.submitMessage` entry path — the exact path the UI uses — and
 * records the full normalized event stream. The recording is compared against
 * a committed golden file; any divergence fails the run.
 *
 * The golden captures the CURRENT (pre-refactor) behavior. As long as the
 * refactor preserves behavior, the recording stays byte-identical and this
 * test passes. Commands that hit the model (/compact, plain prompts) are
 * deliberately excluded — they're non-deterministic and out of scope here.
 *
 * Run:    npx tsx src/scripts/test-queryengine-characterization.ts
 * Update: npx tsx src/scripts/test-queryengine-characterization.ts --update
 *         (regenerate the golden — only after an intentional behavior change)
 */

import * as os from "node:os";
import * as path from "node:path";
import { readFile, writeFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import assert from "node:assert";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import {
  QueryEngine,
  type QueryEngineEvent,
  type QueryEngineOptions,
} from "../core/queryEngine.js";
import {
  initSessionStorage,
  appendTranscriptEntry,
  getSessionPaths,
} from "../session/storage.js";
import { getTaskMode, setTaskMode } from "../state/taskModeStore.js";
import {
  resetGlobalStateCache,
  trustProjectForSession,
} from "../config/globalState.js";

const GOLDEN_PATH = path.join(
  import.meta.dirname,
  "__golden__",
  "queryengine-characterization.golden.txt",
);

const FIXED_MODEL = "claude-sonnet-4-20250514";

// Seed messages reused across read-only display commands. Kept tiny + fixed so
// derived token counts stay stable run-to-run.
const SEED_MESSAGES: MessageParam[] = [
  { role: "user", content: "What is 2 + 2?" },
  { role: "assistant", content: [{ type: "text", text: "2 + 2 = 4." }] },
];

// ─── Normalization ────────────────────────────────────────────────────────
// Strip everything that legitimately varies run-to-run (paths, time, network,
// node version) so the golden stays stable while still locking real behavior.
const replacements: Array<[RegExp | string, string]> = [];

function registerPathReplacement(absPath: string, token: string): void {
  // Match the literal path anywhere in a line.
  replacements.push([absPath, token]);
}

function normalize(text: string): string {
  let out = text.replace(/\r\n?/g, "\n");
  // Apply path replacements LONGEST-FIRST so a nested temp dir
  // (e.g. <TMP>/mem-xxxx) is collapsed before its parent prefix (<TMP>)
  // can swallow the prefix and leak the random mkdtemp suffix.
  const sorted = [...replacements].sort((a, b) => {
    const al = typeof a[0] === "string" ? a[0].length : 0;
    const bl = typeof b[0] === "string" ? b[0].length : 0;
    return bl - al;
  });
  for (const [from, to] of sorted) {
    if (typeof from === "string") {
      out = out.split(from).join(to);
    } else {
      out = out.replace(from, to);
    }
  }
  out = out.replace(
    /<(?:TMP|TMPDIR|CWD|PERMCWD|MEMCWD|CFGCWD|HOME)>[^\n]*/g,
    (line) => line.replace(/\\/g, "/"),
  );
  // ISO timestamps → <TIME>
  out = out.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<TIME>");
  // Node version → <NODE>
  out = out.split(process.version).join("<NODE>");
  // Home dir → <HOME>
  out = out.split(os.homedir()).join("<HOME>");
  // /doctor: endpoint reachability is a live network probe — collapse it
  // (matches anywhere on the line, so the "  | " indent prefix is preserved).
  out = out.replace(/[✓⚠✗] Endpoint (reachable|not reachable)[^\n]*/g, "<ENDPOINT_PROBE>");
  // /doctor: API-auth-token status depends on the ambient environment — collapse it.
  out = out.replace(/[✓✗] (API auth token present|No API auth token)[^\n]*/g, "<AUTH_TOKEN>");
  // Clipboard executables and error hints vary by platform. The test disables
  // executable discovery while exercising /copy, so it never changes the
  // developer's clipboard; normalize the resulting platform-specific detail.
  out = out.replace(/Could not copy to clipboard:[^\n]*/g, "<CLIPBOARD_RESULT>");
  // /context includes platform-specific system prompt text, so its token count
  // and the derived free-space totals differ across operating systems.
  out = out.replace(/System prompt\s+[^\n]*/g, "System prompt          <SYSTEM_PROMPT_USAGE>");
  out = out.replace(/Tool definitions\s+[^\n]*/g, "Tool definitions       <TOOL_DEFINITION_USAGE>");
  out = out.replace(/Free space\s+[^\n]*/g, "Free space             <FREE_SPACE>");
  out = out.replace(/Estimated used: [^\n]*/g, "Estimated used: <ESTIMATED_USAGE>");
  out = out.replace(/Always loaded: [^\n]*/g, "Always loaded: <ALWAYS_LOADED_USAGE>");
  out = out.replace(/Tools enabled \(\d+\): ([^\n]*)/g, (_match, list: string) => {
    const tools = list.split(", ").filter((tool) => tool !== "PowerShell");
    return `Tools enabled (${tools.length}): ${tools.join(", ")}`;
  });
  // The host sandbox capability is exercised by the separate platform group.
  out = out.replace(/[✓⚠✗] Sandbox:[^\n]*/g, "<SANDBOX_STATUS>");
  // Empty command-output rows are formatted as `"  | "` for readability in
  // memory, but the golden should not carry invisible trailing whitespace.
  return out.split("\n").map((line) => line.trimEnd()).join("\n");
}

// ─── Event formatting ───────────────────────────────────────────────────────
// Render one event into a stable, human-readable, assertion-friendly block.
function formatEvent(e: QueryEngineEvent): string {
  switch (e.type) {
    case "command_progress":
      return `command_progress ${e.title} [${e.spinnerLabel}]: ${e.message}`;
    case "command":
      return `command[${e.kind}]:\n${indent(e.message)}`;
    case "notice":
      return `notice[${e.tone}] ${e.title}: ${e.body}`;
    case "messages_updated":
      return `messages_updated (count=${e.messages.length})`;
    case "session_cleared":
      return "session_cleared";
    case "mode_changed":
      return `mode_changed ${e.previousMode} -> ${e.mode}`;
    case "task_mode_changed":
      return `task_mode_changed ${e.previousMode} -> ${e.mode}`;
    case "model_changed":
      return `model_changed model=${e.model} source=${e.source}`;
    case "compacted":
      return `compacted trigger=${e.trigger}`;
    case "usage_updated":
      return `usage_updated in=${e.totalUsage.input_tokens} out=${e.totalUsage.output_tokens}`;
    case "token_warning":
      return `token_warning state=${e.warning.state}`;
    case "resume_picker": {
      const rows = e.sessions
        .map(
          (s, i) =>
            `  ${i + 1}. ${s.firstPrompt ? `"${s.firstPrompt.slice(0, 40)}"` : "(empty)"}` +
            `${s.isCurrent ? " (current)" : ""} · ${s.messageCount} msg · ${s.model}`,
        )
        .join("\n");
      return `resume_picker (${e.sessions.length}):\n${rows}`;
    }
    case "session_switched":
      return `session_switched msgs=${e.messages.length} snapshots=${e.fileHistorySnapshots.length}`;
    case "diff_view": {
      const d = e.data;
      const files = d.files
        .slice(0, 3)
        .map((f) => `  ${f.status} ${f.path} (${f.lines.length} patch lines)`)
        .join("\n");
      return (
        `diff_view isRepo=${d.isRepo} files=${d.files.length} truncated=${d.truncated} ` +
        `fileHistory=${d.fileHistory.state}` +
        (files ? `\n${files}` : "")
      );
    }
    case "open_editor":
      return `open_editor ${e.label}: ${e.filePath}`;
    case "memory_picker": {
      const rows = e.items
        .map((it, i) => `  ${i + 1}. ${it.label} (${it.exists ? "exists" : "new"})`)
        .join("\n");
      return `memory_picker (${e.items.length}):\n${rows}`;
    }
    case "permissions_view": {
      const d = e.data;
      const allow = d.allow.map((r) => `  allow ${r.rule} [${r.scope}]`).join("\n");
      const deny = d.deny.map((r) => `  deny ${r.rule} [${r.scope}]`).join("\n");
      return (
        `permissions_view mode=${d.mode} allow=${d.allow.length} deny=${d.deny.length}` +
        (allow ? `\n${allow}` : "") +
        (deny ? `\n${deny}` : "")
      );
    }
    default:
      // Streaming / agentic events (text, tool_use_*, etc.) — should not appear
      // for local commands. Record the bare type so unexpected ones surface.
      return `event:${(e as { type: string }).type}`;
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `  | ${l}`)
    .join("\n");
}

// Drive one command/input and return its formatted (un-normalized) block.
async function record(engine: QueryEngine, input: string): Promise<string> {
  const lines: string[] = [`>>> ${input}`];
  const gen = engine.submitMessage(input);
  while (true) {
    const { value, done } = await gen.next();
    if (done) {
      lines.push(`<<< handled=${value.handled}${value.reason ? ` reason=${value.reason}` : ""}`);
      break;
    }
    lines.push(formatEvent(value));
  }
  return lines.join("\n");
}

function makeEngine(cwd: string, overrides: Partial<QueryEngineOptions> = {}): QueryEngine {
  return new QueryEngine({
    model: FIXED_MODEL,
    toolContext: { cwd, sessionId: "char-session" },
    permissionMode: "default",
    permissionSettings: { allow: [], deny: [], mode: "default" },
    ...overrides,
  });
}

// ─── Scenarios ──────────────────────────────────────────────────────────────
async function buildRecording(): Promise<string> {
  const sections: string[] = [];
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "easy-agent-char-"));
  // Local slash commands must be characterized against an empty user profile.
  // Otherwise a developer's ~/.easy-agent/settings.json, plugins, skills, or
  // agents silently change the golden (installing any plugin used to make this
  // test fail). Node's os.homedir() observes HOME on POSIX, matching the
  // isolation strategy used by the stage-specific integration suites.
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const isolatedHome = path.join(tmpRoot, "home");
  await mkdir(isolatedHome, { recursive: true });
  process.env.HOME = isolatedHome;
  process.env.USERPROFILE = isolatedHome;
  resetGlobalStateCache();
  registerPathReplacement(tmpRoot, "<TMP>");
  registerPathReplacement(os.tmpdir(), "<TMPDIR>");

  const isolatedCwd = path.join(tmpRoot, "project");
  await mkdir(isolatedCwd, { recursive: true });
  await trustProjectForSession(isolatedCwd);
  registerPathReplacement(isolatedCwd, "<CWD>");

  async function section(label: string, fn: () => Promise<string[]>): Promise<void> {
    const blocks = await fn();
    sections.push(`### ${label}\n${blocks.join("\n\n")}`);
  }

  // help / cost / clear -------------------------------------------------------
  await section("help", async () => [await record(makeEngine(isolatedCwd), "/help")]);

  await section("cost", async () => {
    const e = makeEngine(isolatedCwd, { initialUsage: { input_tokens: 100, output_tokens: 50 } });
    return [await record(e, "/cost")];
  });

  await section("clear", async () => {
    const e = makeEngine(isolatedCwd, { initialMessages: SEED_MESSAGES });
    return [await record(e, "/clear")];
  });

  // mode ----------------------------------------------------------------------
  await section("mode", async () => {
    const e = makeEngine(isolatedCwd);
    return [
      await record(e, "/mode"),
      await record(e, "/mode plan"),
      await record(e, "/mode"),
      await record(e, "/mode default"),
      await record(e, "/mode auto"),
      await record(e, "/mode bogus"),
    ];
  });

  // tasks (status + errors only — avoid mutating the process-global task mode) -
  await section("tasks", async () => {
    const original = getTaskMode();
    const e = makeEngine(isolatedCwd);
    const out = [
      await record(e, "/tasks"),
      await record(e, `/tasks ${original}`),
      await record(e, "/tasks bogus"),
    ];
    setTaskMode(original);
    return out;
  });

  // model ---------------------------------------------------------------------
  await section("model", async () => {
    const e = makeEngine(isolatedCwd);
    return [
      await record(e, "/model"),
      await record(e, "/model list"),
      await record(e, "/model my-custom-model"),
      await record(e, "/model"),
      await record(e, "/model default"),
    ];
  });

  // history -------------------------------------------------------------------
  await section("history", async () => [await record(makeEngine(isolatedCwd), "/history")]);

  // status / context ----------------------------------------------------------
  await section("status", async () => {
    const e = makeEngine(isolatedCwd, {
      initialMessages: SEED_MESSAGES,
      initialUsage: { input_tokens: 100, output_tokens: 50 },
    });
    return [await record(e, "/status")];
  });

  await section("context", async () => {
    const e = makeEngine(isolatedCwd, { initialMessages: SEED_MESSAGES });
    return [await record(e, "/context")];
  });

  // doctor --------------------------------------------------------------------
  await section("doctor", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 401 })) as typeof fetch;
    try {
      return [await record(makeEngine(isolatedCwd), "/doctor")];
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // copy ----------------------------------------------------------------------
  await section("copy", async () => {
    const empty = makeEngine(isolatedCwd);
    const seeded = makeEngine(isolatedCwd, { initialMessages: SEED_MESSAGES });
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      return [
        await record(empty, "/copy"),
        await record(seeded, "/copy"),
        await record(seeded, "/copy 99"),
        await record(seeded, "/copy abc"),
      ];
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  // export --------------------------------------------------------------------
  await section("export", async () => {
    const e = makeEngine(isolatedCwd, { initialMessages: SEED_MESSAGES });
    const exportPath = path.join(tmpRoot, "export.md");
    return [await record(e, `/export ${exportPath}`)];
  });

  // resume --------------------------------------------------------------------
  await section("resume", async () => {
    const targetId = "char-resume-target";
    await initSessionStorage({
      sessionId: targetId,
      cwd: isolatedCwd,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      model: FIXED_MODEL,
    });
    await appendTranscriptEntry(isolatedCwd, targetId, {
      type: "message",
      timestamp: new Date().toISOString(),
      role: "user",
      message: { role: "user", content: "Hello from the OLD session." },
    });
    await appendTranscriptEntry(isolatedCwd, targetId, {
      type: "message",
      timestamp: new Date().toISOString(),
      role: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Reply from OLD." }] },
    });
    const e = makeEngine(isolatedCwd, { initialMessages: SEED_MESSAGES });
    const out = [
      await record(e, "/resume"),
      await record(e, `/resume ${targetId}`),
    ];
    const { transcriptPath } = await getSessionPaths(isolatedCwd, targetId);
    await rm(transcriptPath, { force: true });
    return out;
  });

  // diff (non-git dir → isRepo false) -----------------------------------------
  await section("diff", async () => {
    const e = makeEngine(isolatedCwd);
    return [
      await record(e, "/diff"),
      await record(e, "/diff 2"),
      await record(e, "/diff xyz"),
    ];
  });

  // permissions ---------------------------------------------------------------
  await section("permissions", async () => {
    const permCwd = await mkdtemp(path.join(tmpRoot, "perm-"));
    registerPathReplacement(permCwd, "<PERMCWD>");
    const e = makeEngine(permCwd);
    const out = [
      await record(e, "/permissions"),
      await record(e, "/permissions allow Read --local"),
      await record(e, "/permissions deny Bash(rm:*) --project"),
      await record(e, "/permissions list"),
      await record(e, "/permissions remove Read --local"),
    ];
    const view = await e.mutatePermissionRule("allow", "Glob", "project");
    out.push(
      `>>> engine.mutatePermissionRule('allow','Glob','project')\n` +
        `permissions_view mode=${view.mode} allow=${view.allow.length} deny=${view.deny.length}`,
    );
    await e.mutatePermissionRule("remove", "Glob", "project");
    return out;
  });

  // memory --------------------------------------------------------------------
  await section("memory", async () => {
    const memCwd = await mkdtemp(path.join(tmpRoot, "mem-"));
    registerPathReplacement(memCwd, "<MEMCWD>");
    const e = makeEngine(memCwd);
    return [
      await record(e, "/memory"),
      await record(e, "/memory list"),
      await record(e, "/memory edit 2"),
      await record(e, "/memory edit 99"),
    ];
  });

  // config --------------------------------------------------------------------
  await section("config", async () => {
    const cfgCwd = await mkdtemp(path.join(tmpRoot, "cfg-"));
    await trustProjectForSession(cfgCwd);
    registerPathReplacement(cfgCwd, "<CFGCWD>");
    const e = makeEngine(cfgCwd);
    return [
      await record(e, "/config list"),
      await record(e, "/config get model"),
      await record(e, "/config set cleanupPeriodDays 7 --local"),
      await record(e, "/config get cleanupPeriodDays"),
    ];
  });

  // output-style --------------------------------------------------------------
  await section("output-style", async () => {
    const e = makeEngine(isolatedCwd);
    return [await record(e, "/output-style")];
  });

  // skills / agents / hooks / mcp ---------------------------------------------
  await section("skills", async () => [await record(makeEngine(isolatedCwd), "/skills")]);
  await section("agents", async () => [await record(makeEngine(isolatedCwd), "/agents")]);
  await section("hooks", async () => [await record(makeEngine(isolatedCwd), "/hooks")]);
  await section("mcp", async () => {
    const e = makeEngine(isolatedCwd);
    return [
      await record(e, "/mcp"),
      await record(e, "/mcp tools"),
      await record(e, "/mcp reconnect nonexistent"),
    ];
  });

  // unknown command -----------------------------------------------------------
  await section("unknown", async () => [await record(makeEngine(isolatedCwd), "/bogus")]);

  const recording = normalize(sections.join("\n\n"));
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  await rm(tmpRoot, { recursive: true, force: true });

  return recording;
}

async function main(): Promise<void> {
  const update = process.argv.includes("--update");
  const recording = await buildRecording();

  await mkdir(path.dirname(GOLDEN_PATH), { recursive: true });

  if (update) {
    await writeFile(GOLDEN_PATH, recording, "utf8");
    process.stdout.write(`\u001b[33m[updated]\u001b[0m golden written to ${GOLDEN_PATH}\n`);
    return;
  }

  let golden: string;
  try {
    golden = (await readFile(GOLDEN_PATH, "utf8")).replace(/\r\n?/g, "\n");
  } catch {
    process.stderr.write(
      `\u001b[31m[error]\u001b[0m no golden file found at ${GOLDEN_PATH}.\n` +
        `Run once with --update to generate the baseline (from KNOWN-GOOD code).\n`,
    );
    process.exit(1);
    return;
  }

  if (recording === golden) {
    const sections = (recording.match(/^### /gm) ?? []).length;
    process.stdout.write(
      `\u001b[32m[pass]\u001b[0m QueryEngine characterization matches golden ` +
        `(${sections} command groups, ${recording.split("\n").length} lines).\n`,
    );
    return;
  }

  // Show the first divergence to make regressions easy to locate.
  const a = recording.split("\n");
  const b = golden.split("\n");
  const max = Math.max(a.length, b.length);
  let firstDiff = -1;
  for (let i = 0; i < max; i++) {
    if (a[i] !== b[i]) {
      firstDiff = i;
      break;
    }
  }
  process.stderr.write(`\u001b[31m[fail]\u001b[0m recording diverged from golden.\n`);
  if (firstDiff >= 0) {
    const ctxStart = Math.max(0, firstDiff - 3);
    process.stderr.write(`First difference at line ${firstDiff + 1}:\n`);
    for (let i = ctxStart; i <= firstDiff; i++) {
      process.stderr.write(`  golden ${i + 1}: ${JSON.stringify(b[i])}\n`);
      process.stderr.write(`  actual ${i + 1}: ${JSON.stringify(a[i])}\n`);
    }
  }
  process.stderr.write(
    `\nIf this change is INTENTIONAL, re-run with --update. Otherwise it's a regression.\n`,
  );
  // Use a real assertion so the process exit code is non-zero.
  assert.strictEqual(recording, golden, "QueryEngine characterization mismatch");
}

void main();
