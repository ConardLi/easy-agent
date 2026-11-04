/**
 * An Agent's compaction settings (`compaction.*`), feature switches
 * (`features.*`, `session.checkpoints`), and skill and sub-agent selection
 * (`skills.include`/`exclude`, `agents.include`/`exclude`).
 *
 * Feature switches, against the fixture model: each switch set in the
 * Agent's spec has the same effect as the environment variable or setting
 * that already controls it (the same request reaches the model, or the same
 * value reaches the code that reads it), and with both set the one the
 * resolution order puts higher wins. `features.tasks` picks the task tools a
 * session starts with, and `features.autoModeClassifier` off makes Auto Mode
 * ask instead of calling the classifier.
 *
 * Compaction: the threshold from `autoThreshold`, `keepRecentMessages` in
 * both clearing and summarizing, `microcompact` off, and `auto` off keeping
 * the conversation whole at the threshold and after a prompt-too-long error.
 *
 * Skills and sub-agents: user, project, and plugin skills and sub-agents the
 * Agent leaves out are not listed to the model, a call to one is refused with
 * the reason, `/skills`, `/agents`, `/harness`, and the inventory show them as
 * left out, names that match nothing are reported at startup, and without a
 * selection everything stays.
 *
 * Run: node --import tsx src/scripts/test-harness-features.ts
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "easy-agent-harness-features-")));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
const pluginDir = path.join(root, "docs-plugin");
await Promise.all([
  mkdir(path.join(home, ".easy-agent", "skills", "alpha-skill"), { recursive: true }),
  mkdir(path.join(cwd, ".easy-agent", "skills", "beta-skill"), { recursive: true }),
  mkdir(path.join(cwd, ".easy-agent", "agents"), { recursive: true }),
  mkdir(path.join(pluginDir, ".easy-agent-plugin"), { recursive: true }),
  mkdir(path.join(pluginDir, "skills", "gamma-skill"), { recursive: true }),
  mkdir(path.join(pluginDir, "agents"), { recursive: true }),
]);
const FEATURE_ENV = [
  "EASY_AGENT_TEAMS",
  "EASY_AGENT_ENABLE_TOOL_SEARCH",
  "ENABLE_TOOL_SEARCH",
  "MAX_THINKING_TOKENS",
  "CLAUDE_CODE_DISABLE_THINKING",
  "CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING",
  "DISABLE_INTERLEAVED_THINKING",
  "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT",
  "EASY_AGENT_DISABLE_PROMPT_CACHING",
  "EASY_AGENT_DISABLE_EXPERIMENTAL_BETAS",
  "EASY_AGENT_MAX_RETRIES",
  "EASY_AGENT_DISABLE_CHECKPOINTING",
] as const;
for (const key of Object.keys(process.env)) {
  if (
    /^(?:ANTHROPIC_|EASY_AGENT_|CLAUDE_CODE_)/.test(key) ||
    /TOOL_SEARCH|THINKING|WEB_SEARCH/.test(key) ||
    (FEATURE_ENV as readonly string[]).includes(key)
  ) {
    delete process.env[key];
  }
}
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.EASY_AGENT_DISABLE_HOOKS = "1";
process.chdir(cwd);

const { createAnthropicFixture, FIXTURE_MODEL } = await import("./fixtures/anthropicFixture.js");
type ScriptStep = import("./fixtures/anthropicFixture.js").ScriptStep;
type RecordedRequest = import("./fixtures/anthropicFixture.js").RecordedRequest;
const fixture = createAnthropicFixture();
await fixture.start();
process.env.ANTHROPIC_MODEL = FIXTURE_MODEL;

const { resolveHarnessFromInputs } = await import("../harness/resolve.js");
const { installHarness, uninstallHarness } = await import("../harness/active.js");
const { getAutoCompactThreshold, getBlockingLimit, getEffectiveContextWindowSize } = await import("../utils/tokens.js");
const { compactMessages, microCompactMessages, OLD_TOOL_RESULT_PLACEHOLDER } = await import("../context/compaction.js");
const { shouldAutoCompact } = await import("../context/autoCompact.js");
const { getMaxRetries } = await import("../services/api/withRetry.js");
const { resetSettingsCache } = await import("../config/sources.js");
const { createAgentRuntime } = await import("../sdk/index.js");
type AgentRuntime = Awaited<ReturnType<typeof createAgentRuntime>>;
type AgentSessionOptions = import("../sdk/types.js").AgentSessionOptions;
type MessageParam = import("@anthropic-ai/sdk/resources/messages.js").MessageParam;

const userSettings = path.join(home, ".easy-agent", "settings.json");
const projectSettings = path.join(cwd, ".easy-agent", "settings.json");
const writeJson = (file: string, value: unknown) => writeFile(file, JSON.stringify(value, null, 2));

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const resolveSpec = (spec: Record<string, unknown>) =>
  resolveHarnessFromInputs({
    layers: [{ source: "user", path: null, raw: { harnesses: { a: spec } } }],
    workspaceTrusted: true,
    env: {},
    name: "a",
  });

/** Run `fn` with `spec` installed as the active Agent. */
async function withSpec<T>(spec: Record<string, unknown>, fn: () => Promise<T> | T): Promise<T> {
  const resolved = resolveSpec(spec);
  assert.deepEqual(
    resolved.issues.filter((issue) => issue.level === "error"),
    [],
  );
  installHarness(resolved);
  try {
    return await fn();
  } finally {
    uninstallHarness();
  }
}

