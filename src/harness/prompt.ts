/**
 * How an Agent shapes the system prompt: the identity text
 * (`prompt.identity`), dynamic sections turned off, replaced, moved, or added
 * (`prompt.sections`), and the context sources it loads (`context.*`).
 *
 * A section entry is `false` (leave the section out), `true` (keep it), or an
 * object: `text` or `file` replaces a built-in section's text or makes a new
 * section, and `after` names the section it follows. `after: "instructions"`
 * puts it first in the dynamic block. A new section without `after` goes
 * last. The static block (identity and coding instructions) is not a
 * dynamic section: `prompt.identity` replaces the identity, and an output
 * style can leave out the coding instructions.
 */

import type { PromptSection, PromptSectionName } from "../context/systemPrompt.js";
import { describeSource } from "./format.js";
import type { ResolvedHarness } from "./resolve.js";

/** Built-in dynamic sections in prompt order, with what each holds. */
export const DYNAMIC_SECTIONS: Record<PromptSectionName, string> = {
  output_style: "Instructions of the active output style.",
  language: "The reply language from the language setting.",
  environment: "Working directory, date, operating system, and the git snapshot.",
  agent_md: "AGENTS.md and AGENT.md files.",
  memory: "How to use project memory, and its index.",
  session_instructions: "Extra instructions a caller passes for the session; nothing passes them yet.",
  skills: "The skill listing.",
  agents: "The sub-agent listing.",
  team: "Agent Teams instructions.",
};

const DYNAMIC_SECTION_NAMES = new Set<string>(Object.keys(DYNAMIC_SECTIONS));
/** The static block; `after` may name `instructions` to put a section first in the dynamic block. */
const STATIC_SECTION_NAMES = ["identity", "instructions"];
const TOP = "instructions";

export type ContextSourceName = "agent_md" | "memory" | "environment" | "git_status" | "skills" | "agents";

/** Where dynamic context comes from, and the prompt section it fills. */
export const CONTEXT_SOURCES: readonly {
  name: ContextSourceName;
  specKey: string;
  section: PromptSectionName;
  description: string;
}[] = [
  { name: "agent_md", specKey: "context.agentMd", section: "agent_md", description: "AGENTS.md and AGENT.md files." },
  { name: "memory", specKey: "context.memory", section: "memory", description: "The project memory index." },
  {
    name: "environment",
    specKey: "context.environment",
    section: "environment",
    description: "Working directory, date, and operating system.",
  },
  {
    name: "git_status",
    specKey: "context.gitStatus",
    section: "environment",
    description: "Git branch, status, and latest commit when the session starts.",
  },
  { name: "skills", specKey: "context.skills", section: "skills", description: "The skill listing." },
  { name: "agents", specKey: "context.agents", section: "agents", description: "The sub-agent listing." },
];

/** A `prompt.sections` entry after `file` references are loaded into `text`. */
export type PromptSectionSetting = boolean | { text?: string; file?: string; after?: string };

export function promptSectionSettings(resolved: ResolvedHarness): Readonly<Record<string, PromptSectionSetting>> {
  return (resolved.values["prompt.sections"]?.value as Record<string, PromptSectionSetting> | undefined) ?? {};
}

/** The Agent's identity text, or undefined to keep the built-in one. */
export function identityText(resolved: ResolvedHarness): string | undefined {
  const value = resolved.values["prompt.identity"]?.value as { text: string } | undefined;
  return value === undefined ? undefined : value.text.trim();
}

export function contextSourceOn(resolved: ResolvedHarness, source: ContextSourceName): boolean {
  const key = CONTEXT_SOURCES.find((entry) => entry.name === source)!.specKey;
  return resolved.values[key]?.value !== false;
}

/** Whether a built-in section keeps its built-in text: `prompt.sections` neither turns it off nor replaces it. */
export function keepsBuiltInText(resolved: ResolvedHarness | undefined, section: PromptSectionName): boolean {
  if (!resolved) return true;
  const setting = promptSectionSettings(resolved)[section];
  return setting !== false && !(typeof setting === "object" && setting.text !== undefined);
}

/**
 * Whether the prompt loads `source`: it is on and the section it fills keeps
 * its built-in text. Without an Agent every source loads.
 */
export function contextSourceLoaded(resolved: ResolvedHarness | undefined, source: ContextSourceName): boolean {
  if (!resolved) return true;
  const { section } = CONTEXT_SOURCES.find((entry) => entry.name === source)!;
  return contextSourceOn(resolved, source) && keepsBuiltInText(resolved, section);
}

/** Why the Agent does not load `source`, or undefined when it does. */
export function contextSourceOffReason(resolved: ResolvedHarness, source: ContextSourceName): string | undefined {
  const key = CONTEXT_SOURCES.find((entry) => entry.name === source)!.specKey;
  const entry = resolved.values[key];
  return entry?.value === false ? `Turned off by ${key} (${describeSource(entry.source, entry.detail)}).` : undefined;
}

function sectionsSource(resolved: ResolvedHarness): string {
  const entry = resolved.values["prompt.sections"]!;
  return describeSource(entry.source, entry.detail);
}

/**
 * Why a built-in prompt section is left out, or undefined while it can have
 * text: `prompt.sections` turned it off, or every context source it shows is
 * off. The memory section keeps its instructions without the index, so only
 * `prompt.sections` turns it off.
 */
