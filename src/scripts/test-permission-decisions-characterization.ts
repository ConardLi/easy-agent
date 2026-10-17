/**
 * Permission decision characterization (golden-master) test.
 *
 * Locks what `checkPermission` decides today, as a table of
 * tool × input × permission mode × rules → behavior and reason, before the
 * decision chain is split into named steps. It covers every registered
 * built-in tool, one read-only and one writing MCP tool, the three modes,
 * allow and deny rules from settings and from the session, targeted Bash and
 * WebFetch rules, the Auto Mode classifier outcomes, and how workspace trust
 * filters project rules.
 *
 * The Auto Mode classifier talks to the local Anthropic fixture, which
 * answers with a scripted verdict; each row records whether the classifier
 * was called. Sandbox auto-allow depends on whether this machine can sandbox,
 * so those rows are asserted against the detected capability instead of the
 * golden.
 *
 * Run:    node --import tsx src/scripts/test-permission-decisions-characterization.ts
 * Update: node --import tsx src/scripts/test-permission-decisions-characterization.ts --update
 *         (regenerate the golden, only after an intentional change)
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "easy-agent-permission-char-")));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
await Promise.all([
  mkdir(path.join(home, ".easy-agent"), { recursive: true }),
  mkdir(path.join(cwd, ".easy-agent"), { recursive: true }),
]);
for (const key of Object.keys(process.env)) {
  if (/^(?:ANTHROPIC_|EASY_AGENT_|CLAUDE_CODE_|OPENAI_|GEMINI_)/.test(key)) delete process.env[key];
}
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.EASY_AGENT_DISABLE_HOOKS = "1";
process.chdir(cwd);

const GOLDEN_PATH = path.join(import.meta.dirname, "__golden__", "permission-decisions-characterization.golden.txt");

const { createAnthropicFixture } = await import("./fixtures/anthropicFixture.js");
const fixture = createAnthropicFixture();
await fixture.start();

const { checkPermission } = await import("../permissions/permissions.js");
type PermissionMode = import("../permissions/permissions.js").PermissionMode;
type PermissionRuleSet = import("../permissions/permissions.js").PermissionRuleSet;
const { getRegisteredTools } = await import("../tools/index.js");
type Tool = import("../tools/Tool.js").Tool;
const { getPlanFilePath } = await import("../context/plans.js");
const { resetAutoModeState, recordClassifierFailure } = await import("../permissions/autoModeState.js");
const { trustProjectForSession } = await import("../config/globalState.js");
const { getSandboxCapability } = await import("../sandbox/availability.js");

// ─── Inputs ──────────────────────────────────────────────────────────────

interface InputCase {
  label: string;
  input: Record<string, unknown>;
}

const file = (name: string) => path.join(cwd, name);
const planFile = getPlanFilePath();

/** Representative inputs per tool. Every registered tool needs an entry, so a new tool fails the test until it is added. */
const INPUTS: Record<string, InputCase[]> = {
  Read: [{ label: "workspace file", input: { file_path: file("src/app.ts") } }],
  Write: [
    { label: "workspace file", input: { file_path: file("src/app.ts"), content: "x" } },
    { label: "plan file", input: { file_path: planFile, content: "# Plan" } },
  ],
  Edit: [{ label: "workspace file", input: { file_path: file("src/app.ts"), old_string: "a", new_string: "b" } }],
  MultiEdit: [
    {
      label: "workspace file",
      input: { file_path: file("src/app.ts"), edits: [{ old_string: "a", new_string: "b" }] },
    },
  ],
  Glob: [{ label: "pattern", input: { pattern: "**/*.ts" } }],
  Grep: [{ label: "pattern", input: { pattern: "TODO" } }],
  Bash: [
    { label: "read-only: git status", input: { command: "git status" } },
    { label: "writes: npm install left-pad", input: { command: "npm install left-pad" } },
    { label: "dangerous: rm -rf build", input: { command: "rm -rf build" } },
    { label: "hard-denied in auto: sudo ls", input: { command: "sudo ls" } },
    { label: "compound: git status && touch x", input: { command: "git status && touch x" } },
  ],
  PowerShell: [{ label: "Get-ChildItem", input: { command: "Get-ChildItem" } }],
  WebFetch: [
    { label: "preapproved: docs.python.org", input: { url: "https://docs.python.org/3/", prompt: "summarize" } },
    { label: "other: example.com", input: { url: "https://example.com/page", prompt: "summarize" } },
  ],
  WebSearch: [{ label: "query", input: { query: "node streams" } }],
  ListMcpResources: [{ label: "all servers", input: {} }],
  ReadMcpResource: [{ label: "resource", input: { server: "docs", uri: "docs://index" } }],
  MemoryWrite: [
    {
      label: "project memory",
      input: { name: "Test", description: "d", type: "project", content: "c", file_name: "test.md" },
    },
  ],
  TodoWrite: [{ label: "todos", input: { todos: [] } }],
  TaskCreate: [{ label: "task", input: { subject: "s", description: "d" } }],
  TaskUpdate: [{ label: "task", input: { taskId: "1", status: "completed" } }],
  TaskGet: [{ label: "task", input: { taskId: "1" } }],
  TaskList: [{ label: "all", input: {} }],
  EnterPlanMode: [{ label: "reason", input: { reason: "large change" } }],
  ExitPlanMode: [{ label: "plan", input: { plan: "# Plan" } }],
  Skill: [{ label: "skill", input: { skill: "review" } }],
  AskUserQuestion: [
    {
      label: "question",
      input: { questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B" }] }] },
    },
  ],
  Agent: [{ label: "sub-agent", input: { prompt: "look around", description: "explore" } }],
  TeamCreate: [{ label: "team", input: { team_name: "t", description: "d" } }],
  TeamDelete: [{ label: "team", input: { team_name: "t" } }],
  SendMessage: [{ label: "message", input: { to: "lead", message: "done", summary: "done" } }],
  ToolSearch: [{ label: "query", input: { query: "select:WebFetch" } }],
  LSP: [
    { label: "definition", input: { operation: "definition", file_path: file("src/app.ts"), line: 1, character: 1 } },
  ],
  mcp__docs__search: [{ label: "read-only hint", input: { query: "q" } }],
  mcp__deploy__run: [{ label: "no read-only hint", input: { target: "prod" } }],
};

/** Shaped like the MCP adapter in services/mcp/fetchTools.ts: name, `isMcp`, and `readOnlyHint` as `isReadOnly`. */
function mcpTool(name: string, readOnly: boolean): Tool {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: "object", properties: {} },
    isMcp: true,
    isReadOnly: () => readOnly,
    isEnabled: () => true,
    call: async () => ({ content: "" }),
  } as unknown as Tool;
}

