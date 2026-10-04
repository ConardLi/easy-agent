/**
 * Interactive session characterization (golden-master) test.
 *
 * Locks the behavior of the interactive session hook (`useAgentSession`)
 * around real model turns: what reaches the provider, what the user sees at
 * each prompt (permission / question), how interrupt and plan approval are
 * resolved, what gets written to the session transcript, and how a resumed
 * session is rebuilt from it. The QueryEngine characterization covers local
 * slash commands only; this one covers the turn path the hook drives.
 *
 * A local Anthropic fixture answers each request from a per-scenario script,
 * and the hook runs inside a real Ink render with a throwaway stdout.
 *
 * Run:    npx tsx src/scripts/test-interactive-session-characterization.tsx
 * Update: npx tsx src/scripts/test-interactive-session-characterization.tsx --update
 *         (regenerate the golden — only after an intentional behavior change)
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import * as os from "node:os";
import * as path from "node:path";
import type React from "react";

// realpath: the hook keys transcripts by process.cwd(), which resolves
// symlinked temp dirs such as macOS /var → /private/var.
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "easy-agent-session-char-")));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
await Promise.all([
  mkdir(path.join(home, ".easy-agent"), { recursive: true }),
  mkdir(path.join(cwd, ".easy-agent"), { recursive: true }),
]);
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.EASY_AGENT_DISABLE_HOOKS = "1";
process.env.EASY_AGENT_ENABLE_TOOL_SEARCH = "false";
process.chdir(cwd);

const GOLDEN_PATH = path.join(import.meta.dirname, "__golden__", "interactive-session-characterization.golden.txt");
const MODEL = "fixture-model";

// ─── Fixture provider ─────────────────────────────────────────────────────

type ScriptStep = { kind: "text"; text: string } | { kind: "tool"; name: string; input: Record<string, unknown> };

let script: ScriptStep[] = [];
let toolSeq = 0;
const requests: Array<{ messages: unknown[] }> = [];

function sse(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamFor(step: ScriptStep, seq: number): string {
  const start = sse("message_start", {
    type: "message_start",
    message: {
      id: `msg_${seq}`,
      type: "message",
      role: "assistant",
      model: MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });
  const body =
    step.kind === "text"
      ? [
          sse("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          }),
          sse("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: step.text },
          }),
        ]
      : [
          sse("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: `toolu_${++toolSeq}`, name: step.name, input: {} },
          }),
          sse("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(step.input) },
          }),
        ];
  return [
    start,
    ...body,
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: step.kind === "text" ? "end_turn" : "tool_use", stop_sequence: null },
      usage: { output_tokens: 5 },
    }),
    sse("message_stop", { type: "message_stop" }),
  ].join("");
}

const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: unknown[] };
    requests.push({ messages: body.messages ?? [] });
    const step = script.shift() ?? { kind: "text", text: "(fixture script exhausted)" };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(streamFor(step, requests.length));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.ANTHROPIC_AUTH_TOKEN = "fixture-token";

const { render, Text } = await import("ink");
const { useAgentSession } = await import("../ui/hooks/useAgentSession.js");
const { getLatestSessionId, getSessionPaths } = await import("../session/storage.js");
const { writePlan, getPlanFilePath } = await import("../context/plans.js");
const { enqueuePendingNotification } = await import("../state/notificationStore.js");

type Session = ReturnType<typeof useAgentSession>;
type SessionProps = Parameters<typeof useAgentSession>[0];

// ─── Recording + normalization ───────────────────────────────────────────

const lines: string[] = [];
const out = (line = ""): void => {
  lines.push(line);
};

function normalize(text: string): string {
  return text
    .split(cwd)
    .join("<CWD>")
    .split(home)
    .join("<HOME>")
    .split(root)
    .join("<TMP>")
    .replace(/<(?:CWD|HOME|TMP)>[^\s)"]*/g, (match) => match.replace(/\\/g, "/"))
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<TIME>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<UUID>")
    .replace(/plans\/[0-9a-f]{8}\.md/g, "plans/<SLUG>.md");
}