export function promptSectionOffReason(resolved: ResolvedHarness, name: string): string | undefined {
  if (name === "identity") return identityText(resolved) === "" ? "prompt.identity is empty." : undefined;
  if (promptSectionSettings(resolved)[name] === false) {
    return `Turned off by prompt.sections (${sectionsSource(resolved)}).`;
  }
  const sources = CONTEXT_SOURCES.filter((source) => source.section === name && source.name !== "memory");
  if (sources.length === 0 || promptSectionReplacement(resolved, name)) return undefined;
  const reasons = sources.map((source) => contextSourceOffReason(resolved, source.name));
  return reasons.every(Boolean) ? reasons.join(" ") : undefined;
}

/** What the Agent puts in place of a built-in section's text, or undefined when it keeps the built-in text. */
export function promptSectionReplacement(resolved: ResolvedHarness, name: string): string | undefined {
  if (name === "identity") {
    const entry = resolved.values["prompt.identity"];
    const value = entry?.value as { text: string; file?: string } | undefined;
    if (!value) return undefined;
    return `Text from ${describeSource(entry!.source, entry!.detail)}${value.file ? ` (${value.file})` : ""}.`;
  }
  const setting = promptSectionSettings(resolved)[name];
  if (typeof setting !== "object" || setting.text === undefined) return undefined;
  return `Text from ${sectionsSource(resolved)}${setting.file ? ` (${setting.file})` : ""}.`;
}

/** Sections the Agent adds, in the order its spec lists them. */
export function addedPromptSections(resolved: ResolvedHarness): { name: string; text: string; file?: string }[] {
  return Object.entries(promptSectionSettings(resolved)).flatMap(([name, setting]) =>
    !DYNAMIC_SECTION_NAMES.has(name) &&
    !STATIC_SECTION_NAMES.includes(name) &&
    typeof setting === "object" &&
    setting.text !== undefined
      ? [{ name, text: setting.text, ...(setting.file ? { file: setting.file } : {}) }]
      : [],
  );
}

const afterOf = (setting: PromptSectionSetting | undefined): string | undefined =>
  typeof setting === "object" ? setting.after : undefined;

/**
 * Apply `prompt.sections` to the built-in dynamic sections: turn sections
 * off, replace their text, add new ones, and place every section that names
 * an `after` right behind that section (several behind one section keep the
 * order of the built-in list, then the spec). A section whose `after` names
 * nothing, or that is part of an `after` cycle, keeps its own place.
 */
export function arrangePromptSections(
  builtIn: readonly PromptSection[],
  settings: Readonly<Record<string, PromptSectionSetting>>,
): PromptSection[] {
  const sections = new Map<string, PromptSection>(builtIn.map((section) => [section.name, { ...section }]));
  const order = builtIn.map((section) => section.name);
  for (const [name, setting] of Object.entries(settings)) {
    if (STATIC_SECTION_NAMES.includes(name)) continue;
    const section = sections.get(name);
    if (section) {
      if (setting === false) section.text = "";
      else if (typeof setting === "object" && setting.text !== undefined) section.text = setting.text.trim();
    } else if (typeof setting === "object" && setting.text !== undefined) {
      sections.set(name, { name, text: setting.text.trim() });
      order.push(name);
    }
  }

  const followers = new Map<string, string[]>();
  const anchors: string[] = [];
  for (const name of order) {
    const after = afterOf(settings[name]);
    if (after !== undefined && after !== name && (after === TOP || sections.has(after))) {
      followers.set(after, [...(followers.get(after) ?? []), name]);
    } else anchors.push(name);
  }
  const placed: PromptSection[] = [];
  const visited = new Set<string>();
  const visit = (name: string) => {
    if (visited.has(name)) return;
    visited.add(name);
    const section = sections.get(name);
    if (section) placed.push(section);
    for (const follower of followers.get(name) ?? []) visit(follower);
  };
  visit(TOP);
  for (const name of anchors) visit(name);
  // Only sections in an `after` cycle are left; they keep the order they were listed in.
  for (const name of order) visit(name);
  return placed;
}

/** Problems with `prompt.sections`, reported when the runtime starts. */
export function promptSectionProblems(resolved: ResolvedHarness): string[] {
  const settings = promptSectionSettings(resolved);
  const added = new Set(addedPromptSections(resolved).map((section) => section.name));
  const known = (name: string) => DYNAMIC_SECTION_NAMES.has(name) || added.has(name);
  const problems: string[] = [];
  for (const [name, setting] of Object.entries(settings)) {
    if (STATIC_SECTION_NAMES.includes(name)) {
      problems.push(
        `prompt.sections.${name}: identity and instructions are static; set prompt.identity, or use an output style that leaves out the coding instructions`,
      );
      continue;
    }
    if (!known(name)) {
      problems.push(`prompt.sections.${name} names no built-in section and has no text or file`);
      continue;
    }
    const after = afterOf(setting);
    if (after === undefined) continue;
    if (after === name) problems.push(`prompt.sections.${name}.after names the section itself`);
    else if (after !== TOP && !known(after)) problems.push(`prompt.sections.${name}.after names no section: ${after}`);
  }

  const reported = new Set<string>();
  for (const start of Object.keys(settings)) {
    const path = [start];
    let next = afterOf(settings[start]);
    while (next !== undefined && known(next) && !path.includes(next)) {
      path.push(next);
      next = afterOf(settings[next]);
    }
    if (next !== start || path.length < 2) continue;
    const key = [...path].sort().join("\u0000");
    if (reported.has(key)) continue;
    reported.add(key);
    problems.push(`prompt.sections: after forms a cycle: ${[...path, start].join(" → ")}`);
  }
  return problems;
}
