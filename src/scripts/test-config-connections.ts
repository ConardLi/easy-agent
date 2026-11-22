import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createRuntimeScope, runInRuntimeScope, disposeRuntimeScope } from "../state/runtimeScope.js";
import { installConfigurationEnvironment } from "../config/environment.js";
import { getAnthropicClientForProfile } from "../services/api/client.js";
import { collectViaProvider, prepareRequest } from "../services/api/providers/providerStream.js";
import { profileRequestHeaders } from "../services/api/providers/authentication.js";
import { resolveProfile, loadProfiles, getProfileBaseURL } from "../services/api/providers/profile.js";
import type { ModelProfile, ModelProtocol } from "../services/api/providers/profile.js";
import { effectiveModelMetadata } from "../config/modelMetadata.js";
import { resolveRequestReasoning } from "../services/api/providers/reasoning.js";
import { resolveHarnessFromInputs } from "../harness/resolve.js";
import { withHarness } from "../harness/active.js";
import { APIError } from "@anthropic-ai/sdk";
import { classifyAPIError, getUserFacingErrorMessage, toFriendlyError } from "../services/api/errors.js";
import { trustProjectForSession } from "../config/globalState.js";
import { resetSettingsCache } from "../config/sources.js";
import { validateDeclaredCapabilities } from "../services/api/providers/capabilities.js";
import { shouldSendPromptCacheKey } from "../services/api/providers/providerStream.js";

const emptyHarness = () => resolveHarnessFromInputs({ layers: [], workspaceTrusted: false, env: {} });

