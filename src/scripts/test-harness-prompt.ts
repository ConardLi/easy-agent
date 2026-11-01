/**
 * An Agent's prompt and context settings: `prompt.identity`,
 * `prompt.sections`, and `context.*`.
 *
 * Rules: section arrangement (off, replaced, added, moved with `after`,
 * `instructions` as the top, unknown targets and cycles keeping their place),
 * the startup problems, and the component list with reasons.
 *
 * Prompt: the identity replaces the built-in text and an empty one leaves it
 * out; each context source turns off on its own, git without the rest of the
 * environment; a turned-off or replaced section does not read its source;
 * without an Agent the prompt is the built-in one.
 *
 * Runtime, against the fixture model: an edit to the Agent's sections reaches
 * the model as a context update and an identity edit rebuilds the prompt;
 * `/context` and the inventory leave out what the Agent does not load;
 * `--dump-system-prompt --harness` prints the Agent's prompt; startup warns
 * about section problems.
 *
 * The request content golden covers the bytes sent for a replaced identity,
 * memory turned off, and an added file section.
 *
 * Run: node --import tsx src/scripts/test-harness-prompt.ts
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "easy-agent-harness-prompt-")));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
await Promise.all([
  mkdir(path.join(home, ".easy-agent", "prompts"), { recursive: true }),
  mkdir(cwd, { recursive: true }),
]);
for (const key of Object.keys(process.env)) {
  if (/^(?:ANTHROPIC_|EASY_AGENT_|CLAUDE_CODE_)/.test(key) || /TOOL_SEARCH|THINKING|WEB_SEARCH/.test(key)) {
    delete process.env[key];
  }
}
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.ANTHROPIC_AUTH_TOKEN = "test-token";
process.env.EASY_AGENT_DISABLE_HOOKS = "1";
process.chdir(cwd);

const { createAnthropicFixture, FIXTURE_MODEL } = await import("./fixtures/anthropicFixture.js");
const fixture = createAnthropicFixture();
await fixture.start();
process.env.ANTHROPIC_MODEL = FIXTURE_MODEL;

const { resolveHarnessFromInputs } = await import("../harness/resolve.js");
const { arrangePromptSections, promptSectionProblems, promptSectionOffReason } = await import("../harness/prompt.js");
const { listBuiltInComponents } = await import("../harness/components.js");
const { formatHarness } = await import("../harness/format.js");
const { buildStaticSystemParts, collectDynamicSections, getRuntimeEnvironmentContext, renderSystemPrompt } =
  await import("../context/systemPrompt.js");
const { getProjectMemoryDir } = await import("../context/memory/memdir.js");
const { resetSettingsCache } = await import("../config/sources.js");
const { CONTEXT_UPDATE_MARKER } = await import("../constants/systemPromptMarkers.js");
const { createAgentRuntime } = await import("../sdk/index.js");
type AgentRuntime = Awaited<ReturnType<typeof createAgentRuntime>>;

const userSettings = path.join(home, ".easy-agent", "settings.json");
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

const BUILT_IN = ["output_style", "language", "environment", "agent_md", "memory", "skills"].map((name) => ({
  name,
  text: name.toUpperCase(),
}));
const names = (sections: { name: string; text: string }[]) => sections.map((section) => section.name);

// ─── Rules ─────────────────────────────────────────────────────────────

console.log("Section rules");

await check("off empties a section, text replaces it, and a new section goes last", () => {
  const sections = arrangePromptSections(BUILT_IN, {
    memory: false,
    language: { text: "  Speak plainly.  " },
    extra: { text: "Extra." },
    skills: true,
  });
  assert.deepEqual(names(sections), [...names(BUILT_IN), "extra"]);
  assert.equal(sections.find((s) => s.name === "memory")?.text, "");
  assert.equal(sections.find((s) => s.name === "language")?.text, "Speak plainly.");
  assert.equal(sections.find((s) => s.name === "skills")?.text, "SKILLS");
  assert.equal(BUILT_IN[4]!.text, "MEMORY", "the input is not changed");
});

await check("after places a section behind another; instructions puts it first", () => {
  const sections = arrangePromptSections(BUILT_IN, {
    rules: { text: "Rules.", after: "agent_md" },
    skills: { after: "instructions" },
    notes: { text: "Notes.", after: "rules" },
    memory: { after: "output_style" },
  });
  assert.deepEqual(names(sections), [
    "skills",
    "output_style",
    "memory",
    "language",
    "environment",
    "agent_md",
    "rules",
    "notes",
  ]);
});

await check("an unknown target, a self reference, and a cycle keep their own place", () => {
  const sections = arrangePromptSections(BUILT_IN, {
    language: { after: "nowhere" },
    agent_md: { after: "agent_md" },
    memory: { after: "skills" },
    skills: { after: "memory" },
    ghost: { after: "language" },
    identity: { text: "ignored" },
  });
  assert.deepEqual(names(sections), names(BUILT_IN), "nothing moves and nothing is added");
});

await check("problems name static sections, unknown names and targets, and cycles", () => {
  const resolved = resolveSpec({
    prompt: {
      sections: {
        identity: false,
        ghost: false,
        rules: { text: "x", after: "nowhere" },
        memory: { after: "memory" },
        skills: { after: "agents" },
        agents: { after: "skills" },
        language: { after: "instructions" },
      },
    },
  });
  assert.deepEqual(promptSectionProblems(resolved), [
    "prompt.sections.identity: identity and instructions are static; set prompt.identity, or use an output style that leaves out the coding instructions",
    "prompt.sections.ghost names no built-in section and has no text or file",
    "prompt.sections.rules.after names no section: nowhere",
    "prompt.sections.memory.after names the section itself",
    "prompt.sections: after forms a cycle: skills → agents → skills",
  ]);
  assert.deepEqual(promptSectionProblems(resolveSpec({})), []);
});

await check("text and file together are a spec error", () => {
  const resolved = resolveSpec({ prompt: { sections: { rules: { text: "x", file: "y.md" } } } });
  assert.ok(
    resolved.issues.some((issue) => issue.level === "error" && /set text or file, not both/.test(issue.message)),
  );
});

await check("components report what is off, replaced, and added, with the reason", () => {
  const resolved = resolveSpec({
    prompt: { identity: "You review.", sections: { memory: false, rules: { text: "Rules." } } },
    context: { environment: false, gitStatus: false, skills: false },
  });
  const byId = new Map(listBuiltInComponents(resolved).map((component) => [component.id, component]));
  assert.equal(byId.get("prompt_section:identity")?.enabled, true);
  assert.equal(byId.get("prompt_section:identity")?.replacedBy, 'Text from Agent "a".');
  assert.equal(byId.get("prompt_section:memory")?.reason, 'Turned off by prompt.sections (Agent "a").');
  assert.match(byId.get("prompt_section:environment")?.reason ?? "", /context\.environment.*context\.gitStatus/);
  assert.match(byId.get("prompt_section:skills")?.reason ?? "", /Turned off by context\.skills \(Agent "a"\)/);
  assert.equal(byId.get("prompt_section:agent_md")?.enabled, true);
  assert.equal(byId.get("context_source:skills")?.enabled, false);
  assert.equal(byId.get("context_source:memory")?.enabled, true);
  const rules = byId.get("prompt_section:rules");
  assert.equal(rules?.source, "harness");
  assert.equal(rules?.enabled, true);

  const plain = listBuiltInComponents(resolveSpec({}));
  assert.ok(
    plain.filter((c) => c.kind !== "tool").every((c) => c.enabled && !c.replacedBy && c.source === "built-in"),
    "nothing is off or replaced without settings",
  );
  assert.equal(
    promptSectionOffReason(resolveSpec({ prompt: { identity: "" } }), "identity"),
    "prompt.identity is empty.",
  );

  const text = formatHarness(resolved, listBuiltInComponents(resolved));
  assert.match(text, /off: .*prompt_section:memory \(Turned off by prompt\.sections \(Agent "a"\)\.\)/);
  assert.match(
    text,
    /text: prompt_section:identity \(Text from Agent "a"\.\), prompt_section:rules \(Text from Agent "a"\.\)/,
  );
  assert.match(text, /off: context_source:environment .*context_source:skills/);
});

// ─── Prompt ────────────────────────────────────────────────────────────

console.log("Prompt");

await writeFile(path.join(cwd, "AGENTS.md"), "# Rules\n\nKeep it small.\n");
const memoryDir = await getProjectMemoryDir(cwd);
await mkdir(memoryDir, { recursive: true });
await writeFile(path.join(memoryDir, "MEMORY.md"), "# Project Memory\n\n- [Fact](fact.md) — zebra-index-entry\n");
const environment = {
  ...(await getRuntimeEnvironmentContext(cwd)),
  gitBranch: "main",
  gitStatus: "clean",
  gitRecentCommit: "abc123 init",
};
const promptOf = async (spec: Record<string, unknown> | undefined) => {
  const harness = spec ? resolveSpec(spec) : undefined;
  const sections = await collectDynamicSections({ cwd, environment, harness });
  return {
    static: renderSystemPrompt(buildStaticSystemParts(harness)),
    sections,
    text: renderSystemPrompt(sections.map((section) => section.text).filter(Boolean)),
  };
};

await check("without an Agent, and with an empty one, the prompt is the built-in one", async () => {
  const builtIn = await promptOf(undefined);
  const empty = await promptOf({});
  assert.equal(empty.static, builtIn.static);
  assert.equal(empty.text, builtIn.text);
  assert.match(builtIn.static, /You are Easy Agent/);
  for (const text of [
    "Current working directory",
    "Git branch at session start",
    "Keep it small.",
    "zebra-index-entry",
  ]) {
    assert.ok(builtIn.text.includes(text), text);
  }
});

await check("the identity replaces the built-in identity and an empty one leaves it out", async () => {
  const replaced = await promptOf({ prompt: { identity: "  You are the on-call assistant.\n" } });
  assert.match(replaced.static, /<SYSTEM_STATIC_CONTEXT>\n\nYou are the on-call assistant\.\n\nOperate directly/);
  assert.doesNotMatch(replaced.static, /You are Easy Agent|file-tool boundary/);
  const empty = await promptOf({ prompt: { identity: "" } });
  assert.match(empty.static, /<SYSTEM_STATIC_CONTEXT>\n\nOperate directly/);
});

await check("each context source turns off on its own", async () => {
  const noEnv = await promptOf({ context: { environment: false } });
  assert.doesNotMatch(noEnv.text, /Current working directory|Operating system/);
  assert.match(noEnv.text, /Environment:\n- Git branch at session start: main/, "git stays without the rest");
  const noGit = await promptOf({ context: { gitStatus: false } });
  assert.match(noGit.text, /Current working directory/);
  assert.doesNotMatch(noGit.text, /Git branch|Git status|Most recent commit/);
  const neither = await promptOf({ context: { environment: false, gitStatus: false } });
  assert.equal(neither.sections.find((s) => s.name === "environment")?.text, "");

  const noAgentMd = await promptOf({ context: { agentMd: false } });
  assert.doesNotMatch(noAgentMd.text, /Keep it small/);
  const noMemory = await promptOf({ context: { memory: false } });
  assert.doesNotMatch(noMemory.text, /zebra-index-entry/);
  assert.match(noMemory.text, /persistent, file-based project memory/, "the instructions stay");
  const noLists = await promptOf({ context: { skills: false, agents: false } });
  assert.equal(noLists.sections.find((s) => s.name === "skills")?.text, "");
  assert.equal(noLists.sections.find((s) => s.name === "agents")?.text, "");
});

await check("a turned-off or replaced section shows none of its source", async () => {
  const off = await promptOf({ prompt: { sections: { memory: false, agent_md: { text: "Our rules." } } } });
  assert.doesNotMatch(off.text, /file-based project memory|zebra-index-entry|Keep it small/);
  assert.match(off.text, /Our rules\./);
});

// ─── Runtime ───────────────────────────────────────────────────────────

const systemText = (request: { body: Record<string, unknown> } | undefined) =>
  ((request?.body.system as { text: string }[] | undefined) ?? []).map((block) => block.text).join("\n");
/** The context update sent before the request's last user message, or "" when there is none. */
const contextUpdate = (request: { body: Record<string, unknown> } | undefined) =>
  ((request?.body.messages as { content: unknown }[] | undefined) ?? [])
    .map((message) => JSON.stringify(message.content))
    .filter((content) => content.includes(CONTEXT_UPDATE_MARKER))
    .at(-1) ?? "";

