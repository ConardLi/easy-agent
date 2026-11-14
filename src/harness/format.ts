/** Plain-text views of a resolved harness and of a comparison, for the CLI and `/harness`. */

import type { BuiltInComponent } from "./components.js";
import type { HarnessDiff, HarnessDiffSide } from "./diff.js";
import { HARNESS_KEYS } from "./keys.js";
import type { HarnessListing } from "./manage.js";
import type { RequestComponentKind, RequestDiff } from "./requestDiff.js";
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

/** A loaded skill or sub-agent the Agent leaves out (`skills.*`, `agents.*`). */
export interface LeftOutResource {
  kind: "skill" | "agent";
  name: string;
  reason: string;
}

export function formatHarness(
  resolved: ResolvedHarness,
  components: readonly BuiltInComponent[] = [],
  leftOut: readonly LeftOutResource[] = [],
): string {
  const lines: string[] = [];
  const builtInOnly = resolved.chain.length === 0;
  lines.push(
    `Agent: ${resolved.name}${builtInOnly ? " (built-in)" : ` (${["built-in default", ...resolved.chain].join(" → ")})`}`,
  );
  const by = resolved.selectedBy;
  if (by?.source === "local") {
    lines.push(`Selected as the workspace's default Agent${by.path ? ` (harness in ${by.path})` : ""}`);
  } else if (by?.source === "session") {
    lines.push(`Selected as the Agent session ${by.sessionId} last ran with`);
  }
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
      const replaced = ofKind.filter((item) => item.enabled && item.replacedBy);
      if (replaced.length)
        lines.push(`  ${"".padEnd(16)} text: ${replaced.map((item) => `${item.id} (${item.replacedBy})`).join(", ")}`);
    }
  }
  if (leftOut.length > 0) {
    lines.push("", "Left out");
    for (const kind of ["skill", "agent"] as const) {
      const ofKind = leftOut.filter((item) => item.kind === kind);
      if (ofKind.length)
        lines.push(`  ${kind.padEnd(16)} ${ofKind.map((item) => `${item.name} (${item.reason})`).join(", ")}`);
    }
  }
  return lines.join("\n");
}

/** `eagent harness list` and `/harness list`. */
export function formatHarnessList(listing: HarnessListing): string {
  const width = Math.max(12, ...listing.harnesses.map((agent) => agent.name.length + 2));
  const lines = [`Agents (${listing.path})`];
  for (const agent of listing.harnesses) {
    const notes = [
      agent.builtIn ? (agent.defined ? "built-in, changed" : "built-in") : `extends ${agent.extends}`,
      agent.projectDefault ? "this workspace's default" : "",
      agent.errors.length ? `error: ${agent.errors.join("; ")}` : "",
    ].filter(Boolean);
    lines.push(
      `  ${agent.name.padEnd(width)}${notes.join(", ")}${agent.description ? `\n  ${"".padEnd(width)}${agent.description}` : ""}`,
    );
  }
  const project = listing.projectDefault;
  if (project && !project.applied) {
    lines.push("", `harness "${project.name}" in ${project.path} is ignored: ${project.reason}.`);
  } else if (!project) {
    lines.push("", "This workspace uses default. Set its default Agent with /harness use <name>.");
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

const KIND_TITLES: Record<RequestComponentKind, string> = {
  prompt_section: "Prompt sections",
  context_source: "Context sources",
  tool: "Tools",
  message: "Messages",
};
/** Changed lines shown per component; the JSON output has them all. */
const MAX_CHANGED_LINES = 12;
const MAX_LINE_LENGTH = 160;

const count = (n: number) => n.toLocaleString("en-US");
const signed = (n: number) => (n > 0 ? `+${count(n)}` : n < 0 ? `-${count(-n)}` : "0");
const clip = (text: string) => (text.length > MAX_LINE_LENGTH ? `${text.slice(0, MAX_LINE_LENGTH - 1)}…` : text);
const paramText = (value: unknown) => (value === undefined ? "unset" : JSON.stringify(value));

/** The first requests two Agents render for one input, compared by component. */
export function formatRequestDiff(diff: RequestDiff): string {
  const { a, b } = diff;
  const lines = [`First request for ${JSON.stringify(diff.prompt)}: ${a.harness.name} → ${b.harness.name}`];
  const model = (side: typeof a) => `${side.model} (${side.protocol})`;
  lines.push(`  model: ${model(a) === model(b) ? model(a) : `${model(a)} → ${model(b)}`}`);

  const rows: Array<[string, number, number]> = [
    ["system prompt", a.tokens.system, b.tokens.system],
    ["tools", a.tokens.tools, b.tokens.tools],
    ["messages", a.tokens.messages, b.tokens.messages],
    ["total", a.tokens.total, b.tokens.total],
  ];
  const labelWidth = Math.max(...rows.map(([label]) => label.length)) + 2;
  const columns = [a.harness.name, b.harness.name, "change"];
  const width = Math.max(
    10,
    ...columns.map((column) => column.length + 2),
    ...rows.map(([, x]) => count(x).length + 2),
  );
  lines.push(`  ${"tokens".padEnd(labelWidth)}${columns.map((column) => column.padStart(width)).join("")}`);
  for (const [label, x, y] of rows) {
    lines.push(
      `  ${label.padEnd(labelWidth)}${[count(x), count(y), signed(y - x)].map((v) => v.padStart(width)).join("")}`,
    );
  }
  lines.push("  Token figures are estimated from sizes; nothing was sent.");

  if (diff.params.length > 0) {
    lines.push("", "Request parameters");
    for (const param of diff.params) lines.push(`  ${param.key}: ${paramText(param.a)} → ${paramText(param.b)}`);
  }

  for (const kind of Object.keys(KIND_TITLES) as RequestComponentKind[]) {
    const group = diff.components.filter((component) => component.kind === kind);
    if (group.length === 0) continue;
    lines.push("", KIND_TITLES[kind]);
    for (const component of group) {
      const mark = component.change === "added" ? "+" : component.change === "removed" ? "-" : "~";
      const tokens =
        component.change === "changed"
          ? `${count(component.a!.tokens)} → ${count(component.b!.tokens)} tokens (${signed(component.tokens)})`
          : `${count((component.a ?? component.b)!.tokens)} tokens, only in ${component.change === "added" ? b.harness.name : a.harness.name}`;
      lines.push(`  ${mark} ${component.id}  ${tokens}`);
      const changed = component.lines ?? [];
      for (const line of changed.slice(0, MAX_CHANGED_LINES)) lines.push(`      ${line.op} ${clip(line.text)}`);
      if (changed.length > MAX_CHANGED_LINES) {
        lines.push(`      … ${changed.length - MAX_CHANGED_LINES} more changed lines (--json shows all)`);
      }
    }
  }

  const differing = diff.components.length;
  lines.push(
    "",
    differing === 0 && diff.params.length === 0
      ? `The two requests carry the same content (${count(diff.unchanged)} components).`
      : `${differing === 1 ? "1 component differs" : `${differing} components differ`}; ${count(diff.unchanged)} ${diff.unchanged === 1 ? "is" : "are"} the same.`,
  );
  return lines.join("\n");
}
