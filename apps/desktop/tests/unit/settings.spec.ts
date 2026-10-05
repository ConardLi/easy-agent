import { expect, test } from "@playwright/test";
import { agentFromConfig, writesFor } from "../../src/renderer/features/settings/agentSettings";
import { modelsMapFor, providersFromConfig, reconcileProviders } from "../../src/renderer/features/settings/providers";
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

  // A provider whose endpoint changed keeps its identity.
  const moved = providersFromConfig(config({ models: { ...models, "deepseek-v3.2": { ...models["deepseek-v3.2"], baseURL: "http://localhost:9/v1" } } }), {});
  const kept = reconcileProviders(providers, moved);
  expect(kept.find((p) => p.models.some((m) => m.handle === "deepseek-v3.2"))?.id).toBe("deepseek");
});
