/**
 * Harness resolver tests.
 *
 * Parity: for a set of settings, trust, flag, and environment combinations,
 * the built-in `default` harness must resolve every applied key to the value
 * the current loaders read (permissions, features, model selection, output
 * style, language, thinking, checkpoints, retries, budgets, ...).
 *
 * Rules: Agent specs in `harnesses`, `extends` chains, the user's `default`
 * override, cycles and unknown names, invalid specs, `file` references,
 * project `harnesses` being ignored, trust filtering with reasons, layer
 * order including managed policy and the environment, keys a spec sets that
 * this build does not apply, the snapshot hash, and immutability.
 *
 * Run: node --import tsx src/scripts/test-harness-resolve.ts
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "easy-agent-harness-")));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
await Promise.all([
  mkdir(path.join(home, ".easy-agent", "prompts"), { recursive: true }),
  mkdir(path.join(cwd, ".easy-agent"), { recursive: true }),
]);
const ENV_NAMES = [
  "ANTHROPIC_MODEL",
  "EASY_AGENT_ENABLE_TOOL_SEARCH",
  "ENABLE_TOOL_SEARCH",
  "MAX_THINKING_TOKENS",
  "EASY_AGENT_DISABLE_CHECKPOINTING",
  "EASY_AGENT_TEAMS",
  "EASY_AGENT_DISABLE_PROMPT_CACHING",
  "EASY_AGENT_DISABLE_EXPERIMENTAL_BETAS",
  "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
  "EASY_AGENT_MAX_RETRIES",
  "CLAUDE_CODE_MAX_RETRIES",
  "EASY_AGENT_SKILL_CHAR_BUDGET",
  "EASY_AGENT_MAX_CONTEXT_TOKENS",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "WEB_SEARCH_ADAPTER",
  "CLAUDE_CODE_DISABLE_THINKING",
  "CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING",
  "DISABLE_INTERLEAVED_THINKING",
  "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT",
] as const;
for (const key of Object.keys(process.env)) {
  if (/^(?:ANTHROPIC_|EASY_AGENT_|CLAUDE_CODE_)/.test(key) || (ENV_NAMES as readonly string[]).includes(key)) {
    delete process.env[key];
  }
}
process.env.HOME = home;
process.env.USERPROFILE = home;
process.chdir(cwd);

const { resolveHarness, resolveHarnessFromInputs, harnessValue, HARNESS_KEYS } = await import("../harness/index.js");
type ResolvedHarness = import("../harness/index.js").ResolvedHarness;
type HarnessInputs = import("../harness/index.js").HarnessInputs;
const { ENVIRONMENT_VARIABLES } = await import("../config/catalog.js");
const { setFlagSettings, resetSettingsCache, loadTrustedSettingSources, getScalarSetting } = await import(
  "../config/sources.js"
);
const { trustProjectForSession, untrustProject } = await import("../config/globalState.js");
const { loadPermissionSettings } = await import("../permissions/permissions.js");
const { loadFeatureSettings, loadMaxTurnsSetting } = await import("../config/features.js");
const { readMergedStringSetting, readMergedBooleanSetting } = await import("../utils/settings.js");
const { getDefaultModel } = await import("../services/api/client.js");
const { configureThinkingDefaults, shouldEnableThinkingByDefault, buildDefaultThinkingConfig, modelSupportsEffort } =
  await import("../utils/thinking.js");
const { isAgentTeamsEnabled } = await import("../utils/agentTeamsEnabled.js");
const { isPromptCachingDisabled } = await import("../services/api/promptCache.js");
const { areExperimentalBetasDisabled } = await import("../utils/experimentalBetas.js");
const { getMaxRetries } = await import("../services/api/withRetry.js");
const { getSkillCharBudget } = await import("../services/skills/budget.js");
const { getContextWindowForModel } = await import("../utils/tokens.js");
const { validateSettings } = await import("../config/schema.js");
const { writeConfig } = await import("../sdk/config.js");

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ─── Parity with the current loaders ───────────────────────────────────

interface Case {
  name: string;
  user?: Record<string, unknown>;
  project?: Record<string, unknown>;
  local?: Record<string, unknown>;
  flag?: Record<string, unknown>;
  env?: Partial<Record<(typeof ENV_NAMES)[number], string>>;
  trusted?: boolean;
  /** Spot checks that the settings reached both sides, so a parity pass cannot be vacuous. */
  expect?: Record<string, unknown>;
}

