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
  "EASY_AGENT_AUTO_MODE_MODEL",
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

// Keys the code already reads from the resolved harness cannot be compared
// with that code. These readers are what it did before, kept as the
// specification the resolver has to match. Deliberate changes: a
// MAX_THINKING_TOKENS that is not a number is ignored, like other invalid
// environment values (it used to turn thinking on with no budget), and the
// Auto Mode classifier role (EASY_AGENT_AUTO_MODE_MODEL) wins over the
// session's model instead of applying only when a caller passed none.
const truthySwitch = (value: string | undefined) => /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
const positiveInteger = (value: string | undefined) => {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

function referenceContextWindow(env: NodeJS.ProcessEnv): number {
  return positiveInteger(env.EASY_AGENT_MAX_CONTEXT_TOKENS ?? env.CLAUDE_CODE_MAX_CONTEXT_TOKENS) ?? 200_000;
}

function referenceClassifierModel(env: NodeJS.ProcessEnv): string | undefined {
  return env.EASY_AGENT_AUTO_MODE_MODEL || undefined;
}

function referenceMaxRetries(env: NodeJS.ProcessEnv): number {
  const raw = env.EASY_AGENT_MAX_RETRIES ?? env.CLAUDE_CODE_MAX_RETRIES;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10;
}

function referenceThinking(env: NodeJS.ProcessEnv, alwaysThinkingEnabled: boolean | undefined): boolean {
  const parsed = env.MAX_THINKING_TOKENS === undefined ? Number.NaN : Number.parseInt(env.MAX_THINKING_TOKENS, 10);
  if (!Number.isNaN(parsed)) return parsed > 0;
  return alwaysThinkingEnabled !== false;
}

function referenceThinkingBudget(env: NodeJS.ProcessEnv): number | undefined {
  const parsed = Number.parseInt(env.MAX_THINKING_TOKENS ?? "", 10);
  return parsed > 0 ? parsed : undefined;
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
  const env = process.env;
  const checkpointsEnv = env.EASY_AGENT_DISABLE_CHECKPOINTING?.trim().toLowerCase();
  const webSearch = env.WEB_SEARCH_ADAPTER;
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
      (env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514"),
    "model.roles.classifier": referenceClassifierModel(env),
    outputStyle: await readMergedStringSetting(cwd, "outputStyle"),
    "prompt.language": await readMergedStringSetting(cwd, "language"),
    "tools.respectGitignore": (await readMergedBooleanSetting(cwd, "respectGitignore")) !== false,
    "session.checkpoints":
      (await readMergedBooleanSetting(cwd, "checkpointingEnabled")) !== false &&
      !["1", "true", "yes", "on"].includes(checkpointsEnv ?? ""),
    "features.thinking": referenceThinking(env, alwaysThinkingEnabled),
    "features.thinkingBudget": referenceThinkingBudget(env),
    "features.effort": effortLevel,
    "features.effortForAllModels": Boolean(env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT),
    "features.thinkingInRequests": !env.CLAUDE_CODE_DISABLE_THINKING,
    "features.adaptiveThinking": !env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING,
    "features.interleavedThinking": !env.DISABLE_INTERLEAVED_THINKING,
    "features.agentTeams": process.argv.includes("--agent-teams") || truthySwitch(env.EASY_AGENT_TEAMS),
    "features.promptCaching": !truthySwitch(env.EASY_AGENT_DISABLE_PROMPT_CACHING),
    "features.experimentalBetas": ![
      env.EASY_AGENT_DISABLE_EXPERIMENTAL_BETAS,
      env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS,
    ].some(truthySwitch),
    "features.maxRetries": referenceMaxRetries(env),
    "skills.listingBudgetChars": positiveInteger(env.EASY_AGENT_SKILL_CHAR_BUDGET) ?? 8000,
    "compaction.contextWindow": referenceContextWindow(env),
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
    expect: { "model.main": "env-model", "model.roles.classifier": undefined },
  },
  { name: "ANTHROPIC_MODEL loses to a setting", env: { ANTHROPIC_MODEL: "env-model" }, user: { defaultModel: "d" } },
  {
    name: "EASY_AGENT_AUTO_MODE_MODEL names the classifier, not the main model",
    env: { EASY_AGENT_AUTO_MODE_MODEL: "judge", ANTHROPIC_MODEL: "env-model" },
    user: { model: "user-model" },
    expect: { "model.roles.classifier": "judge", "model.main": "user-model" },
  },
  {
    name: "an empty EASY_AGENT_AUTO_MODE_MODEL is unset",
    env: { EASY_AGENT_AUTO_MODE_MODEL: "", ANTHROPIC_MODEL: "env-model" },
    expect: { "model.roles.classifier": undefined },
  },
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
    name: "a MAX_THINKING_TOKENS that is not a number is ignored",
    user: { alwaysThinkingEnabled: false },
    env: { MAX_THINKING_TOKENS: "lots" },
    expect: { "features.thinking": false, "features.thinkingBudget": undefined },
  },
  { name: "an empty MAX_THINKING_TOKENS is ignored", env: { MAX_THINKING_TOKENS: "" } },
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

// ─── Code reads the active harness ─────────────────────────────────────

const { activeHarness, installHarness, uninstallHarness, refreshHarness } = await import("../harness/index.js");
const thinking = await import("../utils/thinking.js");
const { getMaxRetries } = await import("../services/api/withRetry.js");
const { isPromptCachingDisabled } = await import("../services/api/promptCache.js");
const { areExperimentalBetasDisabled } = await import("../utils/experimentalBetas.js");
const { getDefaultModel } = await import("../services/api/client.js");
const { isAgentTeamsEnabled } = await import("../utils/agentTeamsEnabled.js");
const { getSkillCharBudget } = await import("../services/skills/budget.js");
const { buildTokenBudgetSnapshot, getContextWindowForModel } = await import("../utils/tokens.js");
const { createAdapter } = await import("../tools/webSearch/adapters.js");
const OLD_HAIKU = "claude-3-haiku-20240307";

/** What the migrated readers return right now. */
async function readers(): Promise<Record<string, unknown>> {
  return {
    model: getDefaultModel(),
    teams: isAgentTeamsEnabled(),
    skillBudget: getSkillCharBudget(),
    window: getContextWindowForModel("parity-unknown-model"),
    budgetWindow: buildTokenBudgetSnapshot([]).contextWindow,
    webSearch: (await createAdapter()).name,
  };
}

function withEnvironment(values: Partial<Record<(typeof ENV_NAMES)[number], string>>, fn: () => void): void {
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, values);
  try {
    fn();
  } finally {
    for (const name of ENV_NAMES) delete process.env[name];
  }
}