// ─── Runtime helpers ───────────────────────────────────────────────────

interface RunOptions {
  /** Spec of the Agent the runtime selects; none runs `default`. */
  spec?: Record<string, unknown>;
  /** Environment variables set while the runtime starts. */
  env?: Partial<Record<(typeof FEATURE_ENV)[number], string>>;
  /** Top-level user settings next to the Agent definition. */
  user?: Record<string, unknown>;
  project?: Record<string, unknown>;
  script?: ScriptStep[];
  prompt?: string;
  session?: AgentSessionOptions;
  pluginDirs?: string[];
}

interface RunResult {
  requests: RecordedRequest[];
  outputs: string[];
  warnings: string[];
  permissionAsks: number;
  checkpointFiles: boolean | undefined;
  taskMode: string;
  maxRetries: number;
}

async function startRuntime(options: RunOptions, warnings: string[]): Promise<AgentRuntime> {
  await writeJson(userSettings, { ...options.user, harnesses: { probe: options.spec ?? {} } });
  await writeJson(projectSettings, options.project ?? {});
  resetSettingsCache();
  for (const name of FEATURE_ENV) delete process.env[name];
  for (const [name, value] of Object.entries(options.env ?? {})) process.env[name] = value;
  try {
    return await createAgentRuntime({
      cwd,
      trust: "session",
      services: false,
      logger: { warn: (message) => warnings.push(message), error() {} },
      ...(options.pluginDirs ? { pluginDirs: options.pluginDirs } : {}),
      ...(options.spec ? { harness: { name: "probe" } } : {}),
    });
  } finally {
    // The runtime took its environment snapshot; nothing else should see these.
    for (const name of FEATURE_ENV) delete process.env[name];
  }
}

async function run(options: RunOptions): Promise<RunResult> {
  const warnings: string[] = [];
  const runtime = await startRuntime(options, warnings);
  let permissionAsks = 0;
  try {
    const session = await runtime.createSession({
      persist: false,
      ...options.session,
      handlers: {
        permission: () => {
          permissionAsks += 1;
          return { decision: "allow_once" };
        },
      },
    });
    const outputs: string[] = [];
    session.subscribe((event) => {
      if (event.type === "command_output") outputs.push(event.message);
    });
    fixture.requests.length = 0;
    fixture.script(options.script ?? [{ kind: "text", text: "ok" }]);
    await session.send(options.prompt ?? "hello");
    const requests = [...fixture.requests];
    const result: RunResult = {
      requests,
      outputs,
      warnings,
      permissionAsks,
      checkpointFiles: session.listCheckpoints()[0]?.files,
      taskMode: session.getState().taskMode,
      maxRetries: getMaxRetries(),
    };
    await session.close();
    return result;
  } finally {
    await runtime.dispose();
  }
}

/** What reached the model in one request: the body and the beta header. */
function sent(request: RecordedRequest | undefined): unknown {
  assert.ok(request, "a request was sent");
  const { metadata: _metadata, ...body } = request.body;
  return { body, beta: request.headers["anthropic-beta"] ?? null };
}