async function writeJson(file: string, value: Record<string, unknown> | undefined): Promise<void> {
  await writeFile(file, JSON.stringify(value ?? {}));
}

async function apply(testCase: Case): Promise<void> {
  await writeJson(path.join(home, ".easy-agent", "settings.json"), testCase.user);
  await writeJson(path.join(cwd, ".easy-agent", "settings.json"), testCase.project);
  await writeJson(path.join(cwd, ".easy-agent", "settings.local.json"), testCase.local);
  setFlagSettings(testCase.flag ?? null);
  for (const name of ENV_NAMES) delete process.env[name];
  for (const [name, value] of Object.entries(testCase.env ?? {})) process.env[name] = value;
  if (testCase.trusted) await trustProjectForSession(cwd);
  else await untrustProject(cwd);
  resetSettingsCache();
}

/** What the current code reads, key by key. */
async function currentValues(): Promise<Record<string, unknown>> {
  const permissions = await loadPermissionSettings(cwd);
  const features = await loadFeatureSettings(cwd);
  const trustedSources = await loadTrustedSettingSources(cwd);
  const alwaysThinkingEnabled = getScalarSetting<boolean>(trustedSources, "alwaysThinkingEnabled", {
    predicate: (v) => typeof v === "boolean",
  });
  const effortLevel = getScalarSetting<string>(trustedSources, "effortLevel", {
    predicate: (v) => v === "low" || v === "medium" || v === "high" || v === "max",
  });
  // Bootstrap only sets defined values; reset to the default first so cases stay independent.
  configureThinkingDefaults({ alwaysThinkingEnabled: alwaysThinkingEnabled ?? true });
  const thinkingConfig = buildDefaultThinkingConfig();
  const checkpointsEnv = process.env.EASY_AGENT_DISABLE_CHECKPOINTING?.trim().toLowerCase();
  const webSearch = process.env.WEB_SEARCH_ADAPTER;
  return {
    "permissions.mode": permissions.mode,
    "permissions.allow": permissions.allow,
    "permissions.deny": permissions.deny,
    "features.toolSearch": features.toolSearch,
    "features.toolSearchAutoThreshold": features.toolSearchAutoThreshold,
    "model.roles.background": features.modelRoles.background,
    "model.roles.think": features.modelRoles.think,
    "model.roles.longContext": features.modelRoles.longContext,
    "features.maxTurns": await loadMaxTurnsSetting(cwd),
    "model.main":
      (await readMergedStringSetting(cwd, "model")) ??
      (await readMergedStringSetting(cwd, "defaultModel")) ??
      getDefaultModel(),
    outputStyle: await readMergedStringSetting(cwd, "outputStyle"),
    "prompt.language": await readMergedStringSetting(cwd, "language"),
    "tools.respectGitignore": (await readMergedBooleanSetting(cwd, "respectGitignore")) !== false,
    "session.checkpoints":
      (await readMergedBooleanSetting(cwd, "checkpointingEnabled")) !== false &&
      !["1", "true", "yes", "on"].includes(checkpointsEnv ?? ""),
    "features.thinking": shouldEnableThinkingByDefault(),
    "features.thinkingBudget": thinkingConfig.type === "enabled" ? thinkingConfig.budgetTokens : undefined,
    "features.effort": effortLevel,
    "features.effortForAllModels": modelSupportsEffort("claude-3-haiku-20240307"),
    "features.thinkingInRequests": !process.env.CLAUDE_CODE_DISABLE_THINKING,
    "features.adaptiveThinking": !process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING,
    "features.interleavedThinking": !process.env.DISABLE_INTERLEAVED_THINKING,
    "features.agentTeams": isAgentTeamsEnabled(),
    "features.promptCaching": !isPromptCachingDisabled(),
    "features.experimentalBetas": !areExperimentalBetasDisabled(),
    "features.maxRetries": getMaxRetries(),
    "skills.listingBudgetChars": getSkillCharBudget(),
    "compaction.contextWindow": getContextWindowForModel("parity-unknown-model"),
    "tools.webSearchBackend": webSearch === "bing" || webSearch === "api" ? webSearch : undefined,
  };
}

