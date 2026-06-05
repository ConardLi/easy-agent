/**
 * Step 30 - Multi-provider support
 *
 * Goal:
 * - keep the upper stack speaking one Anthropic-shaped message contract
 * - resolve a model handle into a provider profile
 * - translate requests/responses only at the API edge
 * - support Anthropic, OpenAI-compatible, and Gemini-style targets
 */

// -----------------------------------------------------------------------------
// 1. Model profile loading
// -----------------------------------------------------------------------------

export const VALID_PROTOCOLS = new Set(["anthropic", "openai-chat", "openai-responses", "gemini"]);

export function interpolateEnv(value, env = process.env) {
  return String(value).replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name) => env[name] || "");
}

function usesEnvInterpolation(value) {
  return /\$\{[A-Z0-9_]+\}/i.test(String(value));
}

export function buildProfile(id, raw, options = {}) {
  const warnings = options.warnings || [];
  const protocol = String(raw?.protocol || "").trim();
  const model = String(raw?.model || "").trim();

  if (!VALID_PROTOCOLS.has(protocol)) {
    warnings.push(`models.${id}: invalid protocol`);
    return null;
  }
  if (!model) {
    warnings.push(`models.${id}: missing model`);
    return null;
  }

  if (!options.trusted && raw.apiKey && !usesEnvInterpolation(raw.apiKey)) {
    warnings.push(`models.${id}.apiKey: inline secret from untrusted scope ignored`);
    raw = { ...raw, apiKey: undefined };
  }

  const profile = { id, protocol, model };
  if (raw.baseURL) profile.baseURL = interpolateEnv(raw.baseURL, options.env);
  if (raw.apiKey) {
    const key = interpolateEnv(raw.apiKey, options.env);
    if (key) profile.apiKey = key;
  }
  if (Number.isFinite(raw.maxTokens) && raw.maxTokens > 0) profile.maxTokens = raw.maxTokens;
  if (raw.headers && typeof raw.headers === "object") {
    profile.headers = Object.fromEntries(
      Object.entries(raw.headers).map(([key, value]) => [key, interpolateEnv(value, options.env)]),
    );
  }
  return profile;
}

export function loadProfilesFromSources(sources, env = process.env) {
  const merged = {};
  let defaultModel;
  const warnings = [];

  for (const source of sources) {
    const raw = source.raw || {};
    if (raw.models && typeof raw.models === "object") {
      for (const [id, profile] of Object.entries(raw.models)) {
        merged[id] = { ...(merged[id] || {}), ...profile };
        if (!source.trusted && profile.apiKey && !usesEnvInterpolation(profile.apiKey)) {
          merged[id].apiKey = undefined;
          warnings.push(`models.${id}.apiKey: inline secret ignored`);
        }
      }
    }
    if (typeof raw.defaultModel === "string") defaultModel = raw.defaultModel;
  }

  const profiles = {};
  for (const [id, raw] of Object.entries(merged)) {
    const profile = buildProfile(id, raw, { trusted: true, env, warnings });
    if (profile) profiles[id] = profile;
  }
  return { profiles, defaultModel, warnings };
}

export function resolveProfile(handle, loaded) {
  if (loaded.profiles[handle]) return loaded.profiles[handle];
  return { id: handle, protocol: "anthropic", model: handle };
}

// -----------------------------------------------------------------------------
// 2. Anthropic-shaped request -> provider request
// -----------------------------------------------------------------------------

export function anthropicMessagesToOpenAI(messages) {
  return messages.map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    content: stringifyContent(message.content),
  }));
}

export function anthropicToolsToOpenAI(tools) {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema || tool.inputSchema || { type: "object", properties: {} },
    },
  }));
}

export function anthropicMessagesToGemini(messages) {
  return messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: stringifyContent(message.content) }],
  }));
}

function stringifyContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_use") return `[tool_use:${block.name}]`;
      if (block.type === "tool_result") return `[tool_result:${block.tool_use_id}] ${stringifyContent(block.content)}`;
      if (block.type === "image") return "[image]";
      return "";
    })
    .join("");
}