console.log("Code reads the active harness");

await check("without a runtime, values follow the process environment at each read", () => {
  withEnvironment({}, () => {
    assert.equal(getMaxRetries(), 10);
    assert.equal(isPromptCachingDisabled(), false);
    assert.equal(areExperimentalBetasDisabled(), false);
    assert.equal(thinking.modelSupportsEffort(OLD_HAIKU), false);
    assert.deepEqual(thinking.buildDefaultThinkingConfig(), { type: "adaptive" });
    assert.equal(thinking.getSessionEffortLevel(), undefined);
    assert.equal(activeHarness(), activeHarness(), "reused while the environment is unchanged");

    process.env.EASY_AGENT_MAX_RETRIES = "4";
    process.env.EASY_AGENT_DISABLE_PROMPT_CACHING = "yes";
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
    process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = "1";
    process.env.MAX_THINKING_TOKENS = "2048";
    assert.equal(getMaxRetries(), 4);
    assert.equal(isPromptCachingDisabled(), true);
    assert.equal(areExperimentalBetasDisabled(), true);
    assert.equal(thinking.modelSupportsEffort(OLD_HAIKU), true);
    assert.deepEqual(thinking.buildDefaultThinkingConfig(), { type: "enabled", budgetTokens: 2048 });
    process.env.MAX_THINKING_TOKENS = "0";
    assert.deepEqual(thinking.buildDefaultThinkingConfig(), { type: "disabled" });
    process.env.MAX_THINKING_TOKENS = "lots";
    assert.deepEqual(thinking.buildDefaultThinkingConfig(), { type: "adaptive" }, "not a number: ignored");
    assert.deepEqual(activeHarness().values["features.thinking"]!.ignored, [
      { source: "environment", detail: "MAX_THINKING_TOKENS", value: "lots", reason: "expected 0 or a token budget" },
    ]);
  });
});

