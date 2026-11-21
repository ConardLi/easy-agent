import type { RequestDiff, SessionContext } from "../../../shared/agent";
import type { HarnessTab } from "../agents/model";

export type ContextData = SessionContext;
export type ComparisonData = RequestDiff;
export interface ConfigureTarget {
  tab: HarnessTab;
  row?: string;
}

export const GROUPS: Record<string, { label: string; color: string }> = {
  system: { label: "系统提示词", color: "#8b8b94" },
  tools: { label: "内置工具", color: "#a78bfa" },
  mcp: { label: "MCP", color: "#60a5fa" },
  skills: { label: "技能", color: "#f5a524" },
  plugins: { label: "插件", color: "#f472b6" },
  rules: { label: "规则", color: "#34d399" },
  messages: { label: "对话消息", color: "var(--accent)" },
  request: { label: "请求封装", color: "#8b8b94" },
};
const LABELS: Record<string, string> = {
  identity: "身份",
  instructions: "基础指令",
  output_style: "输出风格",
  language: "回复语言",
  environment: "环境信息",
  agent_md: "规则文件",
  memory: "项目记忆",
  session_instructions: "会话指令",
  skills: "技能清单说明",
  agents: "子 Agent 清单",
  team: "Agent 团队",
  user_input: "用户输入",
  user: "用户输入",
  assistant: "模型回复",
  tool_result: "工具结果",
  tool_results: "工具结果",
  command: "命令",
  skill_body: "技能正文",
  plan_attachment: "计划附件",
  background_notification: "后台通知",
  team_message: "团队消息",
  context_update: "上下文更新",
  hook_output: "Hook 输出",
  compaction_summary: "压缩摘要",
  deferred_tools: "延迟工具列表",
  meta: "隐藏提示",
  envelope: "模型与请求参数",
  framing: "JSON 结构",
  marker: "缓存边界",
};
const SOURCES: Record<string, string> = { "built-in": "内置", builtin: "内置", user: "全局", project: "项目", local: "本机", plugin: "插件", policy: "策略" };
export const number = (n: number) => n.toLocaleString("en-US");
export const delta = (n: number) => `${n > 0 ? "+" : ""}${number(n)}`;
export const partName = (part: string) => ({ system: "系统提示词", tools: "工具定义", messages: "消息", request: "请求封装" })[part] ?? part;

export function componentName(id: string): string {
  const [kind, ...rest] = id.split(":");
  const name = rest.join(":");
  if (kind === "skill" || kind === "agent") return `${kind === "skill" ? "/" : ""}${rest.slice(1).join(":")}`;
  if (kind === "rule") return name === "memory" ? "MEMORY.md" : name.split(/[\\/]/).at(-1) || name;
  return LABELS[name] ?? name;
}
export function componentSource(id: string, item?: { source?: string; pluginId?: string }): string {
  const [kind, source] = id.split(":");
  const origin = kind === "skill" || kind === "agent" ? source : item?.source;
  if (kind === "rule") return id.slice(5) === "memory" ? "项目记忆 · MEMORY.md" : id.slice(5);
  if (kind === "message") return `对话 · ${componentName(id)}`;
  return [SOURCES[origin ?? ""] ?? origin ?? partName(kind === "tool" ? "tools" : kind === "request" ? "request" : "system"), item?.pluginId]
    .filter(Boolean)
    .join(" · ");
}

/** Resolve switches from stable component IDs, never translated display labels. */
export function configureTarget(id: string, category?: string | null, item?: string | null): ConfigureTarget | undefined {
  const [kind, ...rest] = id.split(":");
  const name = rest.join(":");
  if (kind === "skill") return { tab: "skills", row: `skills:${rest.slice(1).join(":")}` };
  if (kind === "agent") return { tab: "agents", row: `agents:${rest.slice(1).join(":")}` };
  if (kind === "rule") return name === "memory" ? { tab: "context", row: "context.memory" } : { tab: "resources", row: `rules:${name}` };
  if (kind === "context_source")
    return { tab: "context", row: `context.${({ agent_md: "agentMd", git_status: "gitStatus" } as Record<string, string>)[name] ?? name}` };
  if (kind === "tool") {
    if (name.startsWith("mcp__")) return { tab: "mcp", row: `mcpServers:${name.slice(5).split("__")[0]}` };
    return { tab: "tools", row: `tools:${name}` };
  }
  if (kind === "prompt_section")
    return name === "instructions" ? undefined : { tab: "prompt", row: name === "identity" ? "prompt.identity" : `prompt_section:${name}` };
  if (kind === "prompt" && name === "marker") return { tab: "features", row: "features.promptCaching" };
  if (kind === "message") {
    if (name === "skill_body") return { tab: "skills" };
    if (name === "hook_output") return { tab: "resources", row: "hooks.enabled" };
    if (name === "compaction_summary") return { tab: "compaction", row: "compaction.auto" };
    if (name === "deferred_tools") return { tab: "features", row: "features.toolSearch" };
    if (name === "context_update") return { tab: "context" };
    return undefined;
  }
  if (category === "plugins") return { tab: "resources", row: `plugins:${item}` };
  return undefined;
}
