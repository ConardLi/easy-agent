import { expect, test } from "@playwright/test";
import { agentFromConfig, writesFor } from "../../src/renderer/features/settings/agentSettings";
import { changeProviderConnection, modelsMapFor, providersFromConfig, reconcileProviders } from "../../src/renderer/features/settings/providers";
import type { ConfigSnapshot } from "../../src/shared/agent";

function config(user: Record<string, unknown>, project: Record<string, unknown> = {}, trusted = true): ConfigSnapshot {
  const source = (name: string, values: Record<string, unknown>, applied = true) => ({ source: name, path: `/${name}.json`, exists: true, applied, values });
  return {
    workspaceTrusted: trusted,
    sources: [source("user", user), source("project", project, trusted), source("local", {}, trusted), source("flag", {}), source("policy", {})],
    effective: {
      maxTurns: { value: user.maxTurns ?? 200, source: user.maxTurns ? "user" : "default", sources: [], reload: "next turn" },
    },
    models: { profiles: {}, defaultModel: null, warnings: [] },
    userOnlyKeys: ["mode", "autoMode"],
  } as unknown as ConfigSnapshot;
}

test("settings read rules and env per file, and the sandbox field by field", () => {
  const { agent, sources } = agentFromConfig(
    config(
      { maxTurns: 50, deny: ["WebFetch"], env: { A: "1" }, sandbox: { enabled: true, network: { allowedDomains: ["a.com"] } } },
      { allow: ["Edit"], sandbox: { network: { allowedDomains: ["b.com"] } } },
    ),
  );
  expect(agent.maxTurns).toBe(50);
  expect(sources.maxTurns).toBe("user");
  expect(agent.rules).toEqual([
    { rule: "WebFetch", effect: "deny", scope: "user" },
    { rule: "Edit", effect: "allow", scope: "project" },
  ]);
  expect(agent.env).toEqual([{ key: "A", value: "1", scope: "user" }]);
  expect(agent.sandbox.enabled).toBe(true);
  expect(agent.sandbox.allowedDomains).toEqual(["a.com", "b.com"]);
  expect(sources["sandbox.allowedDomains"]).toBe("project");
});

test("an edit writes only the keys it changed, for the file being edited", () => {
  const cfg = config({ deny: ["WebFetch"], sandbox: { enabled: true } }, { allow: ["Edit"] });
  const { agent } = agentFromConfig(cfg);
  const next = {
    ...agent,
    rules: [...agent.rules, { rule: "Bash(rm:*)", effect: "deny" as const, scope: "user" as const }],
    sandbox: { ...agent.sandbox, allowedDomains: ["c.com"] },
  };
  expect(writesFor(cfg, "user", agent, next, ["rules", "sandbox.allowedDomains"])).toEqual([
    { key: "deny", value: ["WebFetch", "Bash(rm:*)"] },
    { key: "sandbox", value: { enabled: true, network: { allowedDomains: ["c.com"] } } },
  ]);
  expect(writesFor(cfg, "project", agent, { ...agent, statusLine: "" }, ["statusLine"])).toEqual([{ key: "statusLine", value: null }]);
});

test("profiles group into providers and write back unchanged", () => {
  const models = {
    "deepseek-v3.2": {
      protocol: "openai-chat",
      model: "deepseek-chat",
      baseURL: "https://api.deepseek.com/v1",
      apiKey: "${DEEPSEEK_API_KEY}",
      maxTokens: 8192,
    },
    "deepseek-reasoner": { protocol: "openai-chat", model: "deepseek-reasoner", baseURL: "https://api.deepseek.com/v1", apiKey: "${DEEPSEEK_API_KEY}" },
    gw: { protocol: "openai-chat", model: "gpt-5", baseURL: "https://gw.example.com/v1", apiKey: "${EASY_AGENT_KEY_GW}" },
  };
  const providers = providersFromConfig(config({ models }), { gw: "sk-••••1234" });
  expect(providers.map((p) => [p.id, p.templateId, p.models.length, p.key.kind])).toEqual([
    ["deepseek", "deepseek", 2, "env"],
    ["custom-gw_example_com", "custom", 1, "keychain"],
  ]);
  expect(providers[0]?.models[0]?.name).toBe("DeepSeek V3.2");
  expect(modelsMapFor(providers, "user")).toEqual(models);

  // Fields the page does not edit survive a save.
  const counted = {
    gateway: { protocol: "anthropic", model: "claude-sonnet-4-6", baseURL: "https://gw.example.com", protocolOptions: { anthropic: { countTokens: true } } },
  };
  expect(modelsMapFor(providersFromConfig(config({ models: counted }), {}), "user")).toEqual(counted);

  // A provider whose endpoint changed keeps its identity.
  const moved = providersFromConfig(config({ models: { ...models, "deepseek-v3.2": { ...models["deepseek-v3.2"], baseURL: "http://localhost:9/v1" } } }), {});
  const kept = reconcileProviders(providers, moved);
  expect(kept.find((p) => p.models.some((m) => m.handle === "deepseek-v3.2"))?.id).toBe("deepseek");
});