const CASES: Case[] = [
  { name: "nothing configured" },
  {
    name: "user settings only",
    user: {
      model: "user-model",
      mode: "plan",
      allow: ["Read"],
      deny: ["Bash(rm*)"],
      toolSearch: "auto",
      toolSearchAutoThreshold: 25,
      modelRoles: { think: "think-model" },
      maxTurns: 80,
      outputStyle: "Explanatory",
      language: "Chinese",
      respectGitignore: false,
      checkpointingEnabled: false,
      alwaysThinkingEnabled: false,
      effortLevel: "high",
    },
    expect: {
      "model.main": "user-model",
      "permissions.mode": "plan",
      "features.toolSearchAutoThreshold": 25,
      "model.roles.think": "think-model",
      "session.checkpoints": false,
      "features.thinking": false,
    },
  },
  {
    name: "untrusted project: only deny rules apply",
    user: { allow: ["Read"], model: "user-model" },
    project: {
      allow: ["Write"],
      deny: ["Edit"],
      mode: "auto",
      model: "project-model",
      toolSearch: "off",
      maxTurns: 5,
      outputStyle: "Learning",
      checkpointingEnabled: false,
    },
    local: { allow: ["Bash"], deny: ["WebFetch"], model: "local-model" },
    expect: { "permissions.allow": ["Read"], "permissions.deny": ["Edit", "WebFetch"], "model.main": "user-model" },
  },
  {
    name: "trusted project: rules and agent keys apply, mode does not",
    trusted: true,
    user: { allow: ["Read"], model: "user-model", mode: "plan", modelRoles: { think: "u", background: "u-bg" } },
    project: {
      allow: ["Write"],
      deny: ["Edit"],
      mode: "auto",
      model: "project-model",
      toolSearch: "off",
      maxTurns: 5,
      modelRoles: { think: "p" },
      language: "French",
    },
    local: { allow: ["Bash"], model: "local-model", respectGitignore: false, effortLevel: "low" },
    expect: {
      "permissions.allow": ["Read", "Write", "Bash"],
      "permissions.mode": "plan",
      "model.main": "local-model",
      "model.roles.think": "p",
      "model.roles.background": "u-bg",
    },
  },
  {
    name: "flags win over settings",
    trusted: true,
    user: { model: "user-model", mode: "plan", toolSearch: "on", maxTurns: 40 },
    project: { model: "project-model" },
    flag: { model: "flag-model", mode: "auto", toolSearch: "auto", maxTurns: 300, allow: ["Grep"] },
  },
  {
    name: "defaultModel when no model is set",
    trusted: true,
    user: { defaultModel: "user-default" },
    project: { defaultModel: "project-default" },
  },
  {
    name: "defaultModel loses to any model",
    user: { model: "user-model" },
    local: { defaultModel: "x" },
    trusted: true,
  },
  {
    name: "ANTHROPIC_MODEL below settings",
    env: { ANTHROPIC_MODEL: "env-model" },
    expect: { "model.main": "env-model" },
  },
  { name: "ANTHROPIC_MODEL loses to a setting", env: { ANTHROPIC_MODEL: "env-model" }, user: { defaultModel: "d" } },
  {
    name: "legacy ToolSearch environment between files and flags",
    trusted: true,
    user: { toolSearch: "off", toolSearchAutoThreshold: 40 },
    project: { toolSearch: "on" },
    env: { EASY_AGENT_ENABLE_TOOL_SEARCH: "auto:30" },
    expect: { "features.toolSearch": "auto", "features.toolSearchAutoThreshold": 30 },
  },
  {
    name: "legacy ToolSearch environment loses to a flag",
    user: { toolSearch: "off" },
    env: { ENABLE_TOOL_SEARCH: "true" },
    flag: { toolSearch: "auto" },
  },
  { name: "invalid legacy ToolSearch value is ignored", env: { ENABLE_TOOL_SEARCH: "sometimes" } },
  {
    name: "thinking from MAX_THINKING_TOKENS beats settings",
    user: { alwaysThinkingEnabled: false },
    env: { MAX_THINKING_TOKENS: "4096" },
  },
  { name: "MAX_THINKING_TOKENS=0 turns thinking off", env: { MAX_THINKING_TOKENS: "0" } },
  {
    name: "checkpoint kill switch beats settings",
    trusted: true,
    project: { checkpointingEnabled: true },
    env: { EASY_AGENT_DISABLE_CHECKPOINTING: "yes" },
  },
  {
    name: "environment-only switches",
    env: {
      EASY_AGENT_TEAMS: "1",
      EASY_AGENT_DISABLE_PROMPT_CACHING: "true",
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "on",
      EASY_AGENT_MAX_RETRIES: "3",
      EASY_AGENT_SKILL_CHAR_BUDGET: "4000",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "120000",
      WEB_SEARCH_ADAPTER: "bing",
      CLAUDE_CODE_DISABLE_THINKING: "1",
      CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
      DISABLE_INTERLEAVED_THINKING: "1",
      CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "1",
    },
  },
  {
    name: "invalid environment values fall back",
    env: {
      EASY_AGENT_MAX_RETRIES: "-2",
      EASY_AGENT_SKILL_CHAR_BUDGET: "lots",
      EASY_AGENT_MAX_CONTEXT_TOKENS: "0",
      WEB_SEARCH_ADAPTER: "duckduckgo",
      EASY_AGENT_TEAMS: "maybe",
    },
  },
  {
    name: "autoMode alias in user settings",
    user: { autoMode: true },
  },
];

