/** Plain-text views of a resolved harness and of a comparison, for the CLI and `/harness`. */

import type { BuiltInComponent } from "./components.js";
import type { HarnessDiff, HarnessDiffSide } from "./diff.js";
import { HARNESS_KEYS } from "./keys.js";
import type { HarnessContribution, ResolvedHarness } from "./resolve.js";

const LAYER_LABEL: Record<HarnessContribution["source"], string> = {
  "built-in": "built-in",
  user: "user settings",
  harness: "Agent",
  project: "project settings",
  local: "local settings",
  environment: "environment",
  flag: "flag",
  policy: "managed policy",
};

export function describeSource(source: HarnessContribution["source"], detail?: string): string {
  if (source === "harness") return `Agent "${detail}"`;
  return detail ? `${LAYER_LABEL[source]}: ${detail}` : LAYER_LABEL[source];
}

/** Compact value text; long text values show their length. */
export function formatValue(value: unknown): string {
  if (value === undefined) return "unset";
  if (typeof value === "string")
    return value.length > 60 ? `"${value.slice(0, 57)}…" (${value.length} chars)` : `"${value}"`;
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { text?: unknown }).text === "string"
  ) {
    const { text, file } = value as { text: string; file?: string };
    return `${text.length} chars${file ? ` from ${file}` : ""}`;
  }
  const json = JSON.stringify(value);
  return json.length > 80 ? `${json.slice(0, 77)}…` : json;
}

export function formatHarness(resolved: ResolvedHarness, components: readonly BuiltInComponent[] = []): string {
  const lines: string[] = [];
  const builtInOnly = resolved.chain.length === 0;
  lines.push(
    `Agent: ${resolved.name}${builtInOnly ? " (built-in)" : ` (${["built-in default", ...resolved.chain].join(" → ")})`}`,
  );
  lines.push(`Hash: ${resolved.hash}`);

  const errors = resolved.issues.filter((issue) => issue.level === "error");
  const warnings = resolved.issues.filter((issue) => issue.level === "warning");
  for (const [label, list] of [
    ["Errors", errors],
    ["Warnings", warnings],
  ] as const) {
    if (list.length === 0) continue;
    lines.push("", `${label}:`);
    for (const issue of list) {
      const where = [issue.harness ? `Agent "${issue.harness}"` : "", issue.path ?? ""].filter(Boolean).join(" ");
      lines.push(`  ${where ? `${where}: ` : ""}${issue.message}`);
    }
  }

  let component = "";
  for (const key of HARNESS_KEYS) {
    if (key.component !== component) {
      component = key.component;
      lines.push("", component);
    }
    const entry = resolved.values[key.path]!;
    const name = key.path.slice(key.component.length + 1) || key.path;
    const marks = [
      entry.applied ? "" : "not applied yet",
      entry.overridesHarness
        ? `overrides Agent "${entry.overridesHarness.harness}": ${formatValue(entry.overridesHarness.value)}`
        : "",
    ].filter(Boolean);
    lines.push(
      `  ${name.padEnd(26)} ${formatValue(entry.value)}  ← ${describeSource(entry.source, entry.detail)}${
        marks.length ? `  [${marks.join("; ")}]` : ""
      }`,
    );
    for (const ignored of entry.ignored) {
      lines.push(
        `  ${"".padEnd(26)} ignored ${describeSource(ignored.source, ignored.detail)} ${formatValue(ignored.value)}: ${ignored.reason}`,
      );
    }
  }

  if (components.length > 0) {
    lines.push("", "Built-in components");
    for (const kind of ["tool", "prompt_section", "context_source"] as const) {
      const ofKind = components.filter((item) => item.kind === kind);
      const off = ofKind.filter((item) => !item.enabled);
      lines.push(
        `  ${kind.padEnd(16)} ${ofKind
          .filter((item) => item.enabled)
          .map((item) => item.id)
          .join(", ")}`,
      );
      if (off.length)
        lines.push(`  ${"".padEnd(16)} off: ${off.map((item) => `${item.id} (${item.reason})`).join(", ")}`);
    }
  }
  return lines.join("\n");
}

const sideText = (s: HarnessDiffSide) => `${formatValue(s.value)} (${describeSource(s.source, s.detail)})`;

export function formatHarnessDiff(diff: HarnessDiff): string {
  const lines = [`${diff.a.name} → ${diff.b.name}`];
  if (diff.differences.length === 0) {
    lines.push("No differences.");
    return lines.join("\n");
  }
  for (const difference of diff.differences) {
    lines.push(`  ${difference.path}`, `    - ${sideText(difference.a)}`, `    + ${sideText(difference.b)}`);
  }
  lines.push(`${diff.differences.length} difference${diff.differences.length === 1 ? "" : "s"}.`);
  return lines.join("\n");
}
