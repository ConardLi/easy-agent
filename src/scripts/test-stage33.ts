/**
 * Stage 33 smoke test — drives the new built-in commands through a real
 * QueryEngine (no UI) and prints their command-panel output.
 *
 * Run: npx tsx src/scripts/test-stage33.ts
 */

import * as os from "node:os";
import * as path from "node:path";
import { QueryEngine } from "../core/queryEngine.js";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { rm, mkdtemp } from "node:fs/promises";
import { initSessionStorage, appendTranscriptEntry, getSessionPaths } from "../session/storage.js";
import { tryExpandBuiltinPromptCommand } from "../commands/builtinPromptCommands.js";

async function runCommand(engine: QueryEngine, input: string): Promise<void> {
  process.stdout.write(`\n\u001b[1m$ ${input}\u001b[0m\n`);
  const gen = engine.submitMessage(input);
  while (true) {
    const { value, done } = await gen.next();
    if (done) break;
    if (value.type === "command") {
      const tag = value.kind === "error" ? "[error]" : "[info]";
      process.stdout.write(`${tag}\n${value.message}\n`);
    } else if (value.type === "session_switched") {
      process.stdout.write(
        `[event] session_switched → ${value.sessionId} (${value.messages.length} msgs, snapshots: ${value.fileHistorySnapshots.length})\n`,
      );
    } else if (value.type === "resume_picker") {
      process.stdout.write(`[event] resume_picker → ${value.sessions.length} session(s):\n`);
      value.sessions.forEach((s, i) => {
        const cur = s.isCurrent ? " (current)" : "";
        const promptLabel = s.firstPrompt ? `"${s.firstPrompt.slice(0, 40)}"` : "(empty)";
        process.stdout.write(`  ${i + 1}. ${promptLabel}${cur} · ${s.messageCount} msg · ${s.model} · ${s.sessionId.slice(0, 8)}\n`);
      });
    } else if (value.type === "diff_view") {
      const { data } = value;
      process.stdout.write(
        `[event] diff_view → isRepo=${data.isRepo}, files=${data.files.length}, truncated=${data.truncated}, fileHistory=${data.fileHistory.state}\n`,
      );
      for (const f of data.files.slice(0, 3)) {
        process.stdout.write(`  ${f.status} ${f.path} (${f.lines.length} patch lines)\n`);
      }
    } else if (value.type === "open_editor") {
      process.stdout.write(`[event] open_editor → ${value.label}: ${value.filePath}\n`);
    } else if (value.type === "memory_picker") {
      process.stdout.write(`[event] memory_picker → ${value.items.length} item(s):\n`);
      value.items.forEach((it, i) => {
        process.stdout.write(`  ${i + 1}. ${it.label}  (${it.exists ? it.size + "B" : "new"})\n`);
      });
    } else if (value.type === "permissions_view") {
      const { data } = value;
      process.stdout.write(`[event] permissions_view → mode=${data.mode}, allow=${data.allow.length}, deny=${data.deny.length}\n`);
      for (const r of data.allow) process.stdout.write(`  allow ${r.rule} [${r.scope}]\n`);
      for (const r of data.deny) process.stdout.write(`  deny  ${r.rule} [${r.scope}]\n`);
    } else if (value.type === "messages_updated") {
      // /init expands into a model turn; show the marker bubble that was added.
      const last = value.messages[value.messages.length - 1];
      if (last && typeof last.content === "string" && last.content.includes("command-name")) {
        process.stdout.write(`[event] command bubble → ${last.content.replace(/\n/g, " ")}\n`);
      }
    }
  }
}

