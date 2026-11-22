import { effectiveModelMetadata, catalogCapabilities, canonicalModelName } from "../../../config/modelMetadata.js";
import { ConfigurationError } from "../../../config/values.js";
import { reasoningSettings, type EffortLevel, type ThinkingConfig } from "../../../utils/thinking.js";
import type { ModelProfile } from "./profile.js";

export function validateRequestLimits(profile: ModelProfile, maxTokens: number): void {
  const metadata = effectiveModelMetadata(profile);
  if (
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens >= metadata.contextWindow ||
    (metadata.maxOutputTokens !== undefined && maxTokens > metadata.maxOutputTokens)
  ) {
    throw new ConfigurationError(
      `models.${profile.id}.maxTokens`,
      "output tokens must be a positive integer within the model output and context limits; set capabilities for a custom model.",
    );
  }
}

/** Validate user intent before any network request, without silently changing model. */
export function resolveRequestReasoning(
  profile: ModelProfile,
  maxTokens: number,
  thinking?: ThinkingConfig,
  effort?: EffortLevel,
): {
  enabled: boolean;
  adaptive: boolean;
  interleaved: boolean;
  budgetTokens?: number;
  effort?: EffortLevel;
  off?: "none" | "budget-zero";
} {
  validateRequestLimits(profile, maxTokens);
  const metadata = effectiveModelMetadata(profile);
  const intent = reasoningSettings(thinking, effort);
  const fail = (field: string, message: string): never => {
    throw new ConfigurationError(`models.${profile.id}.${field}`, message);
  };
  if (intent.mode === "off") {
    const disabled = { enabled: false, adaptive: false, interleaved: false };
    const known = { ...catalogCapabilities(profile.model, profile.protocol), ...profile.capabilities };
    if (profile.protocol === "anthropic" || known.reasoning === false) return disabled;
    const name = canonicalModelName(profile.model);
    const option = profile.protocolOptions?.[profile.protocol]?.reasoningOff;
    if (
      profile.protocol.startsWith("openai") &&
      (option === "none" || (/^gpt-5\.[1-9]\d*(?:-|$)/.test(name) && !name.includes("-pro")))
    ) {
      return { ...disabled, off: "none" };
    }
    if (profile.protocol === "gemini" && (option === "budget-zero" || /^gemini-2\.5-flash(?:-|$)/.test(name))) {
      return { ...disabled, off: "budget-zero" };
    }
    fail(
      "reasoning.mode",
      "this model cannot be confirmed to disable reasoning. Use auto, choose a model that supports off, or declare the verified protocolOptions.reasoningOff mapping.",
    );
  }
  if (!metadata.reasoning && (intent.mode === "on" || intent.budgetTokens !== undefined)) {
    fail(
      "capabilities.reasoning",
      "reasoning is unsupported or unconfirmed; use auto/off, or explicitly declare the model's reasoning capability.",
    );
  }
  if (intent.effort && !metadata.effort) {
    fail(
      "capabilities.effort",
      "reasoning effort is unsupported or unconfirmed; remove effort or declare a verified capability on this profile.",
    );
  }
  if (intent.budgetTokens !== undefined) {
    if (!Number.isSafeInteger(intent.budgetTokens) || intent.budgetTokens < 1 || intent.budgetTokens >= maxTokens) {
      fail(
        "reasoning.budgetTokens",
        "reasoning budget must be positive and below the effective maximum output tokens.",
      );
    }
    if (profile.protocol.startsWith("openai"))
      fail(
        "reasoning.budgetTokens",
        "this protocol supports effort rather than a fixed token budget; configure reasoning.effort.",
      );
    if (profile.protocol === "anthropic" && intent.budgetTokens < 1024)
      fail("reasoning.budgetTokens", "Anthropic requires at least 1024 reasoning tokens.");
  }
  const enabled = metadata.reasoning;
  const options = profile.protocolOptions?.anthropic;
  return {
    enabled,
    adaptive:
      enabled && metadata.adaptiveReasoning && options?.adaptiveThinking !== false && intent.budgetTokens === undefined,
    interleaved: enabled && metadata.interleavedReasoning && options?.interleavedThinking !== false,
    ...(intent.budgetTokens !== undefined ? { budgetTokens: intent.budgetTokens } : {}),
    ...(intent.effort ? { effort: intent.effort } : {}),
  };
}
