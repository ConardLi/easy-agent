/**
 * What `/` offers in the composer.
 *
 * Only things that go to the Agent as a message are listed: skills, custom
 * commands (`.easy-agent/commands/`, plugins), and the two built-ins that run
 * a model turn. Everything else the CLI does with a slash command has a
 * control in the window; typing its old name still works and jumps there
 * (`/model` opens the model picker), but those aliases only show up once
 * typed.
 */

import type { RuntimeCapabilities } from "../../shared/agent";

export type SlashGroup = "skill" | "command" | "agent" | "action";

export interface SlashEntry {
  group: SlashGroup;
  name: string;
  description: string;
  /** Argument hint. Entries with one are inserted for the user to finish. */
  args?: string;
  source?: string;
  /** For `action` entries: what opens instead of sending text. */
  action?: UiAction;
  aliases?: string[];
}

export type UiAction =
  | "model"
  | "effort"
  | "plan"
  | "auto"
  | "context"
  | "changes"
  | "tasks"
  | "background"
  | "new"
  | "clear"
  | "export"
  | "copy"
  | "rewind"
  | "resume"
  | "skills"
  | "mcp"
  | "plugins"
  | "hooks"
  | "rules"
  | "tools"
  | "settings"
  | "permissions"
  | "output-style"
  | "doctor"
  | "help";

export const GROUP_LABEL: Record<SlashGroup, string> = { skill: "技能", command: "命令", agent: "Agent", action: "在界面中打开" };

const AGENT_COMMANDS: SlashEntry[] = [
  { group: "agent", name: "compact", description: "压缩对话，只保留要点，腾出上下文", args: "[关注点]" },
  { group: "agent", name: "init", description: "分析仓库，生成或更新 AGENTS.md" },
];

export const UI_ACTIONS: SlashEntry[] = (
  [
    ["model", ["model"], "切换模型", "打开输入框下方的模型选择器"],
    ["effort", ["think", "effort"], "调整思考强度", "打开思考强度选择器"],
    ["plan", ["plan"], "切换计划模式", "也可以按 ⇧Tab"],
    ["auto", ["auto", "mode"], "切换自动模式", "也可以按 ⇧Tab"],
    ["context", ["context", "cost", "status"], "上下文和用量", "右侧「上下文」面板"],
    ["changes", ["diff"], "查看改动", "右侧「改动」面板"],
    ["tasks", ["tasks", "todos"], "查看任务", "右侧「任务」面板"],
    ["background", ["agents", "bashes"], "后台任务", "右侧「后台」面板"],
    ["new", ["new"], "新建会话", "⌘N"],
    ["clear", ["clear"], "清空上下文", "保留会话，模型从这里重新开始"],
    ["export", ["export"], "导出为 Markdown", "会话菜单里也有"],
    ["copy", ["copy"], "复制最后一条回复", "消息下方的复制按钮"],
    ["rewind", ["rewind", "checkpoint"], "回退", "在你的消息上悬停，点回退按钮"],
    ["resume", ["resume", "history", "continue"], "历史会话", "左侧会话列表"],
    ["skills", ["skills"], "管理技能", "自定义 · 技能"],
    ["mcp", ["mcp"], "管理 MCP 服务器", "自定义 · MCP"],
    ["plugins", ["plugin", "plugins", "marketplace", "reload-plugins"], "管理插件", "自定义 · 插件"],
    ["hooks", ["hooks"], "管理 Hooks", "自定义 · Hooks"],
    ["rules", ["memory", "rules"], "AGENTS.md 和记忆", "自定义 · 规则"],
    ["tools", ["tools"], "开关内置工具", "自定义 · 工具"],
    ["permissions", ["permissions", "allowed-tools"], "权限规则", "设置 · 权限"],
    ["output-style", ["output-style"], "输出风格", "设置 · 行为"],
    ["settings", ["config", "settings"], "设置", "⌘,"],
    ["doctor", ["doctor"], "运行诊断", "设置 · 关于"],
    ["help", ["help"], "快捷键", "设置 · 快捷键"],
  ] as const
).map(([action, aliases, name, description]) => ({ group: "action", action, aliases: [...aliases], name, description }));

/**
 * Skills and commands the Agent offers in this workspace. Plugin commands are
 * namespaced `plugin:command`. TODO(G4): user, project, and plugin source labels need `runtime/inventory`.
 */
export function listSlash(capabilities: Pick<RuntimeCapabilities, "skills" | "userCommands"> | undefined): SlashEntry[] {
  const skills: SlashEntry[] = (capabilities?.skills ?? []).map((s) => ({ group: "skill", name: s.name, description: s.description }));
  const commands: SlashEntry[] = (capabilities?.userCommands ?? []).map((c) => {
    const plugin = c.name.includes(":") ? c.name.split(":")[0] : undefined;
    return { group: "command", name: c.name, description: c.description, ...(plugin ? { source: `插件 ${plugin}` } : {}) };
  });
  return [...skills, ...commands, ...AGENT_COMMANDS];
}

/** Filter entries for `/query`; UI aliases appear only once two letters match. */
export function matchSlash(entries: SlashEntry[], query: string): SlashEntry[] {
  const q = query.toLowerCase();
  const listed = entries.filter((e) => e.name.toLowerCase().includes(q) || (q.length > 1 && e.description.toLowerCase().includes(q)));
  listed.sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)));
  const actions = q.length >= 2 ? UI_ACTIONS.filter((a) => a.aliases?.some((x) => x.startsWith(q))) : [];
  return [...listed, ...actions];
}

/** Resolve `/name` typed in full to a UI alias, if it is one. */
export function aliasFor(name: string): SlashEntry | undefined {
  return UI_ACTIONS.find((a) => a.aliases?.includes(name));
}