async function start(name: string | undefined, warnings: string[] = []): Promise<AgentRuntime> {
  resetSettingsCache();
  return createAgentRuntime({
    cwd,
    trust: "session",
    services: false,
    logger: { warn: (message) => warnings.push(message), error() {} },
    ...(name ? { harness: { name } } : {}),
  });
}

const harnesses: Record<string, unknown> = {
  focused: { prompt: { sections: { memory: false } }, context: { agentMd: false } },
  broken: { prompt: { sections: { identity: false, rules: { text: "x", after: "nowhere" } } } },
};

console.log("Runtime");

try {
  await writeJson(userSettings, { harnesses });

  await check("startup warns about section problems", async () => {
    const warnings: string[] = [];
    const runtime = await start("broken", warnings);
    await runtime.dispose();
    assert.ok(
      warnings.some((message) => /prompt\.sections\.identity: identity and instructions are static/.test(message)),
    );
    assert.ok(warnings.some((message) => /prompt\.sections\.rules\.after names no section: nowhere/.test(message)));
  });

  await check(
    "a section edit reaches the model as a context update; an identity edit rebuilds the prompt",
    async () => {
      const runtime = await start("focused");
      const session = await runtime.createSession({ persist: false });
      try {
        fixture.requests.length = 0;
        fixture.script([
          { kind: "text", text: "one" },
          { kind: "text", text: "two" },
          { kind: "text", text: "three" },
        ]);
        await session.send("first");
        const first = systemText(fixture.requests[0]);
        assert.doesNotMatch(first, /Keep it small|file-based project memory/);

        await writeJson(userSettings, {
          harnesses: {
            ...harnesses,
            focused: { prompt: { sections: { memory: false, notes: { text: "Be brief." } } } },
          },
        });
        await session.send("second");
        assert.equal(systemText(fixture.requests[1]), first, "the cached prompt stays");
        const update = contextUpdate(fixture.requests[1]);
        assert.match(update, /## Project memory \(AGENT\.md\)/, "the AGENTS.md source came back");
        assert.match(update, /## notes\\nBe brief\./, "the added section is titled by its name");

        await writeJson(userSettings, {
          harnesses: { ...harnesses, focused: { prompt: { identity: "You are terse." } } },
        });
        await session.send("third");
        const third = systemText(fixture.requests[2]);
        assert.match(third, /You are terse\./);
        assert.doesNotMatch(third, /You are Easy Agent/);
        assert.match(third, /file-based project memory/, "the rebuilt prompt has the memory section again");
        assert.doesNotMatch(third, /Be brief\./, "and no longer the removed section");
      } finally {
        await session.close();
        await writeJson(userSettings, { harnesses });
        await runtime.dispose();
      }
    },
  );

  await check("/context and the inventory leave out what the Agent does not load", async () => {
    const plain = await start(undefined);
    let plainRules: number;
    try {
      const session = await plain.createSession({ persist: false });
      const context = await session.getContext();
      plainRules = context.categories.find((category) => category.id === "rules")!.tokens;
      assert.ok(plainRules > 0, "AGENTS.md and MEMORY.md count without an Agent");
      await session.close();
      const inventory = await plain.getInventory();
      assert.ok(inventory.rules.every((rule) => rule.enabled));
    } finally {
      await plain.dispose();
    }

    const runtime = await start("focused");
    try {
      const session = await runtime.createSession({ persist: false });
      const context = await session.getContext();
      assert.equal(context.categories.find((category) => category.id === "rules")!.tokens, 0);
      assert.ok(!context.categories.find((c) => c.id === "system")!.items.some((item) => item.id === "memory"));
      await session.close();
      const inventory = await runtime.getInventory();
      const agentsMd = inventory.rules.find((rule) => rule.name === "AGENTS.md");
      assert.equal(agentsMd?.enabled, false);
      assert.equal(agentsMd?.reason, 'Turned off by context.agentMd (Agent "focused").');
      const memory = inventory.rules.find((rule) => rule.scope === "memory");
      assert.equal(memory?.reason, 'Turned off by prompt.sections (Agent "focused").');
    } finally {
      await runtime.dispose();
    }
  });

  await check("--dump-system-prompt --harness prints the Agent's prompt", async () => {
    await writeJson(userSettings, {
      harnesses: { ...harnesses, terse: { prompt: { identity: "You are terse.", sections: { memory: false } } } },
    });
    const run = (...args: string[]) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolvePromise) => {
        execFile(
          process.execPath,
          [
            "--import",
            import.meta.resolve("tsx"),
            path.join(import.meta.dirname, "..", "entrypoint", "cli.ts"),
            ...args,
          ],
          {
            cwd,
            timeout: 60_000,
            env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" },
          },
          (error, stdout, stderr) => {
            resolvePromise({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
          },
        );
      });
    const plain = await run("--dump-system-prompt");
    assert.equal(plain.code, 0, plain.stderr);
    assert.match(plain.stdout, /You are Easy Agent/);
    assert.match(plain.stdout, /file-based project memory/);
    const terse = await run("--dump-system-prompt", "--harness", "terse");
    assert.equal(terse.code, 0, terse.stderr);
    assert.match(terse.stdout, /You are terse\./);
    assert.doesNotMatch(terse.stdout, /You are Easy Agent|file-based project memory/);
  });
} finally {
  await fixture.close();
}

console.log(`\nHarness prompt: ${passed} passed, 0 failed.`);
await rm(root, { recursive: true, force: true }).catch(() => {});