console.log("Parity with the current loaders");
const comparedKeys = new Set<string>();
for (const testCase of CASES) {
  await check(testCase.name, async () => {
    await apply(testCase);
    const resolved = await resolveHarness({ cwd });
    assert.deepEqual(
      resolved.issues.filter((issue) => issue.level === "error"),
      [],
      "default resolves without errors",
    );
    const expected = await currentValues();
    for (const [keyPath, value] of Object.entries(expected)) {
      comparedKeys.add(keyPath);
      let actual = harnessValue(resolved, keyPath);
      if (keyPath === "compaction.contextWindow") actual = actual ?? 200_000;
      assert.deepEqual(
        actual,
        value,
        `${keyPath}: harness ${JSON.stringify(actual)} vs current ${JSON.stringify(value)}`,
      );
    }
    for (const [keyPath, value] of Object.entries(testCase.expect ?? {})) {
      assert.deepEqual(harnessValue(resolved, keyPath), value, `spot check ${keyPath}`);
    }
  });
}

await check("every applied key is compared with the current code", () => {
  const applied = HARNESS_KEYS.filter((key) => key.applied).map((key) => key.path);
  assert.deepEqual(
    applied.filter((keyPath) => !comparedKeys.has(keyPath)),
    [],
    "add a parity comparison for each applied key",
  );
});

await check("every environment variable a key reads is in the configuration inventory", () => {
  const listed = new Set(ENVIRONMENT_VARIABLES.flatMap((entry) => [entry.name, ...(entry.aliases ?? [])]));
  const missing = HARNESS_KEYS.flatMap((key) => key.env?.names ?? []).filter((name) => !listed.has(name));
  assert.deepEqual(missing, []);
});

// ─── Resolver rules ────────────────────────────────────────────────────

await apply({ name: "reset" });
setFlagSettings(null);

function resolve(partial: Partial<HarnessInputs> & { user?: Record<string, unknown> }): ResolvedHarness {
  const { user, ...rest } = partial;
  return resolveHarnessFromInputs({
    layers: [{ source: "user", path: "/u/settings.json", raw: user ?? {} }, ...(rest.layers ?? [])],
    workspaceTrusted: rest.workspaceTrusted ?? false,
    env: rest.env ?? {},
    configDir: path.join(home, ".easy-agent"),
    home,
    ...(rest.name !== undefined ? { name: rest.name } : {}),
    ...(rest.spec !== undefined ? { spec: rest.spec } : {}),
    ...(rest.readText ? { readText: rest.readText } : {}),
    ...(rest.agentTeamsFlag ? { agentTeamsFlag: true } : {}),
  });
}
const errors = (resolved: ResolvedHarness) => resolved.issues.filter((issue) => issue.level === "error");
const warnings = (resolved: ResolvedHarness) => resolved.issues.filter((issue) => issue.level === "warning");

