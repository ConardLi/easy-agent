/**
 * Step 34 - Extended Thinking
 *
 * Goal:
 * - configure adaptive, budgeted, or disabled thinking
 * - translate thinking settings across providers
 * - stream thinking blocks and safely replay Anthropic history
 * - expose session commands and a folded terminal preview
 */

// -----------------------------------------------------------------------------
// 1. Thinking configuration
// -----------------------------------------------------------------------------

export function hasUltrathinkKeyword(text) {
  return /\bultrathink\b/i.test(String(text));
}

export function supportsThinking(model) {
  return !String(model).toLowerCase().includes("claude-3-");
}

export function supportsAdaptiveThinking(model) {
  const name = String(model).toLowerCase();
  const match = name.match(/claude-(?:opus|sonnet)-(\d+)-(\d+)/);
  if (match) return Number(match[1]) > 4 || (Number(match[1]) === 4 && Number(match[2]) >= 6);
  if (/opus|sonnet|haiku/.test(name)) return false;
  return true;
}

export function defaultThinkingConfig({ env = process.env, enabled = true } = {}) {
  if (env.MAX_THINKING_TOKENS !== undefined) {
    const budget = Number.parseInt(env.MAX_THINKING_TOKENS, 10);
    return budget > 0 ? { type: "enabled", budgetTokens: budget } : { type: "disabled" };
  }
  return enabled ? { type: "adaptive" } : { type: "disabled" };
}

export function resolveThinking({ model, maxTokens, config }) {
  if (config.type === "disabled" || !supportsThinking(model)) return undefined;
  if (config.type === "adaptive" && supportsAdaptiveThinking(model)) {
    return { type: "adaptive" };
  }
  const requested = config.type === "enabled" ? config.budgetTokens : maxTokens - 1;
  return { type: "enabled", budget_tokens: Math.min(maxTokens - 1, requested) };
}

// -----------------------------------------------------------------------------
// 2. Provider request mapping
// -----------------------------------------------------------------------------

export function buildThinkingRequest({
  provider,
  model,
  maxTokens = 16_000,
  temperature = 0.7,
  thinking = { type: "adaptive" },
  effort,
}) {
  const resolved = resolveThinking({ model, maxTokens, config: thinking });

  if (provider === "anthropic") {
    const betas = [];
    if (resolved) betas.push("interleaved-thinking-2025-05-14");
    if (effort) betas.push("effort-2025-11-24");
    return {
      body: {
        model,
        max_tokens: maxTokens,
        ...(resolved ? { thinking: resolved } : { temperature }),
        ...(effort ? { output_config: { effort } } : {}),
      },
      headers: betas.length ? { "anthropic-beta": betas.join(",") } : {},
    };
  }

  if (provider === "gemini") {
    const thinkingConfig = resolved
      ? {
          includeThoughts: true,
          ...(resolved.type === "enabled" ? { thinkingBudget: resolved.budget_tokens } : {}),
        }
      : undefined;
    return {
      body: {
        model,
        generationConfig: {
          temperature,
          ...(thinkingConfig ? { thinkingConfig } : {}),
        },
      },
      headers: {},
    };
  }

  // OpenAI reasoning is adapted on the response side in this milestone.
  return { body: { model, temperature }, headers: {} };
}

// -----------------------------------------------------------------------------
// 3. Unified thinking stream
// -----------------------------------------------------------------------------

export async function* translateThinkingStream(events) {
  let current;

  for await (const event of events) {
    if (event.type === "thinking_start") {
      current = { type: "thinking", thinking: "", signature: "" };
      yield { type: "thinking_start" };
    } else if (event.type === "thinking_delta" || event.type === "reasoning_content") {
      if (!current) {
        current = { type: "thinking", thinking: "", signature: "" };
        yield { type: "thinking_start" };
      }
      const chunk = event.thinking ?? event.text ?? "";
      current.thinking += chunk;
      yield { type: "thinking_delta", thinking: chunk };
    } else if (event.type === "signature_delta" && current) {
      current.signature += event.signature ?? "";
    } else if (event.type === "thinking_stop" && current) {
      const block = {
        type: "thinking",
        thinking: current.thinking,
        ...(current.signature ? { signature: current.signature } : {}),
      };
      yield { type: "thinking_done", block };
      current = undefined;
    } else if (event.type === "redacted_thinking") {
      yield { type: "redacted_thinking", block: { type: "redacted_thinking", data: event.data } };
    } else {
      yield event;
    }
  }
}

