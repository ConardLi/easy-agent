/**
 * What the Agent page shows and writes, built from the Agent's own data:
 * the stored spec (`harness/read`), every resolved setting with the layer it
 * came from (`runtime/harness`), and the components as that Agent has them
 * (`runtime/inventory` with `harness`).
 *
 * A switch writes one whole leaf key into the Agent's own spec: a child's
 * `tools.exclude`, `prompt.sections`, … replace its parent's, so the value
 * the Agent has now (its own or inherited) is copied and then changed.
 */

import type { HarnessLayerSource, ResolvedHarness, ResolvedHarnessValue } from "../../../shared/agent";

export type HarnessTab = "prompt" | "context" | "tools" | "skills" | "agents" | "mcp" | "compaction" | "features" | "other";

export const HARNESS_TABS: { id: HarnessTab; label: string }[] = [
  { id: "prompt", label: "提示词" },
  { id: "context", label: "上下文" },
  { id: "tools", label: "工具" },
  { id: "skills", label: "技能" },
  { id: "agents", label: "子 Agent" },
  { id: "mcp", label: "MCP" },
  { id: "compaction", label: "压缩" },
  { id: "features", label: "功能" },
  { id: "other", label: "其他" },
];

export const SETTINGS_FILE = "~/.easy-agent/settings.json";
export const PROMPTS_DIR = "~/.easy-agent/prompts/";

export const LAYER_LABEL: Record<HarnessLayerSource, string> = {
  "built-in": "内置",
  user: "全局设置",
  harness: "Agent",
  project: "项目设置",
  local: "本机设置",
  environment: "环境变量",
  flag: "命令行",
  policy: "托管策略",
};

const LAYER_FILE: Partial<Record<HarnessLayerSource, string>> = {
  user: "~/.easy-agent/settings.json",
  project: ".easy-agent/settings.json",
  local: ".easy-agent/settings.local.json",
  policy: "managed-settings.json",
};

/** Labels for prompt sections and context sources; unknown names show as they are. */
export const SECTION_LABEL: Record<string, string> = {
  identity: "身份",
  instructions: "编码指令",
  output_style: "输出风格",
  language: "回复语言",
  environment: "环境",
  agent_md: "规则文件",
  memory: "项目记忆",
  session_instructions: "会话指令",
  skills: "技能清单",
  agents: "子 Agent 清单",
  team: "团队",
};

export const SECTION_HINT: Record<string, string> = {
  identity: "Agent 是谁，文件工具能碰哪些目录",
  instructions: "怎么改代码、怎么验证。由输出风格决定是否保留",
  output_style: "当前输出风格的说明",
  language: "设置里的回复语言",
  environment: "工作目录、日期、系统和 git 快照",
  agent_md: "AGENTS.md 和 AGENT.md",
  memory: "怎么用项目记忆，以及记忆索引",
  session_instructions: "调用方给这个会话的额外指令",
  skills: "模型能调用的技能列表",
  agents: "模型能派出的子 Agent 列表",
  team: "Agent Teams 的说明，没有团队时为空",
};

export const CONTEXT_LABEL: Record<string, { label: string; hint: string }> = {
  agent_md: { label: "规则文件", hint: "加载 AGENTS.md 和 AGENT.md" },
  memory: { label: "项目记忆", hint: "加载项目记忆的索引" },
  environment: { label: "运行环境", hint: "工作目录、日期和操作系统" },
  git_status: { label: "Git 状态", hint: "会话开始时的分支、改动和最近一次提交" },
  skills: { label: "技能清单", hint: "把技能列表写进系统提示词" },
  agents: { label: "子 Agent 清单", hint: "把子 Agent 列表写进系统提示词" },
};

/** Where a value comes from, for the source tag: built in, this Agent, an Agent it extends, or a layer above. */
export function sourceText(v: Pick<ResolvedHarnessValue, "source" | "detail">, agent: string): string {
  if (v.source === "harness") return v.detail === agent ? "这个 Agent" : `继承自 ${v.detail}`;
  return LAYER_LABEL[v.source];
}

/** Layers above the Agent decide the value: the control is locked and the row says by what. */
export function lockedBy(v: Pick<ResolvedHarnessValue, "source" | "detail"> | undefined): string | undefined {
  if (!v || v.source === "built-in" || v.source === "harness" || v.source === "user") return undefined;
  const file = LAYER_FILE[v.source];
  const where = v.source === "environment" ? v.detail : [file, v.detail].filter(Boolean).join(" 的 ");
  return `${v.source === "policy" ? "被托管策略收紧" : `被${LAYER_LABEL[v.source]}覆盖`}${where ? `：${where}` : ""}`;
}

/** The tooltip of a source tag: the key it is stored under, or the file or variable that set it. */
export function sourceTitle(v: Pick<ResolvedHarnessValue, "source" | "detail">, path: string): string {
  if (v.source === "harness") return `harnesses.${v.detail}.${path}`;
  if (v.source === "built-in") return "内置预设的值";
  return lockedBy(v) ?? `${LAYER_FILE[v.source] ?? LAYER_LABEL[v.source]}${v.detail ? ` 的 ${v.detail}` : ""}`;
}

export type SelectionKind = "tools" | "skills" | "agents" | "mcpServers";