await check("an installed harness is the only source; the environment no longer changes it", () => {
  withEnvironment({}, () => {
    installHarness(
      resolve({
        user: { alwaysThinkingEnabled: false, effortLevel: "high" },
        env: {
          EASY_AGENT_MAX_RETRIES: "2",
          EASY_AGENT_DISABLE_PROMPT_CACHING: "1",
          EASY_AGENT_DISABLE_EXPERIMENTAL_BETAS: "on",
          CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "1",
        },
      }),
    );
    try {
      process.env.EASY_AGENT_MAX_RETRIES = "9";
      process.env.MAX_THINKING_TOKENS = "4096";
      assert.equal(getMaxRetries(), 2);
      assert.equal(isPromptCachingDisabled(), true);
      assert.equal(areExperimentalBetasDisabled(), true);
      assert.equal(thinking.modelSupportsEffort(OLD_HAIKU), true);
      assert.equal(thinking.shouldEnableThinkingByDefault(), false);
      assert.deepEqual(thinking.buildDefaultThinkingConfig(), { type: "disabled" }, "alwaysThinkingEnabled: false");
      assert.equal(thinking.getSessionEffortLevel(), "high");
    } finally {
      uninstallHarness();
    }
    assert.equal(getMaxRetries(), 9, "removing it goes back to the process environment");
  });
});

async function withEnvironmentAsync(
  values: Partial<Record<(typeof ENV_NAMES)[number], string>>,
  fn: () => Promise<void>,
): Promise<void> {
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, values);
  try {
    await fn();
  } finally {
    uninstallHarness();
    for (const name of ENV_NAMES) delete process.env[name];
  }
}

await check("model, Agent Teams, skill budget, context window, and WebSearch read the active harness", async () => {
  await withEnvironmentAsync({}, async () => {
    assert.deepEqual(await readers(), {
      model: "claude-sonnet-4-20250514",
      teams: false,
      skillBudget: 8000,
      window: 200_000,
      budgetWindow: 200_000,
      webSearch: "bing",
    });
    Object.assign(process.env, {
      ANTHROPIC_MODEL: "env-model",
      EASY_AGENT_TEAMS: "yes",
      EASY_AGENT_SKILL_CHAR_BUDGET: "500",
      EASY_AGENT_MAX_CONTEXT_TOKENS: "64000",
      WEB_SEARCH_ADAPTER: "api",
    });
    assert.deepEqual(
      await readers(),
      {
        model: "env-model",
        teams: true,
        skillBudget: 500,
        window: 64_000,
        budgetWindow: 64_000,
        webSearch: "anthropic",
      },
      "without a runtime, the process environment at each read",
    );

    installHarness(
      resolve({
        name: "wide",
        user: {
          model: "user-model",
          harnesses: {
            wide: {
              features: { agentTeams: true },
              skills: { listingBudgetChars: 1200 },
              compaction: { contextWindow: 50_000 },
              tools: { webSearchBackend: "bing" },
            },
          },
        },
      }),
    );
    assert.deepEqual(
      await readers(),
      { model: "user-model", teams: true, skillBudget: 1200, window: 50_000, budgetWindow: 50_000, webSearch: "bing" },
      "an installed harness, with the Agent's values and the settings files, replaces the environment",
    );
  });
});

await check("a refresh re-reads the settings files; the environment stays as it was at install", async () => {
  await withEnvironmentAsync({}, async () => {
    let user: Record<string, unknown> = { model: "first" };
    const again = async () => resolve({ user, env: { EASY_AGENT_MAX_RETRIES: "2" } });
    installHarness(await again(), again);
    user = { model: "second", alwaysThinkingEnabled: false };
    process.env.EASY_AGENT_MAX_RETRIES = "8";
    assert.equal(getDefaultModel(), "first", "reads keep the snapshot until a refresh");
    assert.equal(await refreshHarness(), activeHarness());
    assert.equal(getDefaultModel(), "second");
    assert.equal(thinking.shouldEnableThinkingByDefault(), false);
    assert.equal(getMaxRetries(), 2);
  });
});

