import { modelBrand } from "../design/BrandIcon";
import { useSettings } from "../state/settings";
import type { ProviderConfig } from "./models";

export interface ModelInfo {
  /** Profile handle used by `--model` and `/model`. */
  id: string;
  label: string;
  provider: string;
  providerId: string;
  providerIcon: string | null;
  /** Logo of the model family. */
  icon: string | null;
  context: number;
  note?: string;
  thinking: boolean;
  vision: boolean;
  tools: boolean;
  healthy: boolean;
}

/** Every enabled model of every enabled provider, as the pickers show them. */
export function listModels(providers: ProviderConfig[], includeDisabled = false): ModelInfo[] {
  const checks = useSettings.getState().checks;
  return providers
    .filter((p) => includeDisabled || p.enabled)
    .flatMap((p) =>
      p.models
        .filter((m) => includeDisabled || m.enabled)
        .map((m) => ({
          id: m.handle,
          label: m.name,
          provider: p.name,
          providerId: p.id,
          providerIcon: p.icon,
          icon: modelBrand(m.model) ?? p.icon,
          context: m.contextWindow,
          ...(m.note ? { note: m.note } : {}),
          thinking: m.capabilities.reasoning,
          vision: m.capabilities.vision,
          tools: m.capabilities.tools,
          healthy: checks[p.id]?.ok !== false || checks[p.id]?.checking === true,
        })),
    );
}

const FALLBACK: Omit<ModelInfo, "id" | "label" | "icon"> = {
  provider: "—",
  providerId: "",
  providerIcon: null,
  context: 32_000,
  note: "profile 未配置；请到模型设置中选择，窗口为估算",
  thinking: false,
  vision: false,
  tools: true,
  healthy: true,
};

/** Resolve a stable profile ID. Unknown IDs stay visibly unconfigured. */
export function modelById(id: string): ModelInfo {
  const all = listModels(useSettings.getState().providers, true);
  return all.find((m) => m.id === id) ?? { ...FALLBACK, id, label: id || "未设置", icon: modelBrand(id) };
}