const TOOLS: Tool[] = [
  ...getRegisteredTools().filter((tool) => !tool.isMcp),
  mcpTool("mcp__docs__search", true),
  mcpTool("mcp__deploy__run", false),
];

// ─── Recording ───────────────────────────────────────────────────────────

const MODES: PermissionMode[] = ["default", "plan", "auto"];
const CLASSIFIER_ALLOW = {
  kind: "tool" as const,
  name: "classify_result",
  input: { thinking: "fixture", shouldBlock: false, reason: "fixture verdict: allow" },
};
const CLASSIFIER_BLOCK = {
  kind: "tool" as const,
  name: "classify_result",
  input: { thinking: "fixture", shouldBlock: true, reason: "fixture verdict: block" },
};

function normalize(text: string): string {
  return text
    .split(cwd)
    .join("<CWD>")
    .split(home)
    .join("<HOME>")
    .split(root)
    .join("<TMP>")
    .replace(/<(?:CWD|HOME|TMP)>[^\s)"]*/g, (match) => match.replace(/\\/g, "/"));
}

interface Decision {
  behavior: string;
  reason: string;
  classifier: boolean;
}

async function decide(
  tool: Tool,
  input: Record<string, unknown>,
  options: {
    mode?: PermissionMode;
    settings?: PermissionRuleSet & { mode: PermissionMode };
    sessionRules?: PermissionRuleSet;
    verdicts?: Array<typeof CLASSIFIER_ALLOW>;
  },
): Promise<Decision> {
  fixture.script(options.verdicts ?? [CLASSIFIER_ALLOW]);
  const before = fixture.requests.length;
  const result = await checkPermission({
    tool,
    input,
    cwd,
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.settings ? { settings: options.settings } : {}),
    ...(options.sessionRules ? { sessionRules: options.sessionRules } : {}),
  });
  return { behavior: result.behavior, reason: normalize(result.reason), classifier: fixture.requests.length > before };
}

const row = (cells: string[]) => `| ${cells.map((cell) => cell.replace(/\|/g, "\\|")).join(" | ")} |`;
const show = (d: Decision) => [d.behavior, d.reason, d.classifier ? "yes" : ""];

