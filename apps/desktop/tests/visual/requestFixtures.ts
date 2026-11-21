import type { RequestDiff, SessionContext } from "eagent/sdk";

/** Frozen RPC responses used by the reference and the client's visual replay only. */
export const CONTEXT_FIXTURE: SessionContext = {
  basis: "request",
  estimated: false,
  model: "claude-sonnet",
  used: 1440,
  contextWindow: 200000,
  free: 198560,
  conversationTokens: 40,
  autoCompactThreshold: 160000,
  totals: { systemPrompt: 1200, memory: 0, tools: 200, conversation: 40 },
  toolSearch: { enabled: false, deferred: [], loaded: [], sentTools: 1, alwaysLoadedTokens: 200, loadedTokens: 0 },
  categories: [
    { id: "system", tokens: 1100, items: [{ id: "instructions", label: "Instructions", tokens: 1100, source: "built-in" }] },
    { id: "tools", tokens: 200, items: [{ id: "Read", label: "Read", tokens: 200, source: "built-in" }] },
    { id: "mcp", tokens: 0, items: [] },
    { id: "skills", tokens: 100, items: [{ id: "review", label: "/review", tokens: 100, source: "user" }] },
    { id: "plugins", tokens: 0, items: [] },
    { id: "rules", tokens: 0, items: [] },
    {
      id: "messages",
      tokens: 40,
      items: [
        { id: "user_input", label: "User input", tokens: 20 },
        { id: "assistant", label: "Assistant", tokens: 20 },
      ],
    },
  ],
  components: [
    { id: "prompt_section:identity", part: "system", category: "system", item: "instructions", bytes: 4400, tokens: 1100, count: 1 },
    { id: "skill:user:review", part: "system", category: "skills", item: "review", bytes: 400, tokens: 100, count: 1 },
    { id: "tool:Read", part: "tools", category: "tools", item: "Read", bytes: 800, tokens: 200, count: 1 },
    { id: "message:user_input", part: "messages", category: "messages", item: "user_input", bytes: 80, tokens: 20, count: 1 },
    { id: "message:assistant", part: "messages", category: "messages", item: "assistant", bytes: 80, tokens: 20, count: 1 },
    { id: "request:envelope", part: "request", category: null, item: null, bytes: 160, tokens: 0, count: 1 },
    { id: "request:framing", part: "request", category: null, item: null, bytes: 40, tokens: 0, count: 1 },
  ],
  request: {
    requestId: "req-context-01",
    startedAt: "2026-11-15T00:00:00.000Z",
    protocol: "anthropic",
    model: "claude-sonnet",
    bytes: 5880,
    inputTokens: 1420,
    outputTokens: 20,
    cacheReadTokens: 1000,
    cacheWriteTokens: 100,
    tokens: { method: "count", system: 1200, tools: 200, messages: 20 },
    unsent: { messages: 1, bytes: 80, tokens: 20 },
  },
};

const params = { maxTokens: 4096, betas: [], toolSearch: false, promptCaching: true, cacheMarkers: 2, promptCacheKey: false };
export const COMPARISON_FIXTURE: RequestDiff = {
  prompt: "检查这个项目",
  estimated: true,
  a: {
    harness: { name: "default", hash: "a" },
    protocol: "anthropic",
    model: "claude-sonnet",
    params,
    tokens: { system: 1200, tools: 200, messages: 20, total: 1420 },
    components: 8,
  },
  b: {
    harness: { name: "lean", hash: "b" },
    protocol: "anthropic",
    model: "claude-sonnet",
    params,
    tokens: { system: 800, tools: 100, messages: 20, total: 920 },
    components: 7,
  },
  params: [],
  unchanged: 6,
  components: [
    {
      id: "prompt_section:identity",
      kind: "prompt_section",
      change: "changed",
      a: { bytes: 2000, tokens: 500, hash: "x" },
      b: { bytes: 400, tokens: 100, hash: "y" },
      tokens: -400,
      lines: [
        { op: "-", text: "You are Easy Agent, a terminal-native assistant." },
        { op: "+", text: "You are a concise reviewer." },
      ],
    },
    { id: "tool:Bash", kind: "tool", change: "removed", a: { bytes: 400, tokens: 100, hash: "z" }, tokens: -100 },
  ],
};