console.log("Resolver rules");

await check("an Agent's spec sits above user settings and below project settings", () => {
  const resolved = resolve({
    name: "reviewer",
    workspaceTrusted: true,
    user: {
      model: "user-model",
      outputStyle: "Explanatory",
      harnesses: {
        reviewer: { model: { main: "review-model" }, outputStyle: "Learning", permissions: { allow: ["Read"] } },
      },
    },
    layers: [{ source: "project", path: "/p/settings.json", raw: { outputStyle: "Concise", allow: ["Grep"] } }],
  });
  assert.equal(harnessValue(resolved, "model.main"), "review-model");
  assert.equal(resolved.values["model.main"]!.source, "harness");
  assert.equal(resolved.values["model.main"]!.detail, "reviewer");
  assert.equal(harnessValue(resolved, "outputStyle"), "Concise");
  assert.deepEqual(resolved.values.outputStyle!.overridesHarness, { harness: "reviewer", value: "Learning" });
  assert.deepEqual(harnessValue(resolved, "permissions.allow"), ["Read", "Grep"]);
  assert.deepEqual(resolved.chain, ["reviewer"]);
});

await check("low-trust layers cannot loosen permissions, and say why", () => {
  const resolved = resolve({
    name: "default",
    workspaceTrusted: false,
    layers: [
      { source: "project", path: "/p", raw: { allow: ["Write"], deny: ["Edit"], mode: "auto", model: "p" } },
      { source: "local", path: "/l", raw: { allow: ["Bash"] } },
    ],
  });
  assert.deepEqual(harnessValue(resolved, "permissions.allow"), []);
  assert.deepEqual(harnessValue(resolved, "permissions.deny"), ["Edit"]);
  assert.equal(harnessValue(resolved, "permissions.mode"), "default");
  assert.deepEqual(
    resolved.values["permissions.allow"]!.ignored.map(({ source, reason }) => [source, reason]),
    [
      ["project", "workspace is not trusted"],
      ["local", "workspace is not trusted"],
    ],
  );
  assert.equal(
    resolved.values["permissions.mode"]!.ignored[0]?.reason,
    "only user settings, flags, and managed policy can set this",
  );
  assert.equal(resolved.values["model.main"]!.ignored[0]?.reason, "workspace is not trusted");

  const trusted = resolve({
    workspaceTrusted: true,
    layers: [{ source: "project", path: "/p", raw: { allow: ["Write"], mode: "auto" } }],
  });
  assert.deepEqual(harnessValue(trusted, "permissions.allow"), ["Write"]);
  assert.equal(harnessValue(trusted, "permissions.mode"), "default", "mode stays user-only in a trusted workspace");
});

await check("extends chains, the user's default override, and inheritance", () => {
  const resolved = resolve({
    name: "strict-reviewer",
    user: {
      harnesses: {
        default: { outputStyle: "Explanatory", features: { maxTurns: 120 } },
        reviewer: { model: { main: "review-model" }, permissions: { deny: ["Write"] } },
        "strict-reviewer": { extends: "reviewer", permissions: { deny: ["Bash"] }, features: { maxTurns: 30 } },
      },
    },
  });
  assert.deepEqual(errors(resolved), []);
  assert.deepEqual(resolved.chain, ["default", "reviewer", "strict-reviewer"]);
  assert.equal(harnessValue(resolved, "outputStyle"), "Explanatory", "inherited from the user's default");
  assert.equal(harnessValue(resolved, "model.main"), "review-model");
  assert.equal(harnessValue(resolved, "features.maxTurns"), 30);
  assert.deepEqual(harnessValue(resolved, "permissions.deny"), ["Bash"], "a child's list replaces its parent's");
  assert.equal(resolved.values["features.maxTurns"]!.detail, "strict-reviewer");

  const plain = resolve({ user: { harnesses: { default: { outputStyle: "Explanatory" } } } });
  assert.deepEqual(plain.chain, ["default"]);
  assert.equal(harnessValue(plain, "outputStyle"), "Explanatory");
});