async function buildRecording(): Promise<string> {
  const lines: string[] = [];
  const out = (line = "") => lines.push(line);

  const missing = TOOLS.map((tool) => tool.name).filter((name) => !INPUTS[name]);
  assert.deepEqual(missing, [], `add representative inputs for: ${missing.join(", ")}`);

  out("## Tools × modes × settings rules");
  out("");
  out(
    'Rules are settings rules naming the tool alone (`"Write"`). In auto mode the classifier, when called, answers "allow".',
  );
  out("");
  for (const tool of TOOLS) {
    out(`### ${tool.name}${tool.isMcp ? " (MCP)" : ""}`);
    out("");
    out(row(["input", "mode", "rules", "behavior", "reason", "classifier"]));
    out(row(["---", "---", "---", "---", "---", "---"]));
    for (const { label, input } of INPUTS[tool.name]!) {
      for (const mode of MODES) {
        for (const rules of ["none", "allow", "deny"] as const) {
          resetAutoModeState();
          const settings = {
            allow: rules === "allow" ? [tool.name] : [],
            deny: rules === "deny" ? [tool.name] : [],
            mode,
          };
          out(row([label, mode, rules, ...show(await decide(tool, input, { mode, settings }))]));
        }
      }
    }
    out("");
  }

  const byName = (name: string) => {
    const tool = TOOLS.find((candidate) => candidate.name === name);
    assert.ok(tool, `tool ${name} is registered`);
    return tool;
  };
  const bash = byName("Bash");
  const write = byName("Write");
  const webFetch = byName("WebFetch");
  const read = byName("Read");

  out("## Targeted rules");
  out("");
  out(row(["case", "mode", "behavior", "reason", "classifier"]));
  out(row(["---", "---", "---", "---", "---"]));
  const targeted: Array<{
    label: string;
    tool: Tool;
    input: Record<string, unknown>;
    allow?: string[];
    deny?: string[];
    session?: PermissionRuleSet;
  }> = [
    {
      label: "Bash(npm install*) allow, npm install left-pad",
      tool: bash,
      input: { command: "npm install left-pad" },
      allow: ["Bash(npm install*)"],
    },
    {
      label: "Bash(npm install*) allow, npm install x && rm -rf build",
      tool: bash,
      input: { command: "npm install x && rm -rf build" },
      allow: ["Bash(npm install*)"],
    },
    {
      label: "Bash(git push*) deny, git push origin main",
      tool: bash,
      input: { command: "git push origin main" },
      deny: ["Bash(git push*)"],
    },
    {
      label: "Bash(git status*) deny, git status (read-only)",
      tool: bash,
      input: { command: "git status" },
      deny: ["Bash(git status*)"],
    },
    {
      label: "Bash(python*) allow (interpreter), python script.py",
      tool: bash,
      input: { command: "python script.py" },
      allow: ["Bash(python*)"],
    },
    {
      label: "WebFetch(domain:example.com) allow",
      tool: webFetch,
      input: { url: "https://example.com/page", prompt: "p" },
      allow: ["WebFetch(domain:example.com)"],
    },
    {
      label: "WebFetch(domain:docs.python.org) deny, preapproved host",
      tool: webFetch,
      input: { url: "https://docs.python.org/3/", prompt: "p" },
      deny: ["WebFetch(domain:docs.python.org)"],
    },
    {
      label: "Read(src/**) deny, read-only tool",
      tool: read,
      input: { file_path: file("src/app.ts") },
      deny: ["Read(src/**)"],
    },
    {
      label: "session allow Write",
      tool: write,
      input: { file_path: file("a.txt"), content: "x" },
      session: { allow: ["Write"], deny: [] },
    },
    {
      label: "session deny Bash, git status",
      tool: bash,
      input: { command: "git status" },
      session: { allow: [], deny: ["Bash"] },
    },
    {
      label: "settings allow Write, session deny Write",
      tool: write,
      input: { file_path: file("a.txt"), content: "x" },
      allow: ["Write"],
      session: { allow: [], deny: ["Write"] },
    },
  ];
  for (const item of targeted) {
    for (const mode of MODES) {
      resetAutoModeState();
      const decision = await decide(item.tool, item.input, {
        mode,
        settings: { allow: item.allow ?? [], deny: item.deny ?? [], mode },
        ...(item.session ? { sessionRules: item.session } : {}),
      });
      out(row([item.label, mode, ...show(decision)]));
    }
  }
  out("");

  out("## Auto Mode classifier outcomes (Write to a workspace file, no rules)");
  out("");
  out(row(["case", "behavior", "reason", "classifier"]));
  out(row(["---", "---", "---", "---"]));
  const writeInput = { file_path: file("a.txt"), content: "x" };
  const autoSettings = { allow: [], deny: [], mode: "auto" as const };
  resetAutoModeState();
  out(row(["verdict allow", ...show(await decide(write, writeInput, { mode: "auto", settings: autoSettings }))]));
  resetAutoModeState();
  out(
    row([
      "verdict block",
      ...show(await decide(write, writeInput, { mode: "auto", settings: autoSettings, verdicts: [CLASSIFIER_BLOCK] })),
    ]),
  );
  resetAutoModeState();
  out(
    row([
      "no structured verdict",
      ...show(
        await decide(write, writeInput, {
          mode: "auto",
          settings: autoSettings,
          verdicts: [{ kind: "text", text: "looks fine" } as never],
        }),
      ),
    ]),
  );
  resetAutoModeState();
  for (let i = 1; i <= 4; i++) {
    out(
      row([
        `block #${i} in a row`,
        ...show(
          await decide(write, writeInput, { mode: "auto", settings: autoSettings, verdicts: [CLASSIFIER_BLOCK] }),
        ),
      ]),
    );
  }
  resetAutoModeState();
  for (let i = 0; i < 3; i++) recordClassifierFailure();
  out(
    row([
      "after 3 classifier failures",
      ...show(await decide(write, writeInput, { mode: "auto", settings: autoSettings })),
    ]),
  );
  resetAutoModeState();
  out("");

  out("## Rules loaded from settings files");
  out("");
  out(
    'User settings are empty; project settings are `{"allow": ["Write"], "deny": ["Edit"], "mode": "auto"}`. The mode argument is omitted, so the mode comes from settings.',
  );
  out("");
  out(row(["workspace", "tool", "behavior", "reason", "classifier"]));
  out(row(["---", "---", "---", "---", "---"]));
  await writeFile(
    path.join(cwd, ".easy-agent", "settings.json"),
    JSON.stringify({ allow: ["Write"], deny: ["Edit"], mode: "auto" }),
  );
  const edit = byName("Edit");
  const editInput = { file_path: file("a.txt"), old_string: "a", new_string: "b" };
  for (const trusted of [false, true]) {
    if (trusted) await trustProjectForSession(cwd);
    for (const [tool, input] of [
      [write, writeInput],
      [edit, editInput],
    ] as const) {
      resetAutoModeState();
      out(row([trusted ? "trusted" : "untrusted", tool.name, ...show(await decide(tool, input, {}))]));
    }
  }
  out("");

  return lines.join("\n");
}

