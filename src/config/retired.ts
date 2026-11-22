/**
 * Diagnostics for removed configuration. This module never converts values:
 * conversion belongs exclusively to the explicit migration command/API.
 */
import { configString, environmentReferences } from "./values.js";

export interface ConfigurationNotice {
  level: "error";
  field: string;
  message: string;
}

export const RETIRED_ENVIRONMENT_TARGETS: Readonly<Record<string, string>> = {
  ANTHROPIC_API_KEY: "models.<id>.apiKey or EASY_AGENT_API_KEY",
  ANTHROPIC_AUTH_TOKEN: "models.<id>.apiKey or EASY_AGENT_API_KEY",
  ANTHROPIC_BASE_URL: "models.<id>.baseURL or EASY_AGENT_BASE_URL",
  ANTHROPIC_MODEL: "EASY_AGENT_PROTOCOL and EASY_AGENT_MODEL",
  MAX_THINKING_TOKENS: "reasoning.budgetTokens or EASY_AGENT_REASONING_BUDGET_TOKENS",
  CLAUDE_CODE_DISABLE_THINKING: "reasoning.mode or EASY_AGENT_REASONING",
  CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "models.<id>.protocolOptions.anthropic.adaptiveThinking",
  DISABLE_INTERLEAVED_THINKING: "models.<id>.protocolOptions.anthropic.interleavedThinking",
  CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "models.<id>.capabilities.effort",
  CLAUDE_CODE_MAX_CONTEXT_TOKENS: "EASY_AGENT_MAX_CONTEXT_TOKENS",
  CLAUDE_CODE_MAX_RETRIES: "EASY_AGENT_MAX_RETRIES",
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "EASY_AGENT_DISABLE_EXPERIMENTAL_BETAS",
  WEB_SEARCH_ADAPTER: "EASY_AGENT_WEB_SEARCH_BACKEND",
  MCP_CONNECT_TIMEOUT: "EASY_AGENT_MCP_CONNECT_TIMEOUT_MS",
  EASY_AGENT_ENABLE_TOOL_SEARCH: "toolSearch/toolSearchAutoThreshold or --tool-search",
  ENABLE_TOOL_SEARCH: "toolSearch/toolSearchAutoThreshold or --tool-search",
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Explicit references remain arbitrary names, including vendor names. */
export function declaredEnvironmentReferences(values: readonly unknown[]): ReadonlySet<string> {
  return new Set(values.flatMap(environmentReferences));
}

function notice(field: string, target: string): ConfigurationNotice {
  return {
    level: "error",
    field,
    message: `Retired configuration "${field}" is no longer applied. Use ${target}; preview an explicit migration with eagent config migrate, then --apply. Update shell or .env variables separately.`,
  };
}

export function retiredEnvironmentNotices(
  env: Readonly<NodeJS.ProcessEnv>,
  references: ReadonlySet<string> = new Set(),
): ConfigurationNotice[] {
  return Object.entries(RETIRED_ENVIRONMENT_TARGETS)
    .filter(([name]) => env[name] != null && configString(String(env[name])) !== undefined && !references.has(name))
    .map(([name, target]) => notice(name, target));
}

export function retiredHarnessNotices(raw: unknown, prefix = ""): ConfigurationNotice[] {
  const spec = object(raw);
  const features = object(spec.features);
  return Object.entries({
    thinking: "reasoning.mode",
    thinkingInRequests: "reasoning.mode",
    thinkingBudget: "reasoning.budgetTokens",
    effort: "reasoning.effort",
    adaptiveThinking: "models.<id>.protocolOptions.anthropic.adaptiveThinking",
    interleavedThinking: "models.<id>.protocolOptions.anthropic.interleavedThinking",
    effortForAllModels: "models.<id>.capabilities.effort",
  })
    .filter(([key]) => Object.hasOwn(features, key))
    .map(([key, target]) => notice(`${prefix}features.${key}`, target));
}

export function retiredSettingsNotices(
  raw: unknown,
  references: ReadonlySet<string> = declaredEnvironmentReferences([raw]),
): ConfigurationNotice[] {
  const settings = object(raw);
  const notices = Object.entries({
    defaultModel: "model (a saved profile ID)",
    apiKeyHelper: "models.<id>.apiKey.helper",
    claudeMdExcludes: "agentMdExcludes",
    alwaysThinkingEnabled: "reasoning.mode",
    effortLevel: "reasoning.effort",
  })
    .filter(([key]) => Object.hasOwn(settings, key))
    .map(([key, target]) => notice(key, target));
  for (const [id, value] of Object.entries(object(settings.models))) {
    const profile = object(value);
    for (const key of ["countTokens", "promptCacheKey"]) {
      if (Object.hasOwn(profile, key)) notices.push(notice(`models.${id}.${key}`, `models.${id}.protocolOptions`));
    }
  }
  for (const [name, spec] of Object.entries(object(settings.harnesses)))
    notices.push(...retiredHarnessNotices(spec, `harnesses.${name}.`));
  notices.push(
    ...retiredEnvironmentNotices(object(settings.env) as NodeJS.ProcessEnv, references).map((item) => ({
      ...item,
      field: `env.${item.field}`,
    })),
  );
  return notices;
}
