/**
 * Model configuration: providers, the models under them, and how they map to
 * Easy Agent's settings.
 *
 * Today Easy Agent stores one flat profile per model:
 *
 *   "models": { "<handle>": { protocol, model, baseURL, apiKey, maxTokens, headers, promptCacheKey } }
 *   "defaultModel": "<handle>",
 *   "modelRoles": { background, think, longContext }
 *
 * The UI groups profiles by provider so a key and an endpoint are entered once,
 * and writes one profile per enabled model.
 *
 * TODO(config): add a `providers` block that profiles reference by id, so
 *   baseURL / apiKey / headers are not repeated in every profile.
 * TODO(config): add `contextWindow`, `capabilities` (tools / vision / reasoning
 *   / cache), and `pricing` to profiles. The runtime currently assumes the
 *   Anthropic context window and estimates cost from Anthropic prices.
 * TODO(config): allow several API keys per provider and rotate them on 429.
 * TODO(config): per-profile reasoning settings (thinking budget for Anthropic,
 *   `reasoning_effort` for OpenAI) instead of the global effortLevel only.
 * TODO(config): a model catalog (models.dev-style) to fill limits and prices
 *   for models fetched from `/models`.
 * TODO(runtime): Azure OpenAI (api-version, deployment names), AWS Bedrock
 *   (SigV4), and Vertex AI (Google Cloud auth) need their own protocols.
 */

import { secretEnvName } from "../../shared/contract";
import type { BrandId } from "../design/BrandIcon";
import type { WriteScope } from "./scopes";

export type Protocol = "anthropic" | "openai-chat" | "openai-responses" | "gemini";

export const PROTOCOLS: { id: Protocol; label: string; short: string; hint: string }[] = [
  { id: "anthropic", label: "Anthropic Messages", short: "Anthropic", hint: "原生协议，支持思考、提示词缓存和 ToolSearch" },
  { id: "openai-chat", label: "OpenAI Chat Completions", short: "OpenAI Chat", hint: "兼容面最广，绝大多数服务商和本地推理框架都支持" },
  { id: "openai-responses", label: "OpenAI Responses", short: "Responses", hint: "OpenAI 新接口，推理模型效果更好" },
  { id: "gemini", label: "Google Gemini", short: "Gemini", hint: "Gemini 原生协议" },
];

/** Path the runtime appends to the base URL for a streaming request. */
export function requestPath(protocol: Protocol, model: string): string {
  if (protocol === "anthropic") return "/v1/messages";
  if (protocol === "openai-responses") return "/responses";
  if (protocol === "gemini") return `/models/${model}:streamGenerateContent`;
  return "/chat/completions";
}

export interface Capabilities {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  cache: boolean;
}

export interface ModelEntry {
  /** Profile id: the key under `models`, used by `--model` and `/model`. */
  handle: string;
  /** Model name sent to the provider. */
  model: string;
  name: string;
  contextWindow: number;
  /** Written as `maxTokens`. */
  maxOutput: number;
  capabilities: Capabilities;
  /** USD per million tokens. */
  price?: { input: number; output: number; cacheRead?: number };
  enabled: boolean;
  note?: string;
}

export type KeySource =
  /** `${NAME}` in the settings file, resolved from the environment. */
  | { kind: "env"; name: string }
  /** Kept in the OS keychain and passed to the Agent as `${EASY_AGENT_KEY_<name>}`. `value` is a key typed but not stored yet. */
  | { kind: "keychain"; name: string; masked: string; value?: string }
  /** Written into the settings file itself; the Agent never returns it. */
  | { kind: "inline" }
  | { kind: "none" };

export interface ProviderConfig {
  id: string;
  templateId: string;
  name: string;
  icon: BrandId | null;
  protocol: Protocol;
  baseURL: string;
  key: KeySource;
  enabled: boolean;
  headers: { name: string; value: string }[];
  promptCacheKey?: boolean;
  models: ModelEntry[];
  /** Settings file the provider's profiles are written to. */
  scope: WriteScope;
  check?: { state: "ok" | "error" | "checking"; latency?: number; message?: string; model?: string };
}

export type ProviderCategory = "官方" | "国内" | "聚合" | "云平台" | "本地" | "自定义";

export interface ProviderTemplate {
  id: string;
  name: string;
  icon: BrandId | null;
  category: ProviderCategory;
  protocol: Protocol;
  baseURL: string;
  envKey?: string;
  keyUrl?: string;
  /** Other endpoints the provider offers, e.g. an Anthropic-compatible one. */
  endpoints?: { label: string; protocol: Protocol; baseURL: string }[];
  /** Models the provider's `/models` returns, with catalog metadata. */
  catalog: ModelEntry[];
  local?: boolean;
  unsupported?: string;
  description: string;
}

