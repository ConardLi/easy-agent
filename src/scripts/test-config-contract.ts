import assert from "node:assert/strict";
import { test } from "node:test";
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
