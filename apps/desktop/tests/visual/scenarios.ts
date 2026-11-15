import type { Prefs } from "../../src/shared/contract";

/**
 * A state of the style reference (`web-ui/`, opened with `query`) and the
 * preferences that bring the client to the same state. Each scenario has a
 * baseline screenshot in `baseline/<name>.png`.
 */
export interface Scenario {
  name: string;
  query: string;
  prefs: Partial<Prefs>;
  requestView?: "context" | "compare";
}

export const SCENARIOS: Scenario[] = [
  { name: "first-run-dark", query: "workspace=none&theme=dark", prefs: { theme: "dark" } },
  { name: "first-run-light", query: "workspace=none&theme=light", prefs: { theme: "light" } },
  { name: "first-run-light-ember", query: "workspace=none&theme=light&accent=ember", prefs: { theme: "light", accent: "ember" } },
  { name: "first-run-sidebar-off-dark", query: "workspace=none&theme=dark&sidebar=off", prefs: { theme: "dark", sidebarOpen: false } },
  ...(["dark", "light"] as const).flatMap((theme) => [
    { name: `request-context-${theme}`, query: `requestView=context&theme=${theme}`, prefs: { theme }, requestView: "context" as const },
    { name: `request-comparison-${theme}`, query: `requestView=compare&theme=${theme}`, prefs: { theme }, requestView: "compare" as const },
  ]),
];

/** Regions that differ for reasons other than styling: native traffic lights and the OS user name. */
export const MASK_SELECTOR = "[data-visual-mask]";