const caps = (tools = true, vision = false, reasoning = false, cache = false): Capabilities => ({ tools, vision, reasoning, cache });

const m = (
  handle: string,
  model: string,
  name: string,
  contextWindow: number,
  maxOutput: number,
  capabilities: Capabilities,
  price?: ModelEntry["price"],
  note?: string,
): ModelEntry => ({
  handle,
  model,
  name,
  contextWindow,
  maxOutput,
  capabilities,
  price,
  enabled: true,
  note,
});

export const TEMPLATES: ProviderTemplate[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    icon: "anthropic",
    category: "官方",
    protocol: "anthropic",
    baseURL: "https://api.anthropic.com",
    envKey: "ANTHROPIC_API_KEY",
    keyUrl: "console.anthropic.com/settings/keys",
    description: "Claude 系列，Easy Agent 的原生协议",
    catalog: [
      m("claude-opus-4-1", "claude-opus-4-1", "Claude Opus 4.1", 200_000, 32_000, caps(true, true, true, true), { input: 15, output: 75, cacheRead: 1.5 }),
      m(
        "claude-sonnet-4-5",
        "claude-sonnet-4-5",
        "Claude Sonnet 4.5",
        200_000,
        64_000,
        caps(true, true, true, true),
        { input: 3, output: 15, cacheRead: 0.3 },
        "推荐",
      ),
      m("claude-haiku-4-5", "claude-haiku-4-5", "Claude Haiku 4.5", 200_000, 64_000, caps(true, true, true, true), { input: 1, output: 5, cacheRead: 0.1 }),
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    icon: "openai",
    category: "官方",
    protocol: "openai-responses",
    baseURL: "https://api.openai.com/v1",
    envKey: "OPENAI_API_KEY",
    keyUrl: "platform.openai.com/api-keys",
    description: "GPT-5 和 Codex 系列",
    endpoints: [{ label: "Chat Completions", protocol: "openai-chat", baseURL: "https://api.openai.com/v1" }],
    catalog: [
      m("gpt-5", "gpt-5", "GPT-5", 400_000, 128_000, caps(true, true, true, true), { input: 1.25, output: 10, cacheRead: 0.125 }),
      m("gpt-5-codex", "gpt-5-codex", "GPT-5 Codex", 400_000, 128_000, caps(true, true, true, true), { input: 1.25, output: 10, cacheRead: 0.125 }),
      m("gpt-5-mini", "gpt-5-mini", "GPT-5 mini", 400_000, 128_000, caps(true, true, true, true), { input: 0.25, output: 2, cacheRead: 0.025 }),
      m("gpt-4.1", "gpt-4.1", "GPT-4.1", 1_000_000, 32_768, caps(true, true, false, true), { input: 2, output: 8, cacheRead: 0.5 }),
      m("text-embedding-3-large", "text-embedding-3-large", "Embedding 3 Large", 8_192, 0, caps(false), { input: 0.13, output: 0 }, "嵌入模型"),
    ],
  },
  {
    id: "google",
    name: "Google Gemini",
    icon: "gemini",
    category: "官方",
    protocol: "gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
    envKey: "GEMINI_API_KEY",
    keyUrl: "aistudio.google.com/apikey",
    description: "Gemini 2.5 系列，百万级上下文",
    catalog: [
      m("gemini-2.5-pro", "gemini-2.5-pro", "Gemini 2.5 Pro", 1_048_576, 65_536, caps(true, true, true, true), { input: 1.25, output: 10, cacheRead: 0.31 }),
      m("gemini-2.5-flash", "gemini-2.5-flash", "Gemini 2.5 Flash", 1_048_576, 65_536, caps(true, true, true, true), {
        input: 0.3,
        output: 2.5,
        cacheRead: 0.075,
      }),
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    icon: "deepseek",
    category: "国内",
    protocol: "openai-chat",
    baseURL: "https://api.deepseek.com/v1",
    envKey: "DEEPSEEK_API_KEY",
    keyUrl: "platform.deepseek.com/api_keys",
    description: "DeepSeek V3.2，也提供 Anthropic 兼容接口",
    endpoints: [{ label: "Anthropic 兼容", protocol: "anthropic", baseURL: "https://api.deepseek.com/anthropic" }],
    catalog: [
      m("deepseek-v3.2", "deepseek-chat", "DeepSeek V3.2", 128_000, 8_192, caps(true, false, false, true), { input: 0.28, output: 0.42, cacheRead: 0.028 }),
      m("deepseek-reasoner", "deepseek-reasoner", "DeepSeek V3.2 思考模式", 128_000, 65_536, caps(true, false, true, true), {
        input: 0.28,
        output: 0.42,
        cacheRead: 0.028,
      }),
    ],
  },
  {
    id: "bailian",
    name: "阿里云百炼",
    icon: "bailian",
    category: "国内",
    protocol: "openai-chat",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    envKey: "DASHSCOPE_API_KEY",
    keyUrl: "bailian.console.aliyun.com",
    description: "通义千问 Qwen3 系列",
    catalog: [
      m("qwen3-coder-plus", "qwen3-coder-plus", "Qwen3 Coder Plus", 1_000_000, 65_536, caps(true, false, false, true), { input: 1, output: 5 }),
      m("qwen3-max", "qwen3-max", "Qwen3 Max", 262_144, 32_768, caps(true, false, true, true), { input: 1.2, output: 6 }),
      m("qwen-vl-max", "qwen-vl-max", "Qwen VL Max", 131_072, 8_192, caps(true, true, false, false), { input: 0.8, output: 3.2 }),
    ],
  },
  {
    id: "moonshot",
    name: "Moonshot",
    icon: "kimi",
    category: "国内",
    protocol: "openai-chat",
    baseURL: "https://api.moonshot.cn/v1",
    envKey: "MOONSHOT_API_KEY",
    keyUrl: "platform.moonshot.cn/console/api-keys",
    description: "Kimi K2，也提供 Anthropic 兼容接口",
    endpoints: [{ label: "Anthropic 兼容", protocol: "anthropic", baseURL: "https://api.moonshot.cn/anthropic" }],
    catalog: [
      m("kimi-k2", "kimi-k2-0905-preview", "Kimi K2", 262_144, 16_384, caps(true, false, false, true), { input: 0.6, output: 2.5, cacheRead: 0.15 }),
      m("kimi-k2-turbo", "kimi-k2-turbo-preview", "Kimi K2 Turbo", 262_144, 16_384, caps(true, false, false, true), { input: 1.15, output: 8 }),
      m("kimi-k2-thinking", "kimi-k2-thinking", "Kimi K2 Thinking", 262_144, 16_384, caps(true, false, true, true), { input: 0.6, output: 2.5 }),
    ],
  },
  {
    id: "zhipu",
    name: "智谱 BigModel",
    icon: "zhipu",
    category: "国内",
    protocol: "openai-chat",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    envKey: "ZHIPU_API_KEY",
    keyUrl: "bigmodel.cn/usercenter/apikeys",
    description: "GLM-4.6，也提供 Anthropic 兼容接口",
    endpoints: [{ label: "Anthropic 兼容", protocol: "anthropic", baseURL: "https://open.bigmodel.cn/api/anthropic" }],
    catalog: [
      m("glm-4.6", "glm-4.6", "GLM-4.6", 200_000, 128_000, caps(true, false, true, true), { input: 0.6, output: 2.2 }),
      m("glm-4.5-air", "glm-4.5-air", "GLM-4.5 Air", 131_072, 98_304, caps(true, false, true, true), { input: 0.2, output: 1.1 }),
      m("glm-4.5v", "glm-4.5v", "GLM-4.5V", 65_536, 16_384, caps(true, true, true, false), { input: 0.6, output: 1.8 }),
    ],
  },
  {
    id: "minimax",
    name: "MiniMax",
    icon: "minimax",
    category: "国内",
    protocol: "anthropic",
    baseURL: "https://api.minimaxi.com/anthropic",
    envKey: "MINIMAX_API_KEY",
    description: "MiniMax-M2，推荐走 Anthropic 兼容接口",
    catalog: [m("minimax-m2", "MiniMax-M2", "MiniMax M2", 204_800, 131_072, caps(true, false, true, true), { input: 0.3, output: 1.2 })],
  },
  {
    id: "volcengine",
    name: "火山方舟",
    icon: "volcengine",
    category: "国内",
    protocol: "openai-chat",
    baseURL: "https://ark.cn-beijing.volces.com/api/v3",
    envKey: "ARK_API_KEY",
    description: "豆包 Seed 系列",
    catalog: [
      m("doubao-seed-code", "doubao-seed-code-preview", "Doubao Seed Code", 262_144, 32_768, caps(true, true, true, true), { input: 0.17, output: 1.12 }),
      m("doubao-seed-1.6", "doubao-seed-1-6", "Doubao Seed 1.6", 262_144, 32_768, caps(true, true, true, true), { input: 0.11, output: 1.1 }),
    ],
  },
  {
    id: "siliconflow",
    name: "硅基流动",
    icon: "siliconcloud",
    category: "聚合",
    protocol: "openai-chat",
    baseURL: "https://api.siliconflow.cn/v1",
    envKey: "SILICONFLOW_API_KEY",
    description: "国内的开源模型托管平台",
    catalog: [
      m("sf-deepseek-v3.2", "deepseek-ai/DeepSeek-V3.2-Exp", "DeepSeek V3.2", 163_840, 8_192, caps(true, false, false, false)),
      m("sf-qwen3-coder", "Qwen/Qwen3-Coder-480B-A35B-Instruct", "Qwen3 Coder 480B", 262_144, 65_536, caps(true, false, false, false)),
      m("sf-kimi-k2", "moonshotai/Kimi-K2-Instruct-0905", "Kimi K2", 262_144, 16_384, caps(true, false, false, false)),
      m("sf-glm-4.6", "zai-org/GLM-4.6", "GLM-4.6", 200_000, 128_000, caps(true, false, true, false)),
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    icon: "openrouter",
    category: "聚合",
    protocol: "openai-chat",
    baseURL: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    keyUrl: "openrouter.ai/keys",
    description: "一个 Key 调用几百个模型",
    catalog: [
      m("or-claude-sonnet-4.5", "anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5", 1_000_000, 64_000, caps(true, true, true, true), { input: 3, output: 15 }),
      m("or-gpt-5", "openai/gpt-5", "GPT-5", 400_000, 128_000, caps(true, true, true, true), { input: 1.25, output: 10 }),
      m("or-grok-code-fast", "x-ai/grok-code-fast-1", "Grok Code Fast 1", 256_000, 10_000, caps(true, false, true, true), { input: 0.2, output: 1.5 }),
      m("or-qwen3-coder", "qwen/qwen3-coder", "Qwen3 Coder", 262_144, 262_144, caps(true, false, false, false), { input: 0.22, output: 0.95 }),
    ],
  },
  {
    id: "xai",
    name: "xAI",
    icon: "xai",
    category: "官方",
    protocol: "openai-chat",
    baseURL: "https://api.x.ai/v1",
    envKey: "XAI_API_KEY",
    description: "Grok 系列",
    catalog: [
      m("grok-code-fast-1", "grok-code-fast-1", "Grok Code Fast 1", 256_000, 10_000, caps(true, false, true, true), { input: 0.2, output: 1.5 }),
      m("grok-4", "grok-4", "Grok 4", 256_000, 64_000, caps(true, true, true, true), { input: 3, output: 15 }),
    ],
  },
  {
    id: "mistral",
    name: "Mistral",
    icon: "mistral",
    category: "官方",
    protocol: "openai-chat",
    baseURL: "https://api.mistral.ai/v1",
    envKey: "MISTRAL_API_KEY",
    description: "Devstral 和 Codestral",
    catalog: [
      m("devstral-medium", "devstral-medium-latest", "Devstral Medium", 131_072, 32_768, caps(true), { input: 0.4, output: 2 }),
      m("codestral", "codestral-latest", "Codestral", 256_000, 32_768, caps(true), { input: 0.3, output: 0.9 }),
    ],
  },
  {
    id: "groq",
    name: "Groq",
    icon: "groq",
    category: "聚合",
    protocol: "openai-chat",
    baseURL: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
    description: "极快的推理速度",
    catalog: [m("groq-kimi-k2", "moonshotai/kimi-k2-instruct-0905", "Kimi K2", 262_144, 16_384, caps(true), { input: 1, output: 3 })],
  },
  {
    id: "azure",
    name: "Azure OpenAI",
    icon: "azure",
    category: "云平台",
    protocol: "openai-responses",
    baseURL: "https://<resource>.openai.azure.com/openai/v1",
    envKey: "AZURE_OPENAI_API_KEY",
    description: "用 v1 兼容地址接入；模型名填部署名",
    catalog: [],
  },
  {
    id: "bedrock",
    name: "AWS Bedrock",
    icon: "bedrock",
    category: "云平台",
    protocol: "anthropic",
    baseURL: "",
    description: "通过 AWS 账号调用 Claude",
    unsupported: "需要 SigV4 签名，Easy Agent 暂不支持",
    catalog: [],
  },
  {
    id: "vertex",
    name: "Vertex AI",
    icon: "vertexai",
    category: "云平台",
    protocol: "gemini",
    baseURL: "",
    description: "通过 Google Cloud 调用 Gemini 和 Claude",
    unsupported: "需要 Google Cloud 认证，Easy Agent 暂不支持",
    catalog: [],
  },
  {
    id: "ollama",
    name: "Ollama",
    icon: "ollama",
    category: "本地",
    protocol: "openai-chat",
    baseURL: "http://localhost:11434/v1",
    local: true,
    description: "在本机运行开源模型",
    catalog: [
      m("qwen3-coder-30b", "qwen3-coder:30b", "Qwen3 Coder 30B", 262_144, 65_536, caps(true)),
      m("gpt-oss-20b", "gpt-oss:20b", "gpt-oss 20B", 131_072, 32_768, caps(true, false, true)),
      m("deepseek-r1-14b", "deepseek-r1:14b", "DeepSeek R1 14B", 131_072, 32_768, caps(false, false, true), undefined, "不支持工具调用"),
    ],
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    icon: "lmstudio",
    category: "本地",
    protocol: "openai-chat",
    baseURL: "http://localhost:1234/v1",
    local: true,
    description: "图形化的本地模型管理",
    catalog: [m("lms-qwen3-coder", "qwen/qwen3-coder-30b", "Qwen3 Coder 30B", 262_144, 65_536, caps(true))],
  },
  {
    id: "vllm",
    name: "vLLM",
    icon: "vllm",
    category: "本地",
    protocol: "openai-chat",
    baseURL: "http://localhost:8000/v1",
    local: true,
    description: "自建推理服务",
    catalog: [],
  },
  {
    id: "custom",
    name: "自定义服务商",
    icon: null,
    category: "自定义",
    protocol: "openai-chat",
    baseURL: "",
    description: "任何 OpenAI、Anthropic 或 Gemini 兼容的接口",
    catalog: [],
  },
];

export const templateById = (id: string): ProviderTemplate => TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[TEMPLATES.length - 1];

/** What a provider's `apiKey` entry says in the settings file. */
export function apiKeyEntry(key: KeySource): string | undefined {
  if (key.kind === "env") return `\${${key.name}}`;
  if (key.kind === "keychain") return `\${${secretEnvName(key.name)}}`;
  if (key.kind === "inline") return "[redacted]";
  return undefined;
}

/** The `models.<handle>` entries a provider writes, indented for the `models` object. */
export function profileEntryLines(p: ProviderConfig): string[] {
  const key = apiKeyEntry(p.key);
  const lines: string[] = [];
  const enabled = p.models.filter((x) => x.enabled);
  enabled.forEach((x, i) => {
    const entry: Record<string, unknown> = { protocol: p.protocol, model: x.model };
    if (p.baseURL) entry.baseURL = p.baseURL;
    if (key) entry.apiKey = key;
    if (x.maxOutput) entry.maxTokens = x.maxOutput;
    if (p.headers.length) entry.headers = Object.fromEntries(p.headers.filter((h) => h.name).map((h) => [h.name, h.value]));
    if (p.promptCacheKey !== undefined && p.protocol.startsWith("openai")) entry.promptCacheKey = p.promptCacheKey;
    const body = JSON.stringify(entry, null, 2)
      .split("\n")
      .slice(1, -1)
      .map((l) => `    ${l}`);
    const caps = Object.entries(x.capabilities)
      .filter(([, v]) => v)
      .map(([k]) => `"${k}"`)
      .join(", ");
    lines.push(`    "${x.handle}": {`, ...body.map((l, j) => (j === body.length - 1 ? `${l},` : l)));
    lines.push(
      `      // TODO(config): "contextWindow": ${x.contextWindow}, "capabilities": [${caps}]${x.price ? `, "pricing": { "input": ${x.price.input}, "output": ${x.price.output} }` : ""}`,
    );
    lines.push(`    }${i === enabled.length - 1 ? "" : ","}`);
  });
  return lines;
}

/** The provider's profiles as a settings file fragment. Fields the schema lacks go into TODO comments. */
export function profileJson(p: ProviderConfig, scopeFile: string): string {
  const head = [`// ${scopeFile}`];
  if (p.key.kind === "keychain") head.push("// 钥匙串里的密钥由桌面端在启动 Agent 进程时作为环境变量传入");
  return [...head, "{", '  "models": {', ...profileEntryLines(p), "  }", "}"].join("\n");
}