await check("cycles, unknown names, and invalid specs are errors", () => {
  const cycle = resolve({ name: "a", user: { harnesses: { a: { extends: "b" }, b: { extends: "a" } } } });
  assert.match(errors(cycle)[0]?.message ?? "", /extends cycle: a → b → a/);

  const missingParent = resolve({ name: "a", user: { harnesses: { a: { extends: "nope" } } } });
  assert.match(errors(missingParent)[0]?.message ?? "", /no Agent named "nope"/);

  const unknown = resolve({ name: "ghost" });
  assert.match(errors(unknown)[0]?.message ?? "", /no Agent named "ghost"/);

  const invalid = resolve({
    name: "typo",
    user: { harnesses: { typo: { modle: { main: "x" }, features: { maxTurns: -1 } } } },
  });
  const paths = errors(invalid).map((issue) => issue.path ?? "");
  assert.ok(paths.includes("features.maxTurns"), `invalid value reported: ${JSON.stringify(errors(invalid))}`);
  assert.ok(
    errors(invalid).some((issue) => /modle/.test(issue.message) || issue.path === ""),
    "unknown key reported",
  );
  assert.equal(harnessValue(invalid, "features.maxTurns"), undefined, "an invalid spec contributes nothing");

  const badDefault = resolve({ user: { harnesses: { default: { extends: "other" }, other: {} } } });
  assert.match(errors(badDefault)[0]?.message ?? "", /extends only the built-in default/);

  const badName = resolve({ name: "bad name", user: { harnesses: { "bad name": {} } } });
  assert.match(errors(badName)[0]?.message ?? "", /names use letters/);
});

await check("harnesses outside the user settings file are ignored with a warning", () => {
  const resolved = resolve({
    name: "default",
    workspaceTrusted: true,
    layers: [
      { source: "project", path: "/p/settings.json", raw: { harnesses: { default: { outputStyle: "Learning" } } } },
      { source: "policy", path: "/etc/managed.json", raw: { harnesses: {} } },
    ],
  });
  assert.equal(harnessValue(resolved, "outputStyle"), undefined);
  assert.equal(warnings(resolved).filter((issue) => /are ignored/.test(issue.message)).length, 2);
});

await check("file references load text, relative to ~/.easy-agent", async () => {
  await writeFile(path.join(home, ".easy-agent", "prompts", "identity.md"), "You review code.\n");
  const resolved = resolve({
    name: "reviewer",
    user: {
      harnesses: {
        reviewer: {
          prompt: {
            identity: { file: "prompts/identity.md" },
            sections: { memory: false, rules: { file: "~/.easy-agent/prompts/identity.md", after: "agent_md" } },
          },
        },
      },
    },
    readText: (file) => {
      if (!file.endsWith("identity.md")) throw new Error("unexpected file");
      return "You review code.\n";
    },
  });
  assert.deepEqual(errors(resolved), []);
  assert.deepEqual(harnessValue(resolved, "prompt.identity"), {
    text: "You review code.\n",
    file: path.join(home, ".easy-agent", "prompts", "identity.md"),
  });
  const sections = harnessValue<Record<string, unknown>>(resolved, "prompt.sections");
  assert.equal(sections.memory, false);
  assert.deepEqual(sections.rules, {
    after: "agent_md",
    text: "You review code.\n",
    file: path.join(home, ".easy-agent", "prompts", "identity.md"),
  });

  const missing = resolveHarnessFromInputs({
    layers: [{ source: "user", path: null, raw: { harnesses: { r: { prompt: { identity: { file: "nope.md" } } } } } }],
    workspaceTrusted: false,
    env: {},
    name: "r",
    configDir: path.join(home, ".easy-agent"),
    home,
  });
  assert.match(errors(missing)[0]?.message ?? "", /cannot read .*nope\.md/);
  assert.equal(harnessValue(missing, "prompt.identity"), undefined);
});

await check("keys this build does not apply yet are reported when set", () => {
  const resolved = resolve({
    name: "minimalish",
    user: { ask: ["Bash(git push*)"], harnesses: { minimalish: { tools: { exclude: ["WebFetch"] } } } },
  });
  const messages = warnings(resolved).map((issue) => issue.message);
  assert.ok(
    messages.some((m) => /tools\.exclude is set by Agent "minimalish", but this build does not apply it yet/.test(m)),
  );
  assert.ok(messages.some((m) => /permissions\.ask is set by user, but this build does not apply it yet/.test(m)));
  assert.equal(resolved.values["tools.exclude"]!.applied, false);
  assert.equal(resolved.values["model.main"]!.applied, true);
});