test("all four protocols send only their profile key, including custom and no-auth policies", async () => {
  const requests: { url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    requests.push({ url: request.url!, headers: request.headers, body: text ? JSON.parse(text) : {} });
    if (request.url?.includes("/messages")) {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          model: "fixture",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
      return;
    }
    response.setHeader("content-type", "text/event-stream");
    if (request.url?.includes("/chat/completions")) {
      response.end(
        `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    } else if (request.url?.includes("/responses")) {
      response.end(
        `event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "r1",
            status: "completed",
            output: [],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        })}\n\n`,
      );
    } else {
      response.end(
        `data: ${JSON.stringify({
          candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        })}\n\n`,
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const previous = {
    key: process.env.ANTHROPIC_API_KEY,
    token: process.env.ANTHROPIC_AUTH_TOKEN,
    url: process.env.ANTHROPIC_BASE_URL,
  };
  process.env.ANTHROPIC_API_KEY = "poison-legacy-key";
  process.env.ANTHROPIC_AUTH_TOKEN = "poison-legacy-token";
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";
  const scope = createRuntimeScope();
  try {
    await runInRuntimeScope(scope, async () => {
      installConfigurationEnvironment({});
      await withHarness(emptyHarness(), async () => {
        for (const protocol of ["anthropic", "openai-chat", "openai-responses", "gemini"] as ModelProtocol[]) {
          for (const policy of ["default", "header", "none"] as const) {
            const profile: ModelProfile = {
              id: protocol,
              protocol,
              model: "gateway-unknown",
              baseURL: `${endpoint}/v1/`,
              ...(policy !== "none" ? { apiKey: `key-${protocol}` } : {}),
              authentication:
                policy === "header"
                  ? { type: "header", name: "X-Gateway-Credential", prefix: "Key " }
                  : { type: policy },
            };
            if (protocol === "anthropic") {
              await getAnthropicClientForProfile(profile).messages.create({
                model: profile.model,
                messages: [{ role: "user", content: "ping" }],
                max_tokens: 1,
              });
            } else {
              await collectViaProvider(profile, { messages: [{ role: "user", content: "ping" }], maxTokens: 8 });
            }
            const captured = requests.at(-1)!;
            const auth = Object.fromEntries(
              Object.entries(captured.headers).filter(([key]) =>
                ["authorization", "x-api-key", "x-goog-api-key", "x-gateway-credential"].includes(key),
              ),
            );
            const name =
              protocol === "anthropic" ? "x-api-key" : protocol === "gemini" ? "x-goog-api-key" : "authorization";
            assert.deepEqual(
              auth,
              policy === "none"
                ? {}
                : policy === "header"
                  ? { "x-gateway-credential": `Key key-${protocol}` }
                  : { [name]: `${protocol.startsWith("openai") ? "Bearer " : ""}key-${protocol}` },
            );
            assert.equal(JSON.stringify(captured).includes("poison"), false);
            if (protocol === "anthropic") assert.equal(captured.url, "/v1/messages");
          }
        }
      });
    });
    assert.equal(requests.length, 12);
  } finally {
    await disposeRuntimeScope(scope);
    for (const [name, value] of Object.entries({
      ANTHROPIC_API_KEY: previous.key,
      ANTHROPIC_AUTH_TOKEN: previous.token,
      ANTHROPIC_BASE_URL: previous.url,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("provider errors keep their category without echoing credentials or secret URLs", () => {
  const profile: ModelProfile = {
    id: "private",
    protocol: "openai-chat",
    model: "custom",
    apiKey: "quoted-key-123",
    headers: { "X-Project": "private-header-value" },
  };
  const error = APIError.generate(
    403,
    { message: "x-api-key rejected" },
    "x-api-key quoted-key-123 private-header-value https://user:password@example.com/v1?token=hidden",
    new Headers(),
  );
  assert.equal(classifyAPIError(error), "permission_denied");
  const message = getUserFacingErrorMessage(error, "custom", profile);
  assert.match(message, /x-api-key/);
  assert.doesNotMatch(message, /quoted-key-123|private-header-value|user:password|token=hidden/);
  assert.doesNotMatch(
    toFriendlyError(error, "custom", profile).stack!,
    /quoted-key-123|private-header-value|token=hidden/,
  );
});

test("unknown capabilities are conservative, explicit unsupported intent errors and overrides work", () => {
  withHarness(emptyHarness(), () => {
    const unknown: ModelProfile = { id: "custom", protocol: "anthropic", model: "gateway-model", apiKey: "x" };
    assert.equal(effectiveModelMetadata(unknown).contextWindowSource, "estimate");
    assert.equal(effectiveModelMetadata(unknown).pricing, undefined);
    assert.equal(resolveRequestReasoning(unknown, 8000).enabled, false);
    assert.throws(() => resolveRequestReasoning(unknown, 8000, { type: "adaptive" }), /capabilities.reasoning/);
    assert.equal(
      resolveRequestReasoning({ ...unknown, capabilities: { reasoning: true } }, 8000, { type: "adaptive" }).enabled,
      true,
    );
    assert.throws(
      () =>
        resolveRequestReasoning({ ...unknown, capabilities: { reasoning: true } }, 8000, {
          type: "enabled",
          budgetTokens: 8000,
        }),
      /budget/,
    );
    const custom: ModelProfile = { ...unknown, protocol: "openai-responses" };
    assert.equal(prepareRequest(custom, { messages: [] }).body.reasoning, undefined);
    for (const name of [
      "claude-sonnet-4-6",
      "us.anthropic.claude-opus-4-7-v1:0",
      "publishers/anthropic/models/claude-sonnet-4-6@20260201",
    ]) {
      assert.equal(effectiveModelMetadata({ ...unknown, model: name }).adaptiveReasoning, true);
    }
    assert.equal(effectiveModelMetadata({ ...unknown, model: "claude-sonnet-4-20250514" }).adaptiveReasoning, false);
    assert.equal(effectiveModelMetadata({ ...unknown, model: "claude-haiku-4-6" }).adaptiveReasoning, false);
    assert.equal(effectiveModelMetadata({ ...unknown, model: "claude-sonnet-4-6" }).vision, true);
    assert.throws(
      () =>
        validateDeclaredCapabilities(
          { ...custom, capabilities: { tools: false } },
          {
            tools: [{ name: "Read" }],
            messages: [],
          },
        ),
      /disables tool calls/,
    );
    assert.throws(
      () =>
        validateDeclaredCapabilities(
          { ...custom, capabilities: { vision: false } },
          {
            messages: [
              {
                role: "user",
                content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }],
              },
            ],
          },
        ),
      /disables images/,
    );
    assert.equal(shouldSendPromptCacheKey({ ...custom, capabilities: { cache: false } }), false);
  });
});

test("profile resolution freezes environment, rejects missing IDs and never borrows another key", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eagent-config-resolution-"));
  const oldHome = process.env.HOME;
  const oldUserProfile = process.env.USERPROFILE;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  const scope = createRuntimeScope();
  try {
    await runInRuntimeScope(scope, async () => {
      const cwd = path.join(root, "workspace");
      await mkdir(path.join(root, ".easy-agent"), { recursive: true });
      await mkdir(path.join(cwd, ".easy-agent"), { recursive: true });
      const user = path.join(root, ".easy-agent", "settings.json");
      await writeFile(
        user,
        JSON.stringify({
          models: {
            selected: { protocol: "openai-chat", model: "upstream", apiKey: "${UNUSUAL_NAME}" },
          },
        }),
      );
      installConfigurationEnvironment({
        UNUSUAL_NAME: "original",
        EASY_AGENT_API_KEY: "other-key",
        EASY_AGENT_BASE_URL: "http://127.0.0.1:1",
      });
      const profile = await resolveProfile("selected", cwd);
      assert.equal(profile.apiKey, "original");
      assert.equal(getProfileBaseURL(profile), "https://api.openai.com/v1");
      process.env.UNUSUAL_NAME = "mutated";
      assert.equal((await resolveProfile("selected", cwd)).apiKey, "original");
      await assert.rejects(resolveProfile("typo", cwd), /does not exist/);
      installConfigurationEnvironment({});
      await assert.rejects(resolveProfile("selected", cwd), /UNUSUAL_NAME is unset/);
      installConfigurationEnvironment({ UNUSUAL_NAME: "original" });
      assert.equal((await loadProfiles(cwd)).defaultModel, "selected");
      await writeFile(
        path.join(cwd, ".easy-agent", "settings.json"),
        JSON.stringify({
          models: {
            selected: { protocol: "openai-chat", model: "upstream", baseURL: "https://other.example/v1" },
          },
        }),
      );
      resetSettingsCache();
      assert.equal(getProfileBaseURL(await resolveProfile("selected", cwd)), "https://api.openai.com/v1");
      await trustProjectForSession(cwd);
      await assert.rejects(resolveProfile("selected", cwd), /requires an explicit API Key source/);
      await writeFile(
        user,
        JSON.stringify({
          models: {
            helper: {
              protocol: "anthropic",
              model: "custom",
              apiKey: { helper: `${JSON.stringify(process.execPath)} -e "process.stdout.write('helper-value')"` },
            },
          },
        }),
      );
      resetSettingsCache();
      assert.equal((await resolveProfile("helper", cwd)).apiKey, "helper-value");
      assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, undefined);
      assert.equal(
        resolveHarnessFromInputs({
          layers: [],
          workspaceTrusted: true,
          env: {
            ANTHROPIC_API_KEY: "legacy",
            EASY_AGENT_AUTO_MODE_MODEL: "old-classifier",
          },
        }).values["model.roles.classifier"]?.value,
        "old-classifier",
      );
      assert.throws(
        () =>
          profileRequestHeaders({ id: "missing", protocol: "anthropic", model: "m", baseURL: "http://localhost:1" }),
        /provide this profile's API Key/,
      );
    });
  } finally {
    await disposeRuntimeScope(scope);
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldUserProfile;
    delete process.env.UNUSUAL_NAME;
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical environment priority stays below policy and rejects malformed values", () => {
  const resolve = (env: NodeJS.ProcessEnv) =>
    resolveHarnessFromInputs({
      workspaceTrusted: true,
      env,
      layers: [
        { source: "user", path: null, raw: { reasoning: { mode: "on" } } },
        { source: "flag", path: null, raw: { reasoning: { mode: "off" } } },
        { source: "policy", path: null, raw: { reasoning: { mode: "auto" } } },
      ],
    });
  assert.equal(resolve({ EASY_AGENT_REASONING: "on" }).values["reasoning.mode"]?.value, "auto");
  assert.equal(resolve({ EASY_AGENT_MAX_RETRIES: "0" }).values["features.maxRetries"]?.value, 0);
  assert.equal(resolve({ EASY_AGENT_DISABLE_PROMPT_CACHING: "false" }).values["features.promptCaching"]?.value, true);
  assert.throws(() => resolve({ EASY_AGENT_MAX_RETRIES: "12oops" }), /expected an integer/);
  assert.throws(() => resolve({ EASY_AGENT_TEAMS: "secret-bad" }), /expected 1\/0/);
});
