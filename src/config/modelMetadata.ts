/** Shared model facts. Unknown values stay unknown; context estimates are labelled. */
import type { ModelCapabilities, ModelProfileConfig, ModelProtocol } from "./modelSchema.js";
import { defineRuntimeState } from "../state/runtimeScope.js";

export const UNKNOWN_CONTEXT_WINDOW = 32_000;
export interface EffectiveModelMetadata {
  tools: boolean;
  vision: boolean;
  cache: boolean;
  reasoning: boolean;
  adaptiveReasoning: boolean;
  interleavedReasoning: boolean;
  effort: boolean;
  contextWindow: number;
  contextWindowSource: "profile" | "catalog" | "estimate";
  maxOutputTokens?: number;
  pricing?: ModelCapabilities["pricing"];
}

export function canonicalModelName(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^.*(?:anthropic\.|\/models\/)/, "")
    .replace(/[@:].*$/, "");
}

export function claudeVersion(model: string): { family: string; major: number; minor: number } | undefined {
  const match = canonicalModelName(model).match(/^claude-(opus|sonnet|haiku)-(\d+)(?:[-.](\d{1,2})(?=-|$))?/);
  return match ? { family: match[1]!, major: Number(match[2]), minor: Number(match[3] ?? 0) } : undefined;
}

export function catalogCapabilities(model: string, protocol?: ModelProtocol): ModelCapabilities {
  const name = canonicalModelName(model);
  const version = claudeVersion(name);
  if (protocol === undefined || protocol === "anthropic") {
    if (version?.major === 4) {
      const adaptive = version.family !== "haiku" && version.minor >= 6;
      return {
        tools: true,
        vision: true,
        cache: true,
        reasoning: true,
        adaptiveReasoning: adaptive,
        interleavedReasoning: version.family !== "haiku",
        effort: adaptive,
        contextWindow: 200_000,
        // Price tables apply only to explicitly catalogued versions.
        ...(version.minor === 0 && version.family === "sonnet"
          ? {
              pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
            }
          : {}),
      };
    }
    if (/^claude-3-/.test(name))
      return { tools: true, vision: true, cache: true, reasoning: false, contextWindow: 200_000 };
  }
  if (protocol === undefined || protocol === "openai-chat" || protocol === "openai-responses") {
    if (/^gpt-5(?:[.-]|$)/.test(name))
      return {
        tools: true,
        vision: true,
        cache: true,
        reasoning: true,
        effort: true,
        contextWindow: 400_000,
        maxOutputTokens: 128_000,
      };
    if (/^o[134](?:-|$)/.test(name)) return { reasoning: true, effort: true, contextWindow: 200_000 };
    if (/^gpt-4o(?:-|$)/.test(name))
      return { tools: true, vision: true, cache: true, reasoning: false, contextWindow: 128_000 };
    if (/^gpt-4\.1(?:-|$)/.test(name))
      return { tools: true, vision: true, cache: true, reasoning: false, contextWindow: 1_047_576 };
  }
  if (protocol === undefined || protocol === "gemini") {
    if (/^gemini-2\.5-/.test(name))
      return {
        tools: true,
        vision: true,
        reasoning: true,
        effort: false,
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
      };
    if (/^gemini-3(?:[.-]|$)/.test(name))
      return {
        tools: true,
        vision: true,
        reasoning: true,
        effort: true,
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
      };
  }
  return {};
}

export function effectiveModelMetadata(
  profile: Pick<ModelProfileConfig, "model" | "protocol" | "capabilities">,
): EffectiveModelMetadata {
  const known = catalogCapabilities(profile.model, profile.protocol);
  const override = profile.capabilities ?? {};
  const merged = { ...known, ...override };
  return {
    tools: merged.tools ?? true,
    vision: merged.vision ?? false,
    cache: merged.cache ?? false,
    reasoning: merged.reasoning ?? false,
    adaptiveReasoning: profile.protocol === "anthropic" && (merged.adaptiveReasoning ?? false),
    interleavedReasoning: profile.protocol === "anthropic" && (merged.interleavedReasoning ?? false),
    effort: merged.effort ?? false,
    contextWindow: merged.contextWindow ?? UNKNOWN_CONTEXT_WINDOW,
    contextWindowSource: override.contextWindow ? "profile" : known.contextWindow ? "catalog" : "estimate",
    ...(merged.maxOutputTokens ? { maxOutputTokens: merged.maxOutputTokens } : {}),
    ...(merged.pricing ? { pricing: merged.pricing } : {}),
  };
}

const metadata = defineRuntimeState("modelMetadata", () => new Map<string, EffectiveModelMetadata>());
/** Snapshot metadata by profile ID for synchronous budget calculations. Never stores secrets. */
export function registerModelMetadata(id: string, profile: ModelProfileConfig): void {
  metadata().set(id, effectiveModelMetadata(profile));
}
export function replaceModelMetadata(profiles: Record<string, ModelProfileConfig>): void {
  metadata().clear();
  for (const [id, profile] of Object.entries(profiles)) registerModelMetadata(id, profile);
}
export function getModelMetadata(id: string): EffectiveModelMetadata {
  const saved = metadata().get(id);
  if (saved) return saved;
  const known = catalogCapabilities(id);
  return {
    tools: known.tools ?? true,
    vision: known.vision ?? false,
    cache: known.cache ?? false,
    reasoning: known.reasoning ?? false,
    adaptiveReasoning: known.adaptiveReasoning ?? false,
    interleavedReasoning: known.interleavedReasoning ?? false,
    effort: known.effort ?? false,
    contextWindow: known.contextWindow ?? UNKNOWN_CONTEXT_WINDOW,
    contextWindowSource: known.contextWindow ? "catalog" : "estimate",
    ...(known.maxOutputTokens ? { maxOutputTokens: known.maxOutputTokens } : {}),
    ...(known.pricing ? { pricing: known.pricing } : {}),
  };
}