test("profile authentication, helper, capabilities and protocol options survive a desktop save", () => {
  const models = {
    gateway: {
      protocol: "openai-responses",
      model: "gateway-model",
      baseURL: "https://gw.example.com/v1",
      apiKey: { helper: "vault read key" },
      authentication: { type: "header", name: "X-Gateway", prefix: "Key " },
      capabilities: { reasoning: true, effort: true, contextWindow: 120000, pricing: { input: 2, output: 8 } },
      protocolOptions: { "openai-responses": { promptCacheKey: false, reasoningOff: "none" } },
      headers: { "X-Project": "test" },
    },
    local: { protocol: "openai-chat", model: "local-model", baseURL: "http://localhost:8000/v1", authentication: { type: "none" } },
  };
  const providers = providersFromConfig(config({ models }), {});
  expect(providers[0]?.key.kind).toBe("helper");
  expect(modelsMapFor(providers, "user")).toEqual(models);
  expect(providers.find((p) => p.models[0]?.handle === "local")?.authentication?.type).toBe("none");
});

test("default and reasoning edits write only canonical fields and preserve the saved budget", () => {
  const cfg = config({ reasoning: { mode: "auto", budgetTokens: 4096 } });
  const { agent } = agentFromConfig(cfg);
  const next = { ...agent, defaultModel: "gateway", reasoningMode: "off" as const, effortLevel: "high" as const };
  expect(writesFor(cfg, "user", agent, next, ["defaultModel", "reasoningMode", "effortLevel"])).toEqual([
    { key: "model", value: "gateway" },
    { key: "reasoning", value: { mode: "off", budgetTokens: 4096, effort: "high" } },
  ]);
});

test("the editor does not invent a protocol or a known window for incomplete profiles", () => {
  const providers = providersFromConfig(
    config({
      models: {
        invalid: { model: "no-protocol" },
        custom: { protocol: "gemini", model: "unlisted" },
      },
    }),
    {},
  );
  expect(providers.flatMap((p) => p.models.map((m) => m.handle))).toEqual(["custom"]);
  expect(providers[0]?.models[0]?.contextWindow).toBe(32000);
  expect(providers[0]?.models[0]?.contextWindowSource).toBe("estimate");
  expect(providers[0]?.models[0]?.price).toBeUndefined();
});

test("changing a connection clears its credential and incompatible protocol declarations", () => {
  const [provider] = providersFromConfig(
    config({
      models: {
        gateway: {
          protocol: "anthropic",
          model: "custom",
          baseURL: "https://old.example",
          apiKey: "${SAVED_KEY}",
          authentication: { type: "header", name: "X-Gateway" },
          capabilities: { reasoning: true, adaptiveReasoning: true, contextWindow: 200000 },
          protocolOptions: { anthropic: { countTokens: true } },
          headers: { "X-Endpoint": "old" },
        },
      },
    }),
    {},
  );
  expect(changeProviderConnection(provider!, provider!.protocol, provider!.baseURL)).toBe(provider);
  const changed = changeProviderConnection(provider!, "openai-chat", "https://new.example/v1");
  expect(changed.key.kind).toBe("none");
  expect(changed.protocolOptions).toBeUndefined();
  expect(changed.headers).toEqual([]);
  expect(changed.models[0]?.capabilityOverrides).toBeUndefined();
  const profile = modelsMapFor([changed], "user").gateway;
  expect(profile).toEqual({
    protocol: "openai-chat",
    model: "custom",
    baseURL: "https://new.example/v1",
    authentication: { type: "default" },
  });
});
