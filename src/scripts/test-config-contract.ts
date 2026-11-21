import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateLegacyEnvironment, migrateSettings } from "../config/migration.js";
import { ModelProfileSchema, profileValidationErrors } from "../config/modelSchema.js";
import { configBoolean, configEnum, configInteger, resolveEnvironmentReferences } from "../config/values.js";

test("all canonical boolean spellings have explicit false semantics", () => {
  for (const value of ["0", "false", "NO", " off "]) assert.equal(configBoolean(value, "flag"), false);
  for (const value of ["1", "true", "YES", " on "]) assert.equal(configBoolean(value, "flag"), true);
  assert.equal(configBoolean("  ", "flag"), undefined);
  assert.throws(() => configBoolean("secret-invalid-value", "flag"), {
    message: "flag: expected 1/0, true/false, yes/no, or on/off.",
  });
});

test("integer parsing never accepts a prefix, decimal, exponent, or unsafe value", () => {
  assert.equal(configInteger("0", "retries", 0), 0);
  assert.equal(configInteger(" 42 ", "tokens"), 42);
  for (const value of ["10ms", "1.5", "1e3", "-1", "Infinity", "9007199254740992", "0x10"]) {
    assert.throws(() => configInteger(value, "tokens"));
  }
  assert.throws(() => configInteger("0", "tokens"));
  assert.throws(() => configEnum("secret-protocol", "protocol", ["anthropic", "gemini"]));
});

test("explicit credential references must resolve and errors never echo values", () => {
  assert.equal(resolveEnvironmentReferences("${CUSTOM_KEY}", { CUSTOM_KEY: " value " }, "apiKey"), "value");
  assert.throws(() => resolveEnvironmentReferences("${CUSTOM_KEY}", {}, "apiKey"), /CUSTOM_KEY is unset/);
  assert.throws(
    () => resolveEnvironmentReferences("${CUSTOM_KEY}", { CUSTOM_KEY: " " }, "apiKey"),
    /CUSTOM_KEY is unset/,
  );
});

test("all protocols require an explicit protocol and upstream model", () => {
  for (const protocol of ["anthropic", "openai-chat", "openai-responses", "gemini"]) {
    assert.equal(ModelProfileSchema.safeParse({ protocol, model: "gateway-model", apiKey: "${KEY}" }).success, true);
  }
  assert.equal(ModelProfileSchema.safeParse({ model: "claude-sonnet-4-6" }).success, false);
  assert.equal(ModelProfileSchema.safeParse({ protocol: "gemini" }).success, false);
  const errors = profileValidationErrors({ protocol: "secret-value", model: "x" }, "models.example");
  assert.equal(errors.join("").includes("secret-value"), false);
});

test("authentication policy owns the single key and headers cannot bypass it", () => {
  const profile = { protocol: "anthropic", model: "gateway-model", apiKey: "${KEY}" };
  for (const header of ["Authorization", "x-api-key", "X-Goog-Api-Key", "Cookie", "X-Auth-Token"]) {
    assert.equal(ModelProfileSchema.safeParse({ ...profile, headers: { [header]: "secret" } }).success, false);
  }
  assert.equal(
    ModelProfileSchema.safeParse({
      ...profile,
      authentication: { type: "header", name: "X-Gateway-Credential", prefix: "Bearer " },
    }).success,
    true,
  );
  assert.equal(
    ModelProfileSchema.safeParse({
      ...profile,
      authentication: { type: "header", name: "X-Gateway-Credential" },
      headers: { "x-gateway-credential": "second-secret" },
    }).success,
    false,
  );
  assert.equal(ModelProfileSchema.safeParse({ ...profile, authentication: { type: "none" } }).success, false);
  assert.equal(
    ModelProfileSchema.safeParse({
      protocol: "openai-chat",
      model: "local",
      authentication: { type: "none" },
    }).success,
    true,
  );
});

test("protocol options and output bounds reject cross-protocol or impossible configurations", () => {
  const profile = { protocol: "gemini", model: "gateway-model" };
  assert.equal(
    ModelProfileSchema.safeParse({
      ...profile,
      protocolOptions: { anthropic: { countTokens: true } },
    }).success,
    false,
  );
  assert.equal(
    ModelProfileSchema.safeParse({
      ...profile,
      maxTokens: 4096,
      capabilities: { contextWindow: 4096 },
    }).success,
    false,
  );
  assert.equal(
    ModelProfileSchema.safeParse({
      ...profile,
      maxTokens: 4096,
      capabilities: { maxOutputTokens: 2048 },
    }).success,
    false,
  );
});

test("legacy credentials migrate as one key with a declared protocol and preserved model", () => {
  for (const credentials of [
    { ANTHROPIC_API_KEY: "key-a" },
    { ANTHROPIC_AUTH_TOKEN: "key-a" },
    { ANTHROPIC_API_KEY: "key-a", ANTHROPIC_AUTH_TOKEN: "key-a" },
  ]) {
    const result = migrateLegacyEnvironment({ ...credentials, ANTHROPIC_MODEL: "original-model" });
    assert.equal(result.env.EASY_AGENT_API_KEY, "key-a");
    assert.equal(result.env.EASY_AGENT_PROTOCOL, "anthropic");
    assert.equal(result.env.EASY_AGENT_MODEL, "original-model");
    assert.equal(
      result.notices.some((notice) => notice.level === "error"),
      false,
    );
    assert.equal(JSON.stringify(result.notices).includes("key-a"), false);
  }
  assert.equal(migrateLegacyEnvironment({}).env.EASY_AGENT_MODEL, undefined);
});