await check("a refresh that loses a race, fails, or outlives its runtime installs nothing", async () => {
  await withEnvironmentAsync({}, async () => {
    const gates: (() => void)[] = [];
    const gated = (model: string) => () =>
      new Promise<ResolvedHarness>((done) => gates.push(() => done(resolve({ user: { model } }))));

    let calls = 0;
    installHarness(resolve({ user: { model: "m0" } }), () => gated(`m${++calls}`)());
    const older = refreshHarness();
    const newer = refreshHarness();
    gates[1]!();
    await newer;
    assert.equal(getDefaultModel(), "m2");
    gates[0]!();
    await older;
    assert.equal(getDefaultModel(), "m2", "an older refresh that finishes late is dropped");

    installHarness(resolve({ user: { model: "kept" } }), async () => {
      throw new Error("unreadable");
    });
    assert.equal(harnessValue(await refreshHarness(), "model.main"), "kept", "a failed refresh keeps the snapshot");

    installHarness(resolve({ user: { model: "runtime" } }), gated("late"));
    const late = refreshHarness();
    uninstallHarness();
    gates[2]!();
    await late;
    assert.equal(getDefaultModel(), "claude-sonnet-4-20250514", "the process default once the runtime is gone");

    installHarness(null, async () => resolve({ user: { model: "retried" } }));
    assert.equal(getDefaultModel(), "claude-sonnet-4-20250514", "a failed first resolution reads the process default");
    await refreshHarness();
    assert.equal(getDefaultModel(), "retried", "and the next refresh retries it");
  });
});

await check("/think overrides the settings default but not MAX_THINKING_TOKENS; an Agent can set a budget", () => {
  withEnvironment({}, () => {
    try {
      thinking.setSessionThinkingConfig({ type: "adaptive" });
      installHarness(resolve({ user: { alwaysThinkingEnabled: false } }));
      assert.deepEqual(thinking.buildDefaultThinkingConfig(), { type: "adaptive" });
      installHarness(resolve({ env: { MAX_THINKING_TOKENS: "0" } }));
      assert.deepEqual(thinking.buildDefaultThinkingConfig(), { type: "disabled" });
      thinking.setSessionThinkingConfig(undefined);

      installHarness(
        resolve({ name: "budgeted", user: { harnesses: { budgeted: { features: { thinkingBudget: 3000 } } } } }),
      );
      assert.deepEqual(thinking.buildDefaultThinkingConfig(), { type: "enabled", budgetTokens: 3000 });
    } finally {
      thinking.setSessionThinkingConfig(undefined);
      uninstallHarness();
    }
  });
});

await check("a runtime resolves its Agent when it starts and removes it when disposed", async () => {
  const { createAgentRuntime } = await import("../sdk/index.js");
  await writeJson(path.join(home, ".easy-agent", "settings.json"), {
    alwaysThinkingEnabled: false,
    effortLevel: "medium",
  });
  await writeJson(path.join(cwd, ".easy-agent", "settings.json"), {});
  await writeJson(path.join(cwd, ".easy-agent", "settings.local.json"), {});
  resetSettingsCache();
  for (const name of ENV_NAMES) delete process.env[name];
  process.env.EASY_AGENT_MAX_RETRIES = "3";

  // A bootstrap that fails after the Agent was resolved leaves nothing installed.
  await untrustProject(cwd);
  await writeJson(path.join(cwd, ".easy-agent", "settings.json"), { apiKeyHelper: "echo token" });
  resetSettingsCache();
  const failing = {
    warn() {
      throw new Error("logger failed");
    },
    error() {},
  };
  await assert.rejects(createAgentRuntime({ cwd, services: false, logger: failing }), /logger failed/);
  process.env.EASY_AGENT_MAX_RETRIES = "5";
  assert.equal(getMaxRetries(), 5, "no harness installed after a failed bootstrap");
  process.env.EASY_AGENT_MAX_RETRIES = "3";
  await writeJson(path.join(cwd, ".easy-agent", "settings.json"), {});
  resetSettingsCache();

  const runtime = await createAgentRuntime({ cwd, services: false, logger: { warn() {}, error() {} } });
  try {
    assert.equal(activeHarness().values["features.maxRetries"]!.source, "environment");
    process.env.EASY_AGENT_MAX_RETRIES = "7";
    process.env.MAX_THINKING_TOKENS = "1024";
    assert.equal(getMaxRetries(), 3, "read when the runtime started");
    assert.deepEqual(thinking.buildDefaultThinkingConfig(), { type: "disabled" });
    assert.equal(thinking.getSessionEffortLevel(), "medium");
    const session = await runtime.createSession({ model: "fixture-model", persist: false });
    const state = session.getState();
    assert.deepEqual([state.thinking, state.effort], [{ type: "disabled" }, "medium"]);
    await session.close();
  } finally {
    await runtime.dispose();
  }
  assert.equal(getMaxRetries(), 7, "after dispose, the process environment again");
  for (const name of ENV_NAMES) delete process.env[name];
  await writeJson(path.join(home, ".easy-agent", "settings.json"), {});
  resetSettingsCache();
});