await check("layer order: environment, flags, and managed policy", () => {
  const resolved = resolve({
    user: { toolSearch: "off", mode: "plan", checkpointingEnabled: true, alwaysThinkingEnabled: true },
    layers: [
      { source: "flag", path: null, raw: { mode: "auto" } },
      {
        source: "policy",
        path: "/etc/managed.json",
        raw: { mode: "default", toolSearch: "on", checkpointingEnabled: true },
      },
    ],
    env: { ENABLE_TOOL_SEARCH: "auto", EASY_AGENT_DISABLE_CHECKPOINTING: "1", MAX_THINKING_TOKENS: "0" },
    agentTeamsFlag: true,
  });
  assert.equal(harnessValue(resolved, "permissions.mode"), "default", "policy wins over the flag");
  assert.equal(harnessValue(resolved, "features.toolSearch"), "on", "policy wins over the environment");
  assert.equal(harnessValue(resolved, "session.checkpoints"), false, "the kill switch wins over policy");
  assert.equal(harnessValue(resolved, "features.thinking"), false);
  assert.equal(harnessValue(resolved, "features.agentTeams"), true);
  assert.equal(resolved.values["features.agentTeams"]!.detail, "--agent-teams");
  assert.deepEqual(
    resolved.values["permissions.mode"]!.contributions.map((c) => c.source),
    ["built-in", "user", "flag", "policy"],
  );

  const envOverHarness = resolve({
    name: "a",
    user: { harnesses: { a: { features: { toolSearch: "off" } } } },
    env: { EASY_AGENT_ENABLE_TOOL_SEARCH: "on" },
  });
  assert.equal(harnessValue(envOverHarness, "features.toolSearch"), "on");
  assert.equal(envOverHarness.values["features.toolSearch"]!.detail, "EASY_AGENT_ENABLE_TOOL_SEARCH");

  const invalidEnv = resolve({ env: { ENABLE_TOOL_SEARCH: "sometimes" } });
  assert.deepEqual(invalidEnv.values["features.toolSearch"]!.ignored, [
    {
      source: "environment",
      detail: "ENABLE_TOOL_SEARCH",
      value: "sometimes",
      reason: "expected on, off, auto or auto:N",
    },
  ]);
});

await check("an inline spec resolves over its extends", () => {
  const resolved = resolve({
    spec: { extends: "reviewer", features: { maxTurns: 7 } },
    user: { harnesses: { reviewer: { model: { main: "review-model" } } } },
  });
  assert.equal(resolved.name, "(inline)");
  assert.deepEqual(resolved.chain, ["reviewer", "(inline)"]);
  assert.equal(harnessValue(resolved, "model.main"), "review-model");
  assert.equal(harnessValue(resolved, "features.maxTurns"), 7);
});

await check("the hash follows the values, and the snapshot is frozen", () => {
  const a = resolve({ user: { model: "m1" } });
  const b = resolve({ user: { model: "m1" } });
  const c = resolve({ user: { model: "m2" } });
  assert.equal(a.hash, b.hash);
  assert.notEqual(a.hash, c.hash);
  assert.match(a.hash, /^[0-9a-f]{16}$/);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.values) && Object.isFrozen(a.values["permissions.allow"]!.value));
  assert.throws(() => {
    (a.values as Record<string, unknown>)["model.main"] = 1;
  }, TypeError);
});

await check("settings files with harnesses stay valid; project files cannot be given one through the SDK", async () => {
  const { errors: validationErrors } = validateSettings({ harnesses: { reviewer: { model: { main: "x" } } } }, "user");
  assert.deepEqual(validationErrors, []);
  await assert.rejects(writeConfig(cwd, "project", "harnesses", { a: {} }), /only read from user settings/);
});

console.log(`\nHarness resolver: ${passed} passed, 0 failed.`);
setFlagSettings(null);
await rm(root, { recursive: true, force: true }).catch(() => {});