const toolNames = (request: RecordedRequest | undefined) =>
  ((request?.body.tools as { name: string }[] | undefined) ?? []).map((tool) => tool.name);
const offered = (request: RecordedRequest | undefined) =>
  `${toolNames(request).join(" ")} ${JSON.stringify(request?.body.messages ?? [])}`;
const systemText = (request: RecordedRequest | undefined) => JSON.stringify(request?.system ?? "");
const toolResultText = (request: RecordedRequest | undefined) =>
  JSON.stringify((request?.body.messages as unknown[] | undefined)?.at(-1) ?? "");
const isSummaryRequest = (request: RecordedRequest) =>
  systemText(request).includes("Your task is to create a detailed summary");
const isClassifierRequest = (request: RecordedRequest) => toolNames(request).includes("classify_result");

/**
 * The same effect from the spec and from the environment (or settings), a
 * different one from neither, and the higher layer winning when both are set.
 */
async function sameEffect<T>(
  label: string,
  observe: (result: RunResult) => T,
  cases: { spec: RunOptions; other: RunOptions; both?: { options: RunOptions; expect: T }; base?: RunOptions },
): Promise<void> {
  const [fromSpec, fromOther, plain] = [
    observe(await run(cases.spec)),
    observe(await run(cases.other)),
    observe(await run(cases.base ?? {})),
  ];
  assert.deepEqual(fromSpec, fromOther, `${label}: the spec and the environment have the same effect`);
  assert.notDeepEqual(fromSpec, plain, `${label}: the switch changes something`);
  if (cases.both) {
    assert.deepEqual(observe(await run(cases.both.options)), cases.both.expect, `${label}: resolution order`);
  }
}

const first = (result: RunResult) => sent(result.requests[0]);