await check("a runtime applies edited settings files to new sessions and to the next request", async () => {
  const { createAgentRuntime } = await import("../sdk/index.js");
  const { createAnthropicFixture } = await import("./fixtures/anthropicFixture.js");
  const fixture = createAnthropicFixture();
  await fixture.start();
  const userSettings = path.join(home, ".easy-agent", "settings.json");
  const { FIXTURE_MODEL } = await import("./fixtures/anthropicFixture.js");
  for (const name of ENV_NAMES) delete process.env[name];
  process.env.ANTHROPIC_AUTH_TOKEN = "test-token";
  process.env.EASY_AGENT_DISABLE_HOOKS = "1";
  process.env.ANTHROPIC_MODEL = "env-model";
  await writeJson(userSettings, { model: FIXTURE_MODEL, alwaysThinkingEnabled: false });
  resetSettingsCache();

  const runtime = await createAgentRuntime({ cwd, services: false, logger: { warn() {}, error() {} } });
  const thinkingSent = () => (fixture.requests.at(-1)?.body.thinking as { type?: string } | undefined)?.type;
  try {
    assert.equal(await runtime.resolveModel(), FIXTURE_MODEL);
    const session = await runtime.createSession({ persist: false });
    fixture.script([
      { kind: "text", text: "one" },
      { kind: "text", text: "two" },
    ]);
    await session.send("first");
    assert.equal(thinkingSent(), undefined, "alwaysThinkingEnabled: false");

    await writeJson(userSettings, { model: "edited-model", alwaysThinkingEnabled: true });
    process.env.ANTHROPIC_MODEL = "changed-after-start";
    await session.send("second");
    assert.equal(thinkingSent(), "adaptive", "the next request reads the edited file");
    assert.equal(fixture.requests.at(-1)?.body.model, FIXTURE_MODEL, "an open session keeps its model");
    assert.equal(harnessValue(await runtime.getHarness(), "features.thinking"), true);
    await session.close();

    const next = await runtime.createSession({ persist: false });
    assert.equal(next.getState().model, "edited-model", "a new session uses the edited model");
    await next.close();

    await writeJson(userSettings, {});
    assert.equal(await runtime.resolveModel(), "env-model", "ANTHROPIC_MODEL as it was when the runtime started");
  } finally {
    await runtime.dispose();
    await fixture.close();
    for (const name of [...ENV_NAMES, "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "EASY_AGENT_DISABLE_HOOKS"]) {
      delete process.env[name];
    }
    await writeJson(userSettings, {});
    resetSettingsCache();
  }
});

await check("the Auto Mode classifier uses the Agent's classifier role over the session's model", async () => {
  const { createAnthropicFixture } = await import("./fixtures/anthropicFixture.js");
  const { resetClient } = await import("../services/api/client.js");
  const { classifyAutoModeAction } = await import("../permissions/autoClassifier.js");
  const fixture = createAnthropicFixture();
  await fixture.start();
  resetClient();
  process.env.ANTHROPIC_AUTH_TOKEN = "test-token";
  const action = { messages: [], toolName: "Bash", toolInput: { command: "ls" }, allowRules: [], denyRules: [] };
  try {
    fixture.script(Array.from({ length: 4 }, () => ({ kind: "text" as const, text: "{}" })));
    await classifyAutoModeAction({ ...action, model: "session-model" });
    installHarness(resolve({ env: { EASY_AGENT_AUTO_MODE_MODEL: "judge" } }));
    await classifyAutoModeAction({ ...action, model: "session-model" });
    installHarness(
      resolve({ name: "strict", user: { harnesses: { strict: { model: { roles: { classifier: "spec-judge" } } } } } }),
    );
    await classifyAutoModeAction({ ...action, model: "session-model" });
    uninstallHarness();
    process.env.ANTHROPIC_MODEL = "main-model";
    await classifyAutoModeAction(action);
    assert.deepEqual(
      fixture.requests.map((request) => request.body.model),
      ["session-model", "judge", "spec-judge", "main-model"],
      "without a role or a session model, the Agent's main model",
    );
  } finally {
    uninstallHarness();
    await fixture.close();
    resetClient();
    for (const name of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"]) delete process.env[name];
  }
});

// ─── Component ids, comparison, views, and the CLI ─────────────────────

const { componentId, listBuiltInComponents, PROMPT_SECTIONS, CONTEXT_SOURCES } = await import(
  "../harness/components.js"
);
const { diffHarnesses } = await import("../harness/diff.js");
const { formatHarness, formatHarnessDiff } = await import("../harness/format.js");
const { harnessTarget } = await import("../harness/target.js");
const { execFile } = await import("node:child_process");

console.log("Components, comparison, and views");

await check("built-in components have unique, stable ids in the inventory's format", () => {
  const first = listBuiltInComponents();
  const ids = first.map((component) => component.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  assert.deepEqual(
    listBuiltInComponents().map((component) => component.id),
    ids,
    "ids are the same on every call",
  );
  for (const expected of ["tool:Read", "tool:Bash", "prompt_section:identity", "prompt_section:instructions"]) {
    assert.ok(ids.includes(expected), expected);
  }
  for (const section of PROMPT_SECTIONS) assert.ok(ids.includes(`prompt_section:${section.name}`));
  for (const source of CONTEXT_SOURCES) assert.ok(ids.includes(`context_source:${source.name}`));
  assert.ok(first.every((component) => component.source === "built-in"));
  for (const source of CONTEXT_SOURCES) {
    assert.ok(
      HARNESS_KEYS.some((key) => key.path === source.specKey),
      `${source.specKey} is a harness key`,
    );
  }
  assert.equal(componentId.skill("project", "review"), "skill:project:review");
  assert.equal(componentId.mcpServer("echo"), "mcp_server:echo");
  assert.equal(componentId.hookPrefix("user", "PreToolUse"), "hook:user:PreToolUse");
  assert.equal(componentId.memoryRule(), "rule:memory");
});

await check("diffHarnesses lists changed values only, in key order", () => {
  const a = resolve({ user: { model: "m1", harnesses: { b: { model: { main: "m2" }, outputStyle: "Learning" } } } });
  const b = resolve({
    name: "b",
    user: { model: "m1", harnesses: { b: { model: { main: "m2" }, outputStyle: "Learning" } } },
  });
  const diff = diffHarnesses(a, b);
  assert.deepEqual(
    diff.differences.map((difference) => difference.path),
    ["model.main", "outputStyle"],
  );
  assert.deepEqual(diff.differences[0]?.a, { value: "m1", source: "user", detail: "model" });
  assert.deepEqual(diff.differences[0]?.b, { value: "m2", source: "harness", detail: "b" });
  assert.deepEqual(diffHarnesses(a, a).differences, []);
  assert.match(formatHarnessDiff(diff), /^default → b\n {2}model\.main\n {4}- "m1" \(user settings: model\)/);
  assert.match(formatHarnessDiff(diffHarnesses(a, a)), /No differences\./);
});

await check("the text view marks overrides, ignored values, and keys not applied yet", () => {
  const resolved = resolve({
    name: "reviewer",
    workspaceTrusted: false,
    user: { harnesses: { reviewer: { outputStyle: "Learning", tools: { exclude: ["WebFetch"] } } } },
    layers: [{ source: "project", path: "/p", raw: { allow: ["Write"] } }],
  });
  const text = formatHarness(resolved, listBuiltInComponents());
  assert.match(text, /^Agent: reviewer \(built-in default → reviewer\)\nHash: [0-9a-f]{16}\n/);
  assert.match(text, /exclude +\["WebFetch"\] {2}← Agent "reviewer" {2}\[not applied yet\]/);
  assert.match(text, /ignored project settings: allow \["Write"\]: workspace is not trusted/);
  assert.match(text, /\nBuilt-in components\n {2}tool +tool:Read, /);
  assert.match(text, /\n {2}context_source +context_source:agent_md, /);

  const trusted = resolve({
    name: "reviewer",
    workspaceTrusted: true,
    user: { harnesses: { reviewer: { outputStyle: "Learning" } } },
    layers: [{ source: "project", path: "/p", raw: { outputStyle: "Concise" } }],
  });
  assert.match(
    formatHarness(trusted),
    /outputStyle +"Concise" {2}← project settings: outputStyle {2}\[overrides Agent "reviewer": "Learning"\]/,
  );
});

await check("an argument is a name, or a spec file when it looks like a path", async () => {
  assert.deepEqual(await harnessTarget("reviewer", cwd), { name: "reviewer" });
  await writeFile(path.join(cwd, "ops.json"), JSON.stringify({ features: { maxTurns: 3 } }));
  assert.deepEqual(await harnessTarget("ops.json", cwd), {
    spec: { features: { maxTurns: 3 } },
    file: path.join(cwd, "ops.json"),
  });
  await writeFile(path.join(cwd, "broken.json"), "{ nope");
  await assert.rejects(harnessTarget("./broken.json", cwd), /is not valid JSON/);
  await assert.rejects(harnessTarget("./missing.json", cwd), /cannot read/);
});

const CLI = path.join(import.meta.dirname, "..", "entrypoint", "cli.ts");
function runCli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), CLI, "harness", ...args],
      { cwd, env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" }, timeout: 60_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolvePromise({ code, stdout, stderr });
      },
    );
  });
}