function clip(text: string, max = 90): string {
  const flat = normalize(text).replace(/\n/g, "\\n");
  return flat.length > max ? `${flat.slice(0, max)}…(${flat.length})` : flat;
}

function describeContent(content: unknown): string {
  if (typeof content === "string") return `text(${clip(content)})`;
  if (!Array.isArray(content)) return String(content);
  return content
    .map((block: Record<string, unknown>) => {
      switch (block.type) {
        case "text":
          return `text(${clip(String(block.text))})`;
        case "tool_use":
          return `tool_use(${block.name} ${clip(JSON.stringify(block.input), 60)})`;
        case "tool_result": {
          const raw = block.content;
          const text = typeof raw === "string" ? raw : JSON.stringify(raw);
          return `tool_result(${block.is_error ? "error " : ""}${clip(text, 70)})`;
        }
        default:
          return String(block.type);
      }
    })
    .join(" + ");
}

function describeMessages(messages: unknown[], indent = "    "): void {
  for (const message of messages as Array<{ role: string; content: unknown }>) {
    out(`${indent}${message.role}: ${describeContent(message.content)}`);
  }
}

function recordRequests(fromIndex: number): void {
  for (let i = fromIndex; i < requests.length; i++) {
    out(`  request #${i + 1 - fromIndex}`);
    describeMessages(requests[i]!.messages);
  }
}

function recordState(session: Session): void {
  const s = session.state;
  out("  state:");
  out(`    isLoading=${s.isLoading} permissionMode=${s.permissionMode} model=${s.currentModel}`);
  out(
    `    notice=${s.systemNotice ? `[${s.systemNotice.tone}] ${clip(s.systemNotice.title)}: ${clip(s.systemNotice.body)}` : "none"}`,
  );
  out(`    usage total=${s.totalUsage ? `${s.totalUsage.input}/${s.totalUsage.output}` : "none"}`);
  out(`    messages (${s.messages.length}):`);
  describeMessages(s.messages, "      ");
}

async function recordTranscript(sessionId: string): Promise<void> {
  const { transcriptPath } = await getSessionPaths(cwd, sessionId);
  const raw = await readFile(transcriptPath, "utf8");
  out("  transcript:");
  for (const line of raw.split("\n").filter(Boolean)) {
    const entry = JSON.parse(line) as Record<string, unknown>;
    switch (entry.type) {
      case "session_meta":
        out(`    session_meta model=${entry.model}`);
        break;
      case "message": {
        const message = entry.message as { role: string; content: unknown };
        out(`    message ${message.role}${entry.messageId ? " [turn]" : ""}: ${describeContent(message.content)}`);
        break;
      }
      case "tool_event":
        out(
          `    tool_event ${entry.phase} ${entry.name}` +
            (entry.phase === "done" ? ` isError=${entry.isError === true} length=${entry.resultLength}` : ""),
        );
        break;
      case "usage": {
        const turn = entry.turn as { input_tokens: number; output_tokens: number };
        const total = entry.total as { input_tokens: number; output_tokens: number };
        out(
          `    usage turn=${turn.input_tokens}/${turn.output_tokens} total=${total.input_tokens}/${total.output_tokens}`,
        );
        break;
      }
      case "system":
        out(`    system[${entry.level}] ${clip(String(entry.message))}`);
        break;
      case "file_history_snapshot": {
        const snapshot = entry.snapshot as { trackedFileBackups?: Record<string, unknown> };
        const files = Object.keys(snapshot.trackedFileBackups ?? {}).map((file) => normalize(file).replace(/\\/g, "/"));
        out(`    file_history_snapshot files=[${files.join(", ")}]`);
        break;
      }
      default:
        out(`    ${entry.type}`);
    }
  }
}