// -----------------------------------------------------------------------------
// 4. Safe history replay
// -----------------------------------------------------------------------------

function isThinkingBlock(block) {
  return block?.type === "thinking" || block?.type === "redacted_thinking";
}

export function normalizeThinkingHistory(messages, { thinkingOn, endpointChanged = false }) {
  let normalized = messages.filter((message) => {
    return message.role !== "assistant" || !Array.isArray(message.content) ||
      !message.content.length || !message.content.every(isThinkingBlock);
  });

  const last = normalized.at(-1);
  if (last?.role === "assistant" && Array.isArray(last.content)) {
    const content = last.content.slice();
    while (content.length && isThinkingBlock(content.at(-1))) content.pop();
    if (content.length !== last.content.length) {
      normalized = [
        ...normalized.slice(0, -1),
        { ...last, content: content.length ? content : [{ type: "text", text: "[No message content]" }] },
      ];
    }
  }

  if (!thinkingOn || endpointChanged) {
    normalized = normalized.map((message) => ({
      ...message,
      content: Array.isArray(message.content)
        ? message.content.map(({ signature, ...block }) => block)
        : message.content,
    }));
  }
  return normalized;
}

// -----------------------------------------------------------------------------
// 5. Session controls and terminal display
// -----------------------------------------------------------------------------

export function applyThinkingCommand(line, state) {
  const [command, value] = String(line).trim().split(/\s+/);
  if (command === "/think") {
    if (value === "off" || value === "0") state.thinking = { type: "disabled" };
    else if (!value || value === "on" || value === "adaptive") state.thinking = { type: "adaptive" };
    else {
      const budgetTokens = Number.parseInt(value, 10);
      if (!(budgetTokens > 0)) throw new Error("thinking budget must be positive");
      state.thinking = { type: "enabled", budgetTokens };
    }
    return state;
  }
  if (command === "/effort") {
    if (value === "default" || value === "off") state.effort = undefined;
    else if (["low", "medium", "high", "max"].includes(value)) state.effort = value;
    else throw new Error("effort must be low, medium, high, or max");
  }
  return state;
}

export function renderThinking(block, { verbose = false } = {}) {
  if (block.type === "redacted_thinking") return verbose ? "* Thinking... (redacted)" : "";
  return verbose ? `* Thinking\n  ${block.thinking.trim()}` : "* Thinking...";
}

// -----------------------------------------------------------------------------
// 6. Demo
// -----------------------------------------------------------------------------

export async function demoStep34() {
  const state = applyThinkingCommand("/think 5000", {});
  applyThinkingCommand("/effort high", state);
  const request = buildThinkingRequest({
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    maxTokens: 4096,
    thinking: state.thinking,
    effort: state.effort,
  });

  async function* source() {
    yield { type: "thinking_start" };
    yield { type: "thinking_delta", thinking: "Inspect the code first." };
    yield { type: "signature_delta", signature: "signed" };
    yield { type: "thinking_stop" };
    yield { type: "text", text: "Ready." };
  }

  const events = [];
  for await (const event of translateThinkingStream(source())) events.push(event);
  const history = normalizeThinkingHistory([
    { role: "assistant", content: [events[2].block, { type: "text", text: "Ready." }] },
  ], { thinkingOn: false });

  return {
    thinking: request.body.thinking,
    temperatureOmitted: !("temperature" in request.body),
    effort: request.body.output_config.effort,
    events: events.map((event) => event.type),
    signatureStripped: !("signature" in history[0].content[0]),
    folded: renderThinking(events[2].block),
    ultrathink: hasUltrathinkKeyword("Please ultrathink about this."),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  demoStep34().then((result) => console.log(JSON.stringify(result, null, 2)));
}