await check("eagent harness show and diff print the views and exit non-zero on errors", async () => {
  await writeJson(path.join(home, ".easy-agent", "settings.json"), {
    harnesses: { reviewer: { model: { main: "review-model" } } },
  });
  await writeJson(path.join(cwd, ".easy-agent", "settings.json"), {});
  await writeJson(path.join(cwd, ".easy-agent", "settings.local.json"), {});

  const shown = await runCli("show", "--json");
  assert.equal(shown.code, 0, shown.stderr);
  const parsed = JSON.parse(shown.stdout) as { harness: ResolvedHarness; components: Array<{ id: string }> };
  assert.equal(parsed.harness.name, "default");
  assert.equal(parsed.harness.values["permissions.mode"]?.value, "default");
  assert.ok(parsed.components.some((component) => component.id === "tool:Read"));

  const text = await runCli("show", "reviewer");
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /^Agent: reviewer/);
  assert.match(text.stdout, /main +"review-model" {2}← Agent "reviewer"/);

  const ghost = await runCli("show", "ghost");
  assert.equal(ghost.code, 1);
  assert.match(ghost.stdout, /Errors:\n {2}Agent "ghost": no Agent named "ghost"/);

  const diff = await runCli("diff", "default", "./ops.json");
  assert.equal(diff.code, 0, diff.stderr);
  assert.match(
    diff.stdout,
    /^default → \(inline\)\n {2}features\.maxTurns\n {4}- unset \(built-in\)\n {4}\+ 3 \(Agent "\(inline\)"\)/,
  );

  const usage = await runCli("bogus");
  assert.equal(usage.code, 1);
  assert.match(usage.stderr, /Usage:\n {2}eagent harness show/);
});

console.log(`\nHarness resolver: ${passed} passed, 0 failed.`);
setFlagSettings(null);
await rm(root, { recursive: true, force: true }).catch(() => {});