export function buildProviderRequest(profile, request) {
  if (profile.protocol === "anthropic") {
    return {
      protocol: "anthropic",
      url: profile.baseURL || "https://api.anthropic.com/v1/messages",
      body: { ...request, model: profile.model },
    };
  }

  if (profile.protocol === "gemini") {
    return {
      protocol: "gemini",
      url: profile.baseURL || `https://generativelanguage.googleapis.com/v1beta/models/${profile.model}:streamGenerateContent`,
      body: {
        contents: anthropicMessagesToGemini(request.messages || []),
        tools: request.tools || [],
      },
    };
  }

  return {
    protocol: profile.protocol,
    url: profile.baseURL || "https://api.openai.com/v1/chat/completions",
    body: {
      model: profile.model,
      messages: anthropicMessagesToOpenAI(request.messages || []),
      tools: anthropicToolsToOpenAI(request.tools || []),
      stream: true,
    },
  };
}

// -----------------------------------------------------------------------------
// 3. Provider stream events -> normalized events
// -----------------------------------------------------------------------------

export function normalizeStopReason(reason) {
  if (reason === "length" || reason === "MAX_TOKENS") return "max_tokens";
  if (reason === "tool_calls" || reason === "STOP") return "tool_use";
  if (reason === "stop" || reason === "end_turn") return "end_turn";
  return reason || "end_turn";
}

export function* adaptOpenAIEvents(events) {
  for (const event of events) {
    const choice = event.choices?.[0];
    const delta = choice?.delta || {};
    if (delta.content) yield { type: "content_block_delta", delta: { type: "text_delta", text: delta.content } };
    if (delta.tool_calls) {
      for (const call of delta.tool_calls) {
        yield {
          type: "content_block_delta",
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(call.function?.arguments || {}),
          },
        };
      }
    }
    if (choice?.finish_reason) {
      yield { type: "message_delta", delta: { stop_reason: normalizeStopReason(choice.finish_reason) } };
    }
  }
}

export function* adaptGeminiEvents(events) {
  for (const event of events) {
    const parts = event.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.text) yield { type: "content_block_delta", delta: { type: "text_delta", text: part.text } };
      if (part.functionCall) {
        yield {
          type: "content_block_start",
          content_block: { type: "tool_use", name: part.functionCall.name, input: part.functionCall.args || {} },
        };
      }
    }
    const reason = event.candidates?.[0]?.finishReason;
    if (reason) yield { type: "message_delta", delta: { stop_reason: normalizeStopReason(reason) } };
  }
}

export async function* streamViaProvider(profile, request, transport) {
  const providerRequest = buildProviderRequest(profile, request);
  const events = await transport(providerRequest);
  if (profile.protocol.startsWith("openai")) yield* adaptOpenAIEvents(events);
  else if (profile.protocol === "gemini") yield* adaptGeminiEvents(events);
  else yield* events;
}

// -----------------------------------------------------------------------------
// 4. Demo
// -----------------------------------------------------------------------------

export async function demoStep30() {
  const loaded = loadProfilesFromSources([
    {
      trusted: true,
      raw: {
        defaultModel: "gpt",
        models: {
          gpt: { protocol: "openai-chat", model: "gpt-5", apiKey: "${OPENAI_API_KEY}" },
          gemini: { protocol: "gemini", model: "gemini-2.5-pro" },
        },
      },
    },
  ], { OPENAI_API_KEY: "sk-demo" });

  const profile = resolveProfile("gpt", loaded);
  const request = buildProviderRequest(profile, {
    messages: [{ role: "user", content: "hello" }],
    tools: [{ name: "Read", description: "Read a file", input_schema: { type: "object" } }],
  });
  const normalized = [...adaptOpenAIEvents([
    { choices: [{ delta: { content: "hi" } }] },
    { choices: [{ finish_reason: "stop" }] },
  ])];

  return {
    defaultModel: loaded.defaultModel,
    profile,
    providerBodyModel: request.body.model,
    normalized,
    fallback: resolveProfile("claude-sonnet", loaded),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await demoStep30(), null, 2));
}
