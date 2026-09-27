import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { QueryEngine, type QueryEngineEvent } from "../core/queryEngine.js";
import { setFlagSettings } from "../config/sources.js";
import { resetGlobalStateCache, trustProjectForSession } from "../config/globalState.js";
import { MIN_NODE_MAJOR } from "../version.js";

async function commandOutput(engine: QueryEngine, command: string): Promise<string> {
  const output: string[] = [];
  const events = engine.submitMessage(command);
  while (true) {
    const next = await events.next();
    if (next.done) break;
    const event = next.value as QueryEngineEvent;
    if (event.type === "command") output.push(event.message);
  }
  return output.join("\n");
}

const root = await mkdtemp(path.join(os.tmpdir(), "easy-agent-user-output-"));
const cwd = path.join(root, "project");
const home = path.join(root, "home");
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalToken = process.env.ANTHROPIC_AUTH_TOKEN;
const originalApiKey = process.env.ANTHROPIC_API_KEY;
const originalFetch = globalThis.fetch;

try {
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(home, { recursive: true })]);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ANTHROPIC_AUTH_TOKEN = "unrelated-anthropic-token";
  delete process.env.ANTHROPIC_API_KEY;
  resetGlobalStateCache();
  await trustProjectForSession(cwd);
  setFlagSettings({
    models: {
      active: { protocol: "openai-chat", model: "gpt-contract" },
      unrelated: { protocol: "gemini", model: "gemini-contract", apiKey: "unrelated-profile-key" },
    },
  });
  const probedUrls: string[] = [];
  globalThis.fetch = (async (url) => {
    probedUrls.push(String(url));
    return new Response(null, { status: 401 });
  }) as typeof fetch;

  const engine = new QueryEngine({
    model: "active",
    toolContext: { cwd, sessionId: "user-output-contract" },
    permissionMode: "default",
    permissionSettings: { allow: [], deny: [], mode: "default" },
  });

  const tasks = await commandOutput(engine, "/tasks");
  assert.doesNotMatch(tasks, /Task V2|TodoWrite V1|Stage \d+/);
  assert.match(tasks, /persistent task list/);

  const doctor = await commandOutput(engine, "/doctor");
  assert.match(doctor, new RegExp(`Node\\.js .*\\(requires ${MIN_NODE_MAJOR}\\+\\)`));
  assert.match(doctor, /Active model: active → gpt-contract/);
  assert.match(doctor, /Provider: openai-chat/);
  assert.match(doctor, /Profile: active \(configuration: flag; selection: runtime default\)/);
  assert.match(doctor, /Endpoint: https:\/\/api\.openai\.com\/…/);
  assert.match(doctor, /No API auth configured for the active openai-chat provider/);
  assert.doesNotMatch(doctor, /API auth configured \(ANTHROPIC_AUTH_TOKEN\)/);
  assert.doesNotMatch(doctor, /unrelated-profile-key|unrelated-anthropic-token/);

  setFlagSettings({
    model: "configured",
    models: {
      configured: {
        protocol: "gemini",
        model: "gemini-configured",
        baseURL: "https://example.invalid/v1beta?secret=hidden",
        apiKey: "configured-profile-key",
      },
    },
  });
  const configured = new QueryEngine({
    model: "configured",
    toolContext: { cwd, sessionId: "configured-profile-contract" },
    permissionMode: "default",
    permissionSettings: { allow: [], deny: [], mode: "default" },
  });
  const configuredDoctor = await commandOutput(configured, "/doctor");
  assert.match(configuredDoctor, /Active model: configured → gemini-configured/);
  assert.match(configuredDoctor, /Provider: gemini/);
  assert.match(configuredDoctor, /Profile: configured \(configuration: flag; selection: flag\)/);
  assert.match(configuredDoctor, /API auth configured \(active profile, source: flag\)/);
  assert.match(configuredDoctor, /Endpoint: https:\/\/example\.invalid\/… \[query redacted\]/);
  assert.doesNotMatch(configuredDoctor, /configured-profile-key|secret=hidden/);
  assert.equal(probedUrls.at(-1), "https://example.invalid/v1beta", "probe removes secret query");
  assert.match(configuredDoctor, /Endpoint reachable \(HTTP 401\)/, "401 proves reachability, not authentication");
  assert.match(configuredDoctor, /authentication has not been verified/);
  await commandOutput(configured, "/model raw-model");
  const switched = await commandOutput(configured, "/doctor");
  assert.match(switched, /Provider: anthropic/);
  assert.match(switched, /Profile: raw model name \(source: session\)/);
  setFlagSettings({ models: { header: { protocol: "openai-responses", model: "header-model", headers: { Authorization: "Bearer header-secret" } } } });
  const headerEngine = new QueryEngine({ model: "header", toolContext: { cwd } });
  const headerDoctor = await commandOutput(headerEngine, "/doctor");
  assert.match(headerDoctor, /active profile headers, source: flag/);
  assert.doesNotMatch(headerDoctor, /header-secret/);

  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.engines.node, `>=${MIN_NODE_MAJOR}`);
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = "sdk-env-key";
  setFlagSettings(null);
  const raw = new QueryEngine({ model: "raw-model", toolContext: { cwd } });
  const apiKeyDoctor = await commandOutput(raw, "/doctor");
  assert.match(apiKeyDoctor, /API auth configured \(ANTHROPIC_API_KEY\)/);
  assert.doesNotMatch(apiKeyDoctor, /sdk-env-key/);
  const nodeDescriptor = Object.getOwnPropertyDescriptor(process.versions, "node")!;
  Object.defineProperty(process.versions, "node", { ...nodeDescriptor, value: "20.0.0" });
  try {
    assert.match(await commandOutput(raw, "/doctor"), /✗ Node\.js .*upgrade to v22 or newer/);
  } finally {
    Object.defineProperty(process.versions, "node", nodeDescriptor);
  }

  process.stdout.write("User output and active-provider diagnostics contract passed.\n");
} finally {
  setFlagSettings(null);
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
  else process.env.ANTHROPIC_AUTH_TOKEN = originalToken;
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalApiKey;
  resetGlobalStateCache();
  await rm(root, { recursive: true, force: true });
}