/** Sandbox auto-allow depends on this machine; assert both outcomes instead of recording one. */
async function checkSandboxRows(): Promise<number> {
  await writeFile(
    path.join(home, ".easy-agent", "settings.json"),
    JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true } }),
  );
  const bash = TOOLS.find((tool) => tool.name === "Bash")!;
  const capability = getSandboxCapability();
  const settings = { allow: [], deny: ["Bash(git push*)"], mode: "default" as const };
  const cases: Array<{ command: string; available: string; unavailable: string }> = [
    { command: "npm install left-pad", available: "allow", unavailable: "ask" },
    { command: "git push origin main", available: "deny", unavailable: "deny" },
    { command: "git status", available: "allow", unavailable: "allow" },
  ];
  for (const item of cases) {
    const decision = await decide(bash, { command: item.command }, { mode: "default", settings });
    const expected = capability.available ? item.available : item.unavailable;
    assert.equal(
      decision.behavior,
      expected,
      `sandbox ${capability.available ? "available" : "unavailable"}: ${item.command} → ${decision.behavior} (${decision.reason})`,
    );
  }
  await writeFile(path.join(home, ".easy-agent", "settings.json"), "{}");
  return cases.length;
}

async function main(): Promise<void> {
  const update = process.argv.includes("--update");
  const recording = `${await buildRecording()}\n`;
  const sandboxRows = await checkSandboxRows();

  await mkdir(path.dirname(GOLDEN_PATH), { recursive: true });
  if (update) {
    await writeFile(GOLDEN_PATH, recording, "utf8");
    console.log(`[updated] ${path.basename(GOLDEN_PATH)}`);
    return;
  }
  const golden = (await readFile(GOLDEN_PATH, "utf8").catch(() => "")).replace(/\r\n?/g, "\n");
  if (!golden) throw new Error(`no golden at ${GOLDEN_PATH}; run with --update from known-good code`);
  if (recording === golden) {
    const rows = recording.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| ---")).length;
    console.log(`[pass] permission decisions match golden (${rows} rows; ${sandboxRows} sandbox rows asserted)`);
    return;
  }
  const actual = recording.split("\n");
  const expected = golden.split("\n");
  const changed = actual
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) => line !== expected[index])
    .slice(0, 10);
  console.error("[fail] permission decisions diverged from golden:");
  for (const { line, index } of changed) {
    console.error(`  line ${index + 1}\n    golden: ${expected[index] ?? "(none)"}\n    actual: ${line}`);
  }
  console.error("If the change is intentional, re-run with --update and explain each changed row in the PR.");
  assert.equal(recording, golden, "permission decision characterization mismatch");
}

try {
  await main();
} finally {
  await fixture.close();
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