function matches(entry: string, name: string): boolean {
  if (!entry.includes("*")) return entry === name;
  return new RegExp(
    `^${entry
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  ).test(name);
}

const listAt = (resolved: ResolvedHarness, path: string) => {
  const value = resolved.values[path]?.value;
  return Array.isArray(value) ? (value as string[]) : undefined;
};

/** "这个 Agent 的" or "从 reviewer 继承的", before a key name. */
const whose = (v: ResolvedHarnessValue, agent: string) => (v.detail === agent ? "这个 Agent 的" : `从 ${v.detail} 继承的`);

/** Whether the Agent keeps an item by its include and exclude lists, and why not. */
export function selectionState(resolved: ResolvedHarness, kind: SelectionKind, name: string): { on: boolean; reason?: string; from?: ResolvedHarnessValue } {
  const agent = resolved.name;
  const exclude = resolved.values[`${kind}.exclude`];
  if (exclude && listAt(resolved, `${kind}.exclude`)?.some((entry) => matches(entry, name))) {
    return { on: false, reason: `${whose(exclude, agent)} ${kind}.exclude 去掉了它`, from: exclude };
  }
  const include = resolved.values[`${kind}.include`];
  const kept = listAt(resolved, `${kind}.include`);
  if (include && kept && !kept.some((entry) => matches(entry, name))) {
    return { on: false, reason: `不在${whose(include, agent)} ${kind}.include 里`, from: include };
  }
  return { on: true };
}

/** Set (or with undefined remove) one leaf key in a copy of the spec. */
export function setKey(spec: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const next = structuredClone(spec);
  const parts = path.split(".");
  let current: Record<string, unknown> = next;
  for (const part of parts.slice(0, -1)) {
    const child = current[part];
    if (!child || typeof child !== "object" || Array.isArray(child)) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1]!;
  if (value === undefined) delete current[last];
  else current[last] = value;
  // Drop objects the removal left empty, so the spec stays as small as the user wrote it.
  if (value === undefined && parts.length > 1 && Object.keys(current).length === 0) return setKey(next, parts.slice(0, -1).join("."), undefined);
  return next;
}

/**
 * The spec after turning items on or off: the lists the Agent has now (its
 * own or inherited) are copied and changed. With an `include` list, turning
 * an item on adds it there too.
 */
export function applySelection(
  spec: Record<string, unknown>,
  resolved: ResolvedHarness,
  kind: SelectionKind,
  changes: readonly (readonly [name: string, on: boolean])[],
): Record<string, unknown> {
  const before = { include: listAt(resolved, `${kind}.include`), exclude: listAt(resolved, `${kind}.exclude`) ?? [] };
  let include = before.include;
  let exclude = before.exclude;
  for (const [name, on] of changes) {
    if (on) {
      if (exclude.some((entry) => matches(entry, name))) exclude = exclude.filter((entry) => !matches(entry, name));
      if (include && !include.some((entry) => matches(entry, name))) include = [...include, name];
    } else if (include?.includes(name)) include = include.filter((entry) => entry !== name);
    // Kept by a pattern (or by having no include list): exclude it by name, which leaves the pattern's other matches alone.
    else if (!exclude.includes(name)) exclude = [...exclude, name];
  }
  let next = spec;
  if (include !== before.include) next = setKey(next, `${kind}.include`, include);
  if (exclude !== before.exclude) next = setKey(next, `${kind}.exclude`, exclude);
  return next;
}

export const toggleSelection = (spec: Record<string, unknown>, resolved: ResolvedHarness, kind: SelectionKind, name: string, on: boolean) =>
  applySelection(spec, resolved, kind, [[name, on]]);

/** Whether an inventory item is off because the Agent's include or exclude list leaves it out. */
export const offByAgent = (kind: SelectionKind, reason: string | undefined) => !!reason && new RegExp(`^(Left out by|Not in) ${kind}\\.`).test(reason);

export type SectionSetting = boolean | { text?: string; file?: string; after?: string };

/**
 * `prompt.sections` as the Agent has it, in spec form: the resolved value
 * carries the text of every referenced file next to its path, and a spec
 * entry holds one of the two.
 */
export function specSections(resolved: ResolvedHarness): Record<string, SectionSetting> {
  const value = (resolved.values["prompt.sections"]?.value ?? {}) as Record<string, SectionSetting>;
  return Object.fromEntries(
    Object.entries(value).map(([name, setting]) => {
      if (typeof setting !== "object") return [name, setting];
      const { text, file, after } = setting;
      return [name, { ...(file ? { file } : { text: text ?? "" }), ...(after ? { after } : {}) }];
    }),
  );
}

/** Turn a section on or off. On writes `true`, so an Agent it extends cannot turn it off again. */
export function toggleSection(resolved: ResolvedHarness, name: string, on: boolean): Record<string, SectionSetting> {
  const sections = specSections(resolved);
  if (on) return { ...sections, [name]: typeof sections[name] === "object" ? sections[name] : true };
  return { ...sections, [name]: false };
}

/** Prompt file a text editor writes for an Agent's identity or one of its sections. */
export const promptFileName = (agent: string, section: string) => `${agent}.${section}.md`;

/** Section names an Agent can add: lowercase, no clash with built-in names. */
export const SECTION_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Agent names (`harnesses` keys). */
export const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Short text for a value in the read-only list. */
export function formatValue(value: unknown): string {
  if (value === undefined) return "未设置";
  if (typeof value === "boolean") return value ? "开" : "关";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.length === 0 ? "无" : value.join(", ");
  return JSON.stringify(value);
}

/** Keys shown read-only on the 其他 tab: everything a switch on the other tabs does not edit. */
export const OTHER_KEYS = [
  "model.main",
  "model.roles.background",
  "model.roles.think",
  "model.roles.classifier",
  "permissions.mode",
  "permissions.allow",
  "permissions.ask",
  "permissions.deny",
  "sandbox.enabled",
  "hooks.enabled",
  "outputStyle",
  "prompt.language",
  "tools.respectGitignore",
  "session.checkpoints",
  "trace.level",
];
