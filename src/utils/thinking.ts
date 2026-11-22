/** Session controls express reasoning intent; protocol adapters implement it. */
import { activeHarness, harnessSetting } from "../harness/active.js";
import { defineSessionState } from "../state/sessionScope.js";
import { getModelMetadata } from "../config/modelMetadata.js";
import type { ReasoningSettings } from "../config/modelSchema.js";

export type ThinkingConfig =
  | { type: "auto" }
  | { type: "adaptive" }
  | { type: "enabled"; budgetTokens: number }
  | { type: "disabled" };
export type EffortLevel = "low" | "medium" | "high" | "max";

export const modelSupportsThinking = (model: string): boolean => getModelMetadata(model).reasoning;
export const modelSupportsAdaptiveThinking = (model: string): boolean => getModelMetadata(model).adaptiveReasoning;
export const modelSupportsInterleavedThinking = (model: string): boolean =>
  getModelMetadata(model).interleavedReasoning;
export const modelSupportsEffort = (model: string): boolean => getModelMetadata(model).effort;
export const shouldEnableThinkingByDefault = (): boolean => harnessSetting("reasoning.mode") !== "off";

const overrides = defineSessionState("thinkingOverrides", () => ({
  thinking: undefined as ThinkingConfig | undefined,
  effortOverridden: false,
  effort: undefined as EffortLevel | undefined,
}));

export function getSessionEffortLevel(): EffortLevel | undefined {
  if (activeHarness().values["reasoning.effort"]?.source === "policy") return harnessSetting("reasoning.effort");
  return overrides().effortOverridden ? overrides().effort : harnessSetting("reasoning.effort");
}
export function setSessionEffortLevel(level: EffortLevel | undefined): void {
  overrides().effortOverridden = true;
  overrides().effort = level;
}
export function setSessionThinkingConfig(cfg: ThinkingConfig | undefined): void {
  overrides().thinking = cfg;
}
export function getSessionThinkingConfig(): ThinkingConfig | undefined {
  return overrides().thinking;
}

export function reasoningSettings(
  request?: ThinkingConfig,
  effort?: EffortLevel,
): Required<Pick<ReasoningSettings, "mode">> & ReasoningSettings {
  const values = activeHarness().values;
  const override = request ?? overrides().thinking;
  const mode =
    values["reasoning.mode"]?.source === "policy" || !override
      ? harnessSetting<"auto" | "on" | "off">("reasoning.mode")
      : override.type === "disabled"
        ? "off"
        : override.type === "auto"
          ? "auto"
          : "on";
  const budgetTokens =
    values["reasoning.budgetTokens"]?.source === "policy"
      ? harnessSetting<number | undefined>("reasoning.budgetTokens")
      : override?.type === "enabled"
        ? override.budgetTokens
        : harnessSetting<number | undefined>("reasoning.budgetTokens");
  const effectiveEffort =
    values["reasoning.effort"]?.source === "policy"
      ? harnessSetting<EffortLevel | undefined>("reasoning.effort")
      : (effort ?? getSessionEffortLevel());
  return {
    mode: mode ?? "auto",
    ...(budgetTokens !== undefined ? { budgetTokens } : {}),
    ...(effectiveEffort ? { effort: effectiveEffort } : {}),
  };
}

export function buildDefaultThinkingConfig(): ThinkingConfig {
  const intent = reasoningSettings();
  if (intent.mode === "off") return { type: "disabled" };
  return intent.budgetTokens !== undefined
    ? { type: "enabled", budgetTokens: intent.budgetTokens }
    : { type: intent.mode === "auto" ? "auto" : "adaptive" };
}