test("conflicting legacy keys stop migration only when that connection is needed", () => {
  const legacy = { ANTHROPIC_API_KEY: "first-secret", ANTHROPIC_AUTH_TOKEN: "second-secret" };
  const conflict = migrateLegacyEnvironment(legacy);
  assert.equal(
    conflict.notices.some((notice) => notice.level === "error"),
    true,
  );
  assert.equal(conflict.env.EASY_AGENT_API_KEY, undefined);
  assert.equal(JSON.stringify(conflict.notices).includes("first-secret"), false);
  const canonical = migrateLegacyEnvironment({ ...legacy, EASY_AGENT_PROFILE: "production" });
  assert.equal(
    canonical.notices.some((notice) => notice.level === "error"),
    false,
  );
  assert.equal(canonical.env.EASY_AGENT_PROTOCOL, undefined);
  assert.equal(canonical.env.EASY_AGENT_API_KEY, undefined);
  const mixed = migrateLegacyEnvironment({ ANTHROPIC_MODEL: "old", EASY_AGENT_API_KEY: "new-secret" });
  assert.equal(
    mixed.notices.some((notice) => notice.level === "error"),
    true,
  );
});

test("old reasoning conflicts preserve actual prohibition and canonical values win", () => {
  const result = migrateLegacyEnvironment({
    MAX_THINKING_TOKENS: "1024",
    CLAUDE_CODE_DISABLE_THINKING: "false",
  });
  assert.equal(result.env.EASY_AGENT_REASONING, "off");
  assert.equal(migrateLegacyEnvironment({ MAX_THINKING_TOKENS: "0" }).env.EASY_AGENT_REASONING, "off");
  assert.equal(
    migrateLegacyEnvironment({
      MAX_THINKING_TOKENS: "0",
      EASY_AGENT_REASONING: "auto",
    }).env.EASY_AGENT_REASONING,
    "auto",
  );
  assert.equal(migrateLegacyEnvironment({ MAX_THINKING_TOKENS: "1024oops" }).notices[0]?.level, "error");
});

test("settings migration is idempotent and conservatively unions rule exclusions", () => {
  const input = {
    model: "main",
    defaultModel: "ignored",
    claudeMdExcludes: ["old-rule"],
    agentMdExcludes: ["new-rule"],
    alwaysThinkingEnabled: true,
    effortLevel: "high",
    models: { main: { model: "claude-sonnet-4-6", countTokens: false, headers: { "x-project": "kept" } } },
    harnesses: { careful: { features: { thinking: true, thinkingInRequests: false, thinkingBudget: 2000 } } },
  };
  const migrated = migrateSettings(input);
  assert.equal(migrated.value.model, "main");
  assert.equal("defaultModel" in migrated.value, false);
  assert.deepEqual(migrated.value.agentMdExcludes, ["new-rule", "old-rule"]);
  assert.deepEqual(migrated.value.reasoning, { mode: "auto", effort: "high" });
  assert.deepEqual((migrated.value.harnesses as Record<string, { reasoning: unknown }>).careful?.reasoning, {
    mode: "off",
    budgetTokens: 2000,
  });
  const main = (migrated.value.models as Record<string, unknown>).main;
  assert.equal(ModelProfileSchema.safeParse(main).success, true);
  assert.deepEqual((main as { headers: unknown }).headers, { "x-project": "kept" });
  const again = migrateSettings(migrated.value);
  assert.equal(again.changed, false);
  assert.deepEqual(again.notices, []);
  assert.equal(input.defaultModel, "ignored");
});

test("helper migration binds one source and never broadcasts credentials", () => {
  const result = migrateSettings({
    model: "main",
    apiKeyHelper: "credential-command",
    models: { main: { protocol: "openai-chat", model: "gateway" }, other: { protocol: "gemini", model: "other" } },
  });
  assert.equal("apiKeyHelper" in result.value, false);
  const profiles = result.value.models as Record<string, { apiKey?: unknown }>;
  assert.deepEqual(profiles.main?.apiKey, { helper: "credential-command" });
  assert.equal(profiles.other?.apiKey, undefined);
  assert.equal(migrateSettings({ apiKeyHelper: "command", models: {} }).notices[0]?.level, "error");
});

test("legacy authentication headers migrate only when there is one unambiguous source", () => {
  const input = {
    models: {
      main: { protocol: "openai-chat", model: "gateway", headers: { Authorization: "Bearer ${KEY}", "x-app": "kept" } },
    },
  };
  const migrated = migrateSettings(input);
  const profile = (migrated.value.models as Record<string, unknown>).main;
  assert.equal(ModelProfileSchema.safeParse(profile).success, true);
  assert.deepEqual(profile, {
    protocol: "openai-chat",
    model: "gateway",
    apiKey: "${KEY}",
    authentication: { type: "header", name: "Authorization", prefix: "Bearer " },
    headers: { "x-app": "kept" },
  });
  const conflict = migrateSettings({
    models: {
      main: {
        protocol: "anthropic",
        model: "gateway",
        headers: { Authorization: "Bearer secret", "x-api-key": "secret" },
      },
    },
  });
  assert.equal(conflict.notices[0]?.level, "error");
  assert.equal(JSON.stringify(conflict.notices).includes("secret"), false);
});