try {
  // ─── Feature switches ───────────────────────────────────────────────

  console.log("Feature switches: the spec and the environment have the same effect");

  await check("features.agentTeams and EASY_AGENT_TEAMS offer the team tools; the variable wins", async () => {
    const teams = (result: RunResult) => /\bTeamCreate\b/.test(offered(result.requests[0]));
    await sameEffect("agentTeams", first, {
      spec: { spec: { features: { agentTeams: true } } },
      other: { env: { EASY_AGENT_TEAMS: "1" } },
    });
    assert.equal(teams(await run({ spec: { features: { agentTeams: true } } })), true);
    assert.equal(
      teams(await run({ spec: { features: { agentTeams: false } }, env: { EASY_AGENT_TEAMS: "1" } })),
      true,
      "the variable sits above the Agent's spec",
    );
  });

  await check("features.toolSearch and EASY_AGENT_ENABLE_TOOL_SEARCH; the variable wins", async () => {
    // The fixture is a custom endpoint, where ToolSearch is used only when a layer turns it on.
    await sameEffect("toolSearch", first, {
      spec: { spec: { features: { toolSearch: "on" } } },
      other: { env: { EASY_AGENT_ENABLE_TOOL_SEARCH: "true" } },
      both: {
        options: { spec: { features: { toolSearch: "on" } }, env: { EASY_AGENT_ENABLE_TOOL_SEARCH: "false" } },
        expect: first(await run({ env: { EASY_AGENT_ENABLE_TOOL_SEARCH: "false" } })),
      },
    });
    assert.ok(toolNames((await run({ spec: { features: { toolSearch: "on" } } })).requests[0]).includes("ToolSearch"));
    assert.ok(
      !toolNames((await run({ spec: { features: { toolSearch: "off" } } })).requests[0]).includes("ToolSearch"),
    );
  });

  await check("features.thinking and MAX_THINKING_TOKENS=0 leave thinking out; the variable wins", async () => {
    const thinking = (result: RunResult) => result.requests[0]?.body.thinking ?? null;
    await sameEffect("thinking", first, {
      spec: { spec: { features: { thinking: false } } },
      other: { env: { MAX_THINKING_TOKENS: "0" } },
      both: {
        options: {
          spec: { features: { thinking: false, adaptiveThinking: false } },
          env: { MAX_THINKING_TOKENS: "4096" },
        },
        expect: first(await run({ env: { MAX_THINKING_TOKENS: "4096", CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1" } })),
      },
    });
    assert.equal(thinking(await run({ spec: { features: { thinking: false } } })), null);
  });

  await check("features.thinkingBudget and adaptiveThinking match MAX_THINKING_TOKENS and its switch", async () => {
    await sameEffect("thinkingBudget", first, {
      spec: { spec: { features: { thinkingBudget: 2048, adaptiveThinking: false } } },
      other: { env: { MAX_THINKING_TOKENS: "2048", CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1" } },
    });
    const result = await run({ spec: { features: { thinkingBudget: 2048, adaptiveThinking: false } } });
    assert.deepEqual(result.requests[0]?.body.thinking, { type: "enabled", budget_tokens: 2048 });
  });

  await check("features.thinkingInRequests and CLAUDE_CODE_DISABLE_THINKING; the variable wins", async () => {
    await sameEffect("thinkingInRequests", first, {
      spec: { spec: { features: { thinkingInRequests: false } } },
      other: { env: { CLAUDE_CODE_DISABLE_THINKING: "1" } },
      both: {
        options: { spec: { features: { thinkingInRequests: true } }, env: { CLAUDE_CODE_DISABLE_THINKING: "1" } },
        expect: first(await run({ env: { CLAUDE_CODE_DISABLE_THINKING: "1" } })),
      },
    });
  });

  await check("features.interleavedThinking and DISABLE_INTERLEAVED_THINKING drop the beta header", async () => {
    // Without adaptive thinking, so the request carries a thinking budget and the header applies.
    await sameEffect("interleavedThinking", first, {
      spec: { spec: { features: { interleavedThinking: false, adaptiveThinking: false } } },
      other: { env: { DISABLE_INTERLEAVED_THINKING: "1", CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1" } },
    });
  });

  await check("features.effortForAllModels and CLAUDE_CODE_ALWAYS_ENABLE_EFFORT send effort to any model", async () => {
    const legacy = { model: { main: "claude-sonnet-4-5" }, features: { effort: "high" } };
    const effort = (result: RunResult) => result.requests[0]?.body.output_config ?? null;
    assert.equal(effort(await run({ spec: legacy })), null, "this model does not take effort by default");
    const fromSpec = await run({ spec: { ...legacy, features: { ...legacy.features, effortForAllModels: true } } });
    const fromEnv = await run({ spec: legacy, env: { CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "1" } });
    assert.deepEqual(effort(fromSpec), { effort: "high" });
    assert.deepEqual(first(fromSpec), first(fromEnv));
  });

  await check("features.effort matches effortLevel; the spec is above user and below project settings", async () => {
    const effort = (result: RunResult) => (result.requests[0]?.body.output_config as { effort?: string })?.effort;
    await sameEffect("effort", first, {
      spec: { spec: { features: { effort: "low" } } },
      other: { user: { effortLevel: "low" } },
    });
    assert.equal(effort(await run({ spec: { features: { effort: "low" } }, user: { effortLevel: "high" } })), "low");
    assert.equal(
      effort(await run({ spec: { features: { effort: "low" } }, project: { effortLevel: "max" } })),
      "max",
      "a trusted project setting overrides the Agent",
    );
  });

  await check("features.promptCaching and EASY_AGENT_DISABLE_PROMPT_CACHING; the variable wins", async () => {
    await sameEffect("promptCaching", first, {
      spec: { spec: { features: { promptCaching: false } } },
      other: { env: { EASY_AGENT_DISABLE_PROMPT_CACHING: "1" } },
      both: {
        options: { spec: { features: { promptCaching: true } }, env: { EASY_AGENT_DISABLE_PROMPT_CACHING: "1" } },
        expect: first(await run({ env: { EASY_AGENT_DISABLE_PROMPT_CACHING: "1" } })),
      },
    });
    const body = JSON.stringify((await run({ spec: { features: { promptCaching: false } } })).requests[0]?.body);
    assert.ok(!body.includes("cache_control"), "no cache markers");
  });

  await check("features.maxRetries and EASY_AGENT_MAX_RETRIES set the retry count; the variable wins", async () => {
    await sameEffect("maxRetries", (result) => result.maxRetries, {
      spec: { spec: { features: { maxRetries: 2 } } },
      other: { env: { EASY_AGENT_MAX_RETRIES: "2" } },
      both: { options: { spec: { features: { maxRetries: 2 } }, env: { EASY_AGENT_MAX_RETRIES: "5" } }, expect: 5 },
    });
  });

  await check("features.maxTurns matches the maxTurns setting; a project setting overrides the Agent", async () => {
    const script: ScriptStep[] = [
      { kind: "tool", name: "Glob", input: { pattern: "*.md" } },
      { kind: "tool", name: "Glob", input: { pattern: "*.ts" } },
      { kind: "tool", name: "Glob", input: { pattern: "*.js" } },
      { kind: "text", text: "done" },
    ];
    const requests = (result: RunResult) => result.requests.length;
    await sameEffect("maxTurns", requests, {
      spec: { spec: { features: { maxTurns: 1 } }, script },
      other: { user: { maxTurns: 1 }, script },
      both: { options: { spec: { features: { maxTurns: 1 } }, project: { maxTurns: 2 }, script }, expect: 2 },
      base: { script },
    });
    assert.equal(requests(await run({ spec: { features: { maxTurns: 1 } }, script })), 1);
  });

  await check("session.checkpoints and EASY_AGENT_DISABLE_CHECKPOINTING; the variable wins", async () => {
    const target = path.join(cwd, "checkpointed.txt");
    const script: ScriptStep[] = [
      { kind: "tool", name: "Write", input: { file_path: target, content: "x" } },
      { kind: "text", text: "written" },
    ];
    const files = (result: RunResult) => result.checkpointFiles;
    const options = (extra: RunOptions): RunOptions => ({ ...extra, script, session: { persist: true } });
    try {
      await sameEffect("checkpoints", files, {
        spec: options({ spec: { session: { checkpoints: false } } }),
        other: options({ env: { EASY_AGENT_DISABLE_CHECKPOINTING: "1" } }),
        both: {
          options: options({
            spec: { session: { checkpoints: true } },
            env: { EASY_AGENT_DISABLE_CHECKPOINTING: "1" },
          }),
          expect: false,
        },
        base: options({}),
      });
    } finally {
      await rm(target, { force: true });
    }
  });

  console.log("Switches only an Agent sets");

  await check("features.tasks picks the task tools a session starts with; /tasks still switches", async () => {
    const todo = await run({ spec: { features: { tasks: "todo" } } });
    assert.equal(todo.taskMode, "todo");
    assert.match(offered(todo.requests[0]), /\bTodoWrite\b/);
    assert.doesNotMatch(offered(todo.requests[0]), /\bTaskCreate\b/);
    const plain = await run({});
    assert.equal(plain.taskMode, "task");
    assert.match(offered(plain.requests[0]), /\bTaskCreate\b/);
    assert.doesNotMatch(offered(plain.requests[0]), /\bTodoWrite\b/);

    const switched = await run({ spec: { features: { tasks: "todo" } }, prompt: "/tasks" });
    assert.match(switched.outputs[0] ?? "", /\/tasks todo +Use a session-only todo list \(default\)/);
    const runtime = await startRuntime({ spec: { features: { tasks: "todo" } } }, []);
    try {
      const session = await runtime.createSession({ persist: false });
      await session.runCommand("tasks", ["task"]);
      assert.equal(session.getState().taskMode, "task");
      await session.close();
    } finally {
      await runtime.dispose();
    }
  });

  await check("features.autoModeClassifier off: Auto Mode asks instead of calling the classifier", async () => {
    const target = path.join(cwd, "auto.txt");
    const write: ScriptStep = { kind: "tool", name: "Write", input: { file_path: target, content: "x" } };
    try {
      const off = await run({
        spec: { features: { autoModeClassifier: false } },
        session: { permissionMode: "auto" },
        script: [write, { kind: "text", text: "done" }],
      });
      assert.equal(off.permissionAsks, 1, "the user decides");
      assert.ok(!off.requests.some(isClassifierRequest), "no classifier request");

      const on = await run({
        session: { permissionMode: "auto" },
        script: [
          write,
          { kind: "tool", name: "classify_result", input: { thinking: "", shouldBlock: false, reason: "safe" } },
          { kind: "text", text: "done" },
        ],
      });
      assert.equal(on.permissionAsks, 0, "the classifier decides");
      assert.ok(on.requests.some(isClassifierRequest), "the classifier was asked");

      const readOnly = await run({
        spec: { features: { autoModeClassifier: false } },
        session: { permissionMode: "auto" },
        script: [
          { kind: "tool", name: "Glob", input: { pattern: "*" } },
          { kind: "text", text: "done" },
        ],
      });
      assert.equal(readOnly.permissionAsks, 0, "rules and the read-only fast path still decide");
    } finally {
      await rm(target, { force: true });
    }
  });

  // ─── Compaction ─────────────────────────────────────────────────────

  console.log("Compaction");

  const toolTurns = (count: number): MessageParam[] =>
    Array.from({ length: count }, (_, index): MessageParam => {
      const id = `toolu_${Math.floor(index / 2)}`;
      return index % 2 === 0
        ? { role: "assistant", content: [{ type: "tool_use", id, name: "Read", input: { file_path: "a.txt" } }] }
        : { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `Read: line ${index}` }] };
    });
  const textTurns = (count: number): MessageParam[] =>
    Array.from({ length: count }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `message ${index}`,
    }));
  const cleared = (messages: MessageParam[]) =>
    messages.filter((message) => JSON.stringify(message.content).includes(OLD_TOOL_RESULT_PLACEHOLDER)).length;

  await check("autoThreshold sets where auto-compaction starts, never past the blocking limit", async () => {
    const window = { compaction: { contextWindow: 100_000 } };
    await withSpec(window, () => {
      assert.equal(getEffectiveContextWindowSize(FIXTURE_MODEL), 80_000);
      assert.equal(getAutoCompactThreshold(FIXTURE_MODEL), 80_000 - Math.round(13_000 * (80_000 / 180_000)));
    });
    await withSpec({ compaction: { contextWindow: 100_000, autoThreshold: 0.5 } }, () => {
      assert.equal(getAutoCompactThreshold(FIXTURE_MODEL), 40_000);
      assert.equal(shouldAutoCompact(39_999, FIXTURE_MODEL), false);
      assert.equal(shouldAutoCompact(40_000, FIXTURE_MODEL), true);
    });
    await withSpec({ compaction: { contextWindow: 100_000, autoThreshold: 1 } }, () => {
      assert.equal(getAutoCompactThreshold(FIXTURE_MODEL), getBlockingLimit(FIXTURE_MODEL));
    });
    await withSpec({ compaction: { contextWindow: 100_000, autoThreshold: 0.5, auto: false } }, () => {
      assert.equal(shouldAutoCompact(90_000, FIXTURE_MODEL), false, "auto off never triggers");
    });
  });

  await check("keepRecentMessages sets the messages clearing and summarizing keep", async () => {
    const history = toolTurns(16);
    assert.equal(cleared(microCompactMessages(history).messages), 4, "by default the last 8 keep their results");
    await withSpec({ compaction: { keepRecentMessages: 4 } }, async () => {
      assert.equal(cleared(microCompactMessages(history).messages), 6, "the last 4 keep their results");
      fixture.script([{ kind: "text", text: "<summary>earlier</summary>" }]);
      const summarized = await compactMessages(textTurns(12), undefined, { force: true, model: FIXTURE_MODEL });
      assert.equal(summarized.didCompact, true);
      assert.deepEqual(
        summarized.messages.slice(2).map((message) => message.content),
        ["message 8", "message 9", "message 10", "message 11"],
        "the summary keeps the last 4 messages",
      );
    });
  });

  await check("microcompact off keeps old tool results", async () => {
    await withSpec({ compaction: { microcompact: false } }, async () => {
      const history = toolTurns(16);
      const result = await compactMessages(history, undefined, { model: FIXTURE_MODEL });
      assert.equal(result.didMicroCompact, false);
      assert.equal(result.messages, history);
    });
  });

  await check("auto off: no summary at the threshold or after a prompt-too-long error", async () => {
    // A tiny threshold puts the second turn over it: the system prompt alone is larger.
    const small = { contextWindow: 20_000, autoThreshold: 0.01 };
    const twoTurns = async (compaction: Record<string, unknown>) => {
      const runtime = await startRuntime({ spec: { compaction } }, []);
      try {
        const session = await runtime.createSession({ persist: false });
        fixture.requests.length = 0;
        fixture.script([
          { kind: "text", text: "one" },
          { kind: "text", text: "<summary>earlier</summary>" },
          { kind: "text", text: "two" },
        ]);
        await session.send("first");
        await session.send("second");
        await session.close();
        return fixture.requests.filter(isSummaryRequest).length;
      } finally {
        await runtime.dispose();
      }
    };
    assert.ok((await twoTurns(small)) > 0, "with auto on, the second turn compacts");
    assert.equal(await twoTurns({ ...small, auto: false }), 0, "with auto off, it does not");

    const tooLong: ScriptStep = { kind: "error", status: 400, message: "prompt is too long: 300000 tokens > 200000" };
    const recovered = await run({
      script: [tooLong, { kind: "text", text: "<summary>earlier</summary>" }, { kind: "text", text: "answer" }],
    });
    assert.equal(recovered.requests.filter(isSummaryRequest).length, 1, "with auto on, the error is compacted away");
    const surfaced = await run({
      spec: { compaction: { auto: false } },
      script: [tooLong, { kind: "text", text: "<summary>earlier</summary>" }, { kind: "text", text: "answer" }],
    });
    assert.equal(surfaced.requests.length, 1, "with auto off, the error ends the turn");
    assert.ok(!surfaced.requests.some(isSummaryRequest));

    await withSpec({ compaction: { auto: false } }, async () => {
      const result = await compactMessages(textTurns(12), undefined, { model: FIXTURE_MODEL, force: true });
      assert.equal(result.didCompact, true, "/compact still summarizes when asked");
    });
  });

  // ─── Skills and sub-agents ──────────────────────────────────────────

  console.log("Skills and sub-agents");

  const skill = (name: string) =>
    ["---", `name: ${name}`, `description: The ${name} instructions`, "---", `Follow ${name}.`].join("\n");
  const agent = (name: string) =>
    ["---", `name: ${name}`, `description: The ${name} helper`, "tools: Read", "---", `You are ${name}.`].join("\n");
  await Promise.all([
    writeFile(path.join(home, ".easy-agent", "skills", "alpha-skill", "SKILL.md"), skill("alpha-skill")),
    writeFile(path.join(cwd, ".easy-agent", "skills", "beta-skill", "SKILL.md"), skill("beta-skill")),
    writeFile(path.join(pluginDir, "skills", "gamma-skill", "SKILL.md"), skill("gamma-skill")),
    writeFile(path.join(cwd, ".easy-agent", "agents", "writer-agent.md"), agent("writer-agent")),
    writeFile(path.join(pluginDir, "agents", "helper-agent.md"), agent("helper-agent")),
    writeJson(path.join(pluginDir, ".easy-agent-plugin", "plugin.json"), { name: "docs" }),
  ]);
  const focused = {
    skills: { exclude: ["beta-skill", "docs:*", "ghost-skill"] },
    agents: { include: ["Explore", "writer-agent", "ghost-agent"] },
  };
  /** A `- name:` (skill) or `- name [source]:` (sub-agent) listing line in the system prompt. */
  const listed = (request: RecordedRequest | undefined, name: string) =>
    new RegExp(`- ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: \\[[a-z-]+\\])?:`).test(systemText(request));

  await check("left-out skills and sub-agents are not listed to the model; the kept ones are", async () => {
    const result = await run({ spec: focused, pluginDirs: [pluginDir] });
    const request = result.requests[0];
    assert.ok(listed(request, "alpha-skill"), "a user skill the Agent keeps");
    assert.ok(!listed(request, "beta-skill"), "a project skill it leaves out");
    assert.ok(!listed(request, "docs:gamma-skill"), "a plugin skill it leaves out");
    assert.ok(listed(request, "Explore") && listed(request, "writer-agent"), "the included sub-agents");
    assert.ok(!listed(request, "general-purpose"), "a built-in sub-agent not in the include list");
    assert.ok(!listed(request, "docs:helper-agent"), "a plugin sub-agent not in the include list");
    assert.ok(
      result.warnings.some((message) =>
        /skills\.include and skills\.exclude name no loaded skill: ghost-skill$/.test(message),
      ),
      "unmatched skill names are reported",
    );
    assert.ok(
      result.warnings.some((message) =>
        /agents\.include and agents\.exclude name no loaded sub-agent: ghost-agent$/.test(message),
      ),
      "unmatched sub-agent names are reported",
    );

    const plain = await run({ pluginDirs: [pluginDir] });
    for (const name of ["alpha-skill", "beta-skill", "docs:gamma-skill", "general-purpose", "docs:helper-agent"]) {
      assert.ok(listed(plain.requests[0], name), `without a selection ${name} is listed`);
    }
  });

  await check("a call to a left-out skill or sub-agent is refused with the reason", async () => {
    const skillCall = await run({
      spec: focused,
      pluginDirs: [pluginDir],
      script: [
        { kind: "tool", name: "Skill", input: { skill: "beta-skill" } },
        { kind: "text", text: "done" },
      ],
    });
    assert.match(
      toolResultText(skillCall.requests[1]),
      /skill \\"beta-skill\\" is turned off for this Agent\. Left out by skills\.exclude \(Agent \\"probe\\"\)/,
    );
    const agentCall = await run({
      spec: focused,
      pluginDirs: [pluginDir],
      script: [
        {
          kind: "tool",
          name: "Agent",
          input: { description: "help", prompt: "help", subagent_type: "general-purpose" },
        },
        { kind: "text", text: "done" },
      ],
    });
    assert.match(
      toolResultText(agentCall.requests[1]),
      /sub-agent type 'general-purpose' is turned off for this Agent\. Not in agents\.include \(Agent \\"probe\\"\)/,
    );
    const slash = await run({ spec: focused, pluginDirs: [pluginDir], prompt: "/beta-skill" });
    assert.equal(slash.requests.length, 0, "the skill does not run");
    assert.match(
      slash.outputs[0] ?? "",
      /Skill \/beta-skill is turned off for this Agent\. Left out by skills\.exclude/,
    );
  });

  await check("/skills, /agents, /harness, and the inventory show what the Agent leaves out", async () => {
    const runtime = await startRuntime({ spec: focused, pluginDirs: [pluginDir] }, []);
    try {
      const inventory = await runtime.getInventory();
      const beta = inventory.skills.find((item) => item.name === "beta-skill");
      assert.equal(beta?.enabled, false);
      assert.equal(beta?.reason, 'Left out by skills.exclude (Agent "probe").');
      assert.equal(inventory.skills.find((item) => item.name === "docs:gamma-skill")?.source, "plugin");
      assert.equal(inventory.skills.find((item) => item.name === "alpha-skill")?.enabled, true);
      const general = inventory.agents.find((item) => item.name === "general-purpose");
      assert.equal(general?.enabled, false);
      assert.equal(general?.reason, 'Not in agents.include (Agent "probe").');
      assert.equal(inventory.agents.find((item) => item.name === "writer-agent")?.enabled, true);

      const capabilities = runtime.getCapabilities();
      assert.ok(!capabilities.skills.some((item) => item.name === "beta-skill"));
      assert.ok(!capabilities.agents.includes("general-purpose"));

      const session = await runtime.createSession({ persist: false });
      const outputs: string[] = [];
      session.subscribe((event) => {
        if (event.type === "command_output") outputs.push(event.message);
      });
      await session.runCommand("skills");
      await session.runCommand("agents");
      await session.runCommand("harness");
      await session.close();
      assert.match(outputs[0] ?? "", /Skills \(1 loaded\)/);
      assert.match(
        outputs[0] ?? "",
        /Left out by this Agent: (?=.*beta-skill)(?=.*docs:gamma-skill).*\(see \/harness\)\./,
      );
      assert.match(outputs[1] ?? "", /Left out by this Agent: .*general-purpose.*\(see \/harness\)\./);
      assert.match(
        outputs[2] ?? "",
        /\nLeft out\n {2}skill +.*beta-skill \(Left out by skills\.exclude \(Agent "probe"\)\.\)/,
      );
      assert.match(outputs[2] ?? "", /\n {2}agent +.*general-purpose \(Not in agents\.include/);
    } finally {
      await runtime.dispose();
    }
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await fixture.close();
  process.chdir(os.tmpdir());
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}

if (process.exitCode === 1) {
  console.error("\nHarness features: failed.");
  process.exit(1);
}
console.log(`\nHarness features: ${passed} passed, 0 failed.`);
process.exit(0);