// ─── Harness ─────────────────────────────────────────────────────────────

let current: Session | null = null;

function Harness(props: SessionProps): React.ReactNode {
  const session = useAgentSession(props);
  current = session;
  return <Text>{session.state.isLoading ? "busy" : "idle"}</Text>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label: string, predicate: (session: Session) => boolean, timeoutMs = 15_000): Promise<Session> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (current && predicate(current)) return current;
    await sleep(10);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

/** Lets React commit the last state updates of a finished submit. */
async function settle(): Promise<Session> {
  await sleep(80);
  return current!;
}

async function mount(props: Partial<SessionProps> = {}): Promise<{ unmount: () => void }> {
  current = null;
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  stdout.columns = 100;
  stdout.rows = 40;
  stdout.on("data", () => {});
  const instance = render(<Harness model={MODEL} onExit={() => {}} {...props} />, {
    stdout,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  // The hook creates its engine asynchronously and exposes no ready flag.
  // `pluginPreview` is a read-only action that throws this exact message
  // until the engine exists, so it doubles as a side-effect-free probe.
  const deadline = Date.now() + 15_000;
  for (;;) {
    const session = await waitFor("session mounted", () => true);
    const ready = await session.actions.pluginPreview("probe@none").then(
      () => true,
      (error: unknown) => !(error instanceof Error && error.message === "Plugin manager is not ready."),
    );
    if (ready) break;
    if (Date.now() > deadline) throw new Error("Timed out waiting for the session engine");
    await sleep(10);
  }
  return {
    unmount: () => {
      instance.unmount();
      instance.cleanup();
    },
  };
}

async function latestSessionId(): Promise<string> {
  const id = await getLatestSessionId(cwd);
  assert.ok(id, "a session transcript was written");
  return id;
}

async function scenario(
  name: string,
  steps: ScriptStep[],
  run: () => Promise<void>,
  props: Partial<SessionProps> = {},
): Promise<string> {
  out(`### ${name}`);
  script = [...steps];
  const firstRequest = requests.length;
  const { unmount } = await mount(props);
  try {
    await run();
    const session = await settle();
    recordRequests(firstRequest);
    recordState(session);
    const sessionId = await latestSessionId();
    await recordTranscript(sessionId);
    assert.equal(script.length, 0, `${name}: every scripted response was consumed`);
    out();
    return sessionId;
  } finally {
    unmount();
  }
}

function recordPermissionPrompt(session: Session): void {
  const prompt = session.state.permissionPrompt!;
  out(
    `  permission_prompt tool=${prompt.toolName} isPlanExit=${prompt.isPlanExit === true}` +
      ` risk=${clip(prompt.risk)} rule=${clip(prompt.ruleHint)}`,
  );
  out(`    summary: ${clip(prompt.summary)}`);
  if (prompt.planContent !== undefined)
    out(`    plan: ${clip(prompt.planContent)} @ ${clip(prompt.planFilePath ?? "")}`);
}

// ─── Scenarios ───────────────────────────────────────────────────────────

async function buildRecording(): Promise<void> {
  const textSession = await scenario("text turn", [{ kind: "text", text: "Hello there." }], async () => {
    out('>>> submit "Say hello."');
    await current!.actions.submit("Say hello.");
  });

  await scenario(
    "tool call allowed once",
    [
      { kind: "tool", name: "Write", input: { file_path: "notes.txt", content: "one\n" } },
      { kind: "text", text: "Wrote notes.txt." },
    ],
    async () => {
      out('>>> submit "Create notes.txt."');
      const done = current!.actions.submit("Create notes.txt.");
      recordPermissionPrompt(await waitFor("permission prompt", (s) => s.state.permissionPrompt !== null));
      out(">>> resolvePermission allow_once");
      current!.actions.resolvePermission("allow_once");
      await done;
      out(`  notes.txt: ${clip(await readFile(path.join(cwd, "notes.txt"), "utf8"))}`);
    },
  );

  await scenario(
    "tool call denied",
    [
      { kind: "tool", name: "Write", input: { file_path: "denied.txt", content: "no\n" } },
      { kind: "text", text: "Understood, not writing it." },
    ],
    async () => {
      out('>>> submit "Create denied.txt."');
      const done = current!.actions.submit("Create denied.txt.");
      await waitFor("permission prompt", (s) => s.state.permissionPrompt !== null);
      out(">>> resolvePermission deny");
      current!.actions.resolvePermission("deny");
      await done;
    },
  );

  await scenario(
    "interrupt while a permission prompt is open",
    [
      { kind: "tool", name: "Write", input: { file_path: "interrupted.txt", content: "x\n" } },
      { kind: "text", text: "Stopped as asked." },
    ],
    async () => {
      out('>>> submit "Create interrupted.txt."');
      const done = current!.actions.submit("Create interrupted.txt.");
      await waitFor("permission prompt", (s) => s.state.permissionPrompt !== null);
      out(">>> interrupt");
      out(`  interrupt() -> ${current!.actions.interrupt()}`);
      const session = await waitFor("prompt closed", (s) => s.state.permissionPrompt === null);
      out(`  notice after interrupt: ${session.state.systemNotice?.title ?? "none"}`);
      await done;
    },
  );

  await scenario(
    "AskUserQuestion answered",
    [
      {
        kind: "tool",
        name: "AskUserQuestion",
        input: {
          questions: [{ question: "Which color?", header: "Color", options: [{ label: "Red" }, { label: "Blue" }] }],
        },
      },
      { kind: "text", text: "Blue it is." },
    ],
    async () => {
      out('>>> submit "Pick a color with me."');
      const done = current!.actions.submit("Pick a color with me.");
      const session = await waitFor("question prompt", (s) => s.state.questionPrompt !== null);
      const questions = session.state.questionPrompt!.questions;
      out(
        `  question_prompt ${questions.map((q) => `${q.header}: ${q.question} [${q.options.map((o) => o.label).join("|")}]`).join("; ")}`,
      );
      out(">>> resolveQuestion Which color?=Blue");
      current!.actions.resolveQuestion({ answers: { "Which color?": "Blue" } });
      await done;
    },
  );

  await scenario(
    "AskUserQuestion cancelled by interrupt",
    [
      {
        kind: "tool",
        name: "AskUserQuestion",
        input: {
          questions: [{ question: "Which size?", header: "Size", options: [{ label: "S" }, { label: "L" }] }],
        },
      },
      { kind: "text", text: "No answer, moving on." },
    ],
    async () => {
      out('>>> submit "Pick a size with me."');
      const done = current!.actions.submit("Pick a size with me.");
      await waitFor("question prompt", (s) => s.state.questionPrompt !== null);
      out(">>> interrupt");
      out(`  interrupt() -> ${current!.actions.interrupt()}`);
      const session = await waitFor("question closed", (s) => s.state.questionPrompt === null);
      out(`  notice after interrupt: ${session.state.systemNotice?.title ?? "none"}`);
      await done;
    },
  );

  await writePlan("1. Add the feature.\n2. Add tests.\n");
  out(`(plan written to ${normalize(getPlanFilePath())})`);
  out();

  await scenario(
    "plan approved with context clear",
    [
      { kind: "tool", name: "ExitPlanMode", input: { summary: "Add the feature" } },
      { kind: "text", text: "Implementing the plan." },
    ],
    async () => {
      out('>>> submit "Plan the feature."');
      const done = current!.actions.submit("Plan the feature.");
      recordPermissionPrompt(await waitFor("plan approval", (s) => s.state.permissionPrompt !== null));
      out(">>> resolvePermission allow_clear_context");
      current!.actions.resolvePermission("allow_clear_context");
      await done;
    },
    { permissionMode: "plan" },
  );

  await scenario(
    "plan rejected with feedback",
    [
      { kind: "tool", name: "ExitPlanMode", input: { summary: "Add the feature" } },
      { kind: "text", text: "Noted, revising." },
      { kind: "text", text: "Revised plan with tests first." },
    ],
    async () => {
      out('>>> submit "Plan the feature."');
      const done = current!.actions.submit("Plan the feature.");
      await waitFor("plan approval", (s) => s.state.permissionPrompt !== null);
      out(">>> resolvePermission deny feedback=Write the tests first.");
      current!.actions.resolvePermission("deny", "Write the tests first.");
      await done;
    },
    { permissionMode: "plan" },
  );

  await scenario(
    "background notification wakes an idle session",
    [{ kind: "text", text: "The background reviewer found nothing." }],
    async () => {
      const before = requests.length;
      out(">>> enqueuePendingNotification");
      enqueuePendingNotification({
        mode: "task-notification",
        text: "<task-notification><status>completed</status><summary>Reviewer finished</summary></task-notification>",
      });
      await waitFor("auto-submitted turn", (s) => requests.length === before + 1 && !s.state.isLoading);
      await waitFor("assistant reply", (s) => s.state.messages.length >= 2);
    },
  );

  out("### resume");
  script = [{ kind: "text", text: "Still here." }];
  const firstRequest = requests.length;
  const { unmount } = await mount({ shouldResume: true, resumeSessionId: textSession });
  try {
    const restored = await waitFor("restored messages", (s) => s.state.messages.length > 0);
    out(
      `  restored notice: ${restored.state.systemNotice?.title ?? "none"}: ${clip(restored.state.systemNotice?.body ?? "")}`,
    );
    out('>>> submit "Are you still there?"');
    await current!.actions.submit("Are you still there?");
    const session = await settle();
    recordRequests(firstRequest);
    recordState(session);
    assert.equal(await latestSessionId(), textSession, "resume keeps appending to the same session");
    await recordTranscript(textSession);
    out();
  } finally {
    unmount();
  }
}

async function main(): Promise<void> {
  const update = process.argv.includes("--update");
  try {
    await buildRecording();
  } catch (error) {
    process.stderr.write(`Recording so far:\n${lines.join("\n")}\n\n`);
    throw error;
  } finally {
    server.close();
    process.chdir(os.tmpdir());
    await rm(root, { recursive: true, force: true });
  }
  const recording = `${lines.join("\n").trimEnd()}\n`;

  if (update) {
    await mkdir(path.dirname(GOLDEN_PATH), { recursive: true });
    await writeFile(GOLDEN_PATH, recording, "utf8");
    process.stdout.write(`[updated] golden written to ${GOLDEN_PATH}\n`);
    return;
  }

  const golden = (await readFile(GOLDEN_PATH, "utf8")).replace(/\r\n?/g, "\n");
  if (recording !== golden) {
    const a = recording.split("\n");
    const b = golden.split("\n");
    const index = a.findIndex((line, i) => line !== b[i]);
    const at = index === -1 ? Math.min(a.length, b.length) : index;
    process.stderr.write(`[fail] recording diverged from golden at line ${at + 1}:\n`);
    for (let i = Math.max(0, at - 3); i <= at; i++) {
      process.stderr.write(`  golden ${i + 1}: ${JSON.stringify(b[i])}\n  actual ${i + 1}: ${JSON.stringify(a[i])}\n`);
    }
    process.stderr.write("\nIf this change is INTENTIONAL, re-run with --update. Otherwise it's a regression.\n");
  }
  assert.equal(recording, golden, "interactive session characterization mismatch");
  const sections = (recording.match(/^### /gm) ?? []).length;
  process.stdout.write(`[pass] interactive session characterization matches golden (${sections} scenarios).\n`);
}

await main();
process.exit(0);