async function main(): Promise<void> {
  const cwd = process.cwd();

  // Seed a separate saved session so /resume has a real target to switch to.
  const targetId = "stage33-resume-target";
  await initSessionStorage({
    sessionId: targetId,
    cwd,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    model: "claude-sonnet-4-20250514",
  });
  await appendTranscriptEntry(cwd, targetId, {
    type: "message",
    timestamp: new Date().toISOString(),
    role: "user",
    message: { role: "user", content: "Hello from the OLD session." },
  });
  await appendTranscriptEntry(cwd, targetId, {
    type: "message",
    timestamp: new Date().toISOString(),
    role: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "Reply from the OLD session." }] },
  });

  const seedMessages: MessageParam[] = [
    { role: "user", content: "What is 2 + 2?" },
    { role: "assistant", content: [{ type: "text", text: "2 + 2 = 4." }] },
  ];

  const engine = new QueryEngine({
    model: "claude-sonnet-4-20250514",
    toolContext: { cwd, sessionId: "stage33-current-session" },
    initialMessages: seedMessages,
    initialUsage: { input_tokens: 100, output_tokens: 50 },
    permissionMode: "default",
    permissionSettings: { allow: [], deny: [], mode: "default" },
  });

  // ── /export ──
  const exportPath = path.join(os.tmpdir(), "easy-agent-stage33-export.md");
  await runCommand(engine, `/export ${exportPath}`);

  // ── /diff ──
  await runCommand(engine, "/diff");
  await runCommand(engine, "/diff 2");
  await runCommand(engine, "/diff xyz");

  // ── /resume ──
  await runCommand(engine, "/resume");
  await runCommand(engine, `/resume ${targetId}`);
  // After the switch, the engine should now hold the OLD session's messages.
  await runCommand(engine, "/status");

  // ── /init (batch 3) — expansion only; running it would hit the model. ──
  process.stdout.write("\n\u001b[1m$ /init (expansion check)\u001b[0m\n");
  const initExp = tryExpandBuiltinPromptCommand("/init focus on the CLI");
  if (initExp) {
    process.stdout.write(`[ok] marker: ${initExp.markerContent.replace(/\n/g, " ")}\n`);
    process.stdout.write(`[ok] body starts: ${initExp.bodyText.split("\n").slice(0, 2).join(" / ").slice(0, 90)}…\n`);
  } else {
    process.stdout.write("[error] /init did not expand!\n");
  }
  process.stdout.write(`[ok] /notacommand expands? ${tryExpandBuiltinPromptCommand("/notacommand") ? "yes (BUG)" : "no"}\n`);

  // ── /permissions + /memory (batch 3) — run against a throwaway cwd so we
  //    never touch the real project's settings or AGENT.md. ──
  const tmpCwd = await mkdtemp(path.join(os.tmpdir(), "easy-agent-stage33-"));
  const tmpEngine = new QueryEngine({
    model: "claude-sonnet-4-20250514",
    toolContext: { cwd: tmpCwd, sessionId: "stage33-tmp" },
    permissionSettings: { allow: [], deny: [], mode: "default" },
  });

  // No-arg now opens the interactive manager (permissions_view event).
  await runCommand(tmpEngine, "/permissions");
  // Text subcommands still work (headless / power-user path).
  await runCommand(tmpEngine, "/permissions allow Read --local");
  await runCommand(tmpEngine, "/permissions deny Bash(rm:*) --project");
  await runCommand(tmpEngine, "/permissions list");
  await runCommand(tmpEngine, "/permissions remove Read --local");
  // Direct mutate path used by the interactive overlay (project scope → temp cwd).
  process.stdout.write("\n\u001b[1m$ engine.mutatePermissionRule('allow', 'Glob', 'project')\u001b[0m\n");
  const afterMutate = await tmpEngine.mutatePermissionRule("allow", "Glob", "project");
  process.stdout.write(`[ok] view after mutate → allow=${afterMutate.allow.length}: ${afterMutate.allow.map((r) => `${r.rule}[${r.scope}]`).join(", ")}\n`);
  await tmpEngine.mutatePermissionRule("remove", "Glob", "project");

  // No-arg now opens the interactive file picker (memory_picker event).
  await runCommand(tmpEngine, "/memory");
  await runCommand(tmpEngine, "/memory list");
  // Index 2 is the project (cwd) AGENT.md inside the temp dir; edit creates it
  // and emits open_editor (no actual editor runs in this headless harness).
  await runCommand(tmpEngine, "/memory edit 2");
  await runCommand(tmpEngine, "/memory edit 99");

  // Clean up the seeded session + export + temp cwd so nothing pollutes real
  // project history / leaves files behind.
  const { transcriptPath } = await getSessionPaths(cwd, targetId);
  await rm(transcriptPath, { force: true });
  await rm(exportPath, { force: true });
  await rm(tmpCwd, { recursive: true, force: true });

  process.stdout.write("\n\u001b[32mStage 33 batch 3 smoke test complete.\u001b[0m\n");
}

void main();
