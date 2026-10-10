/**
 * Turns the Agent's runtime inventory and context breakdown into what the
 * customize pages and the context panel show. Pure functions, no state.
 */

import type { ContextCategoryId, HookInventoryItem, InventorySource, McpServerInventoryItem, RuntimeInventory, SessionContext } from "../../../shared/agent";

export type OriginKind = "user" | "project" | "local" | "flag" | "policy" | "plugin" | "builtin";

/** Where an item comes from, as the scope badges show it. */
export interface Origin {
  kind: OriginKind;
  /** Plugin name, for `plugin`. */
  plugin?: string;
}

export function pluginName(inventory: RuntimeInventory | undefined, pluginId: string | undefined): string {
  if (!pluginId) return "";
  return inventory?.plugins.find((p) => p.pluginId === pluginId)?.name ?? pluginId.split("@")[0] ?? pluginId;
}

export function originOf(item: { source: InventorySource; pluginId?: string }, inventory?: RuntimeInventory): Origin {
  if (item.source === "plugin") return { kind: "plugin", plugin: pluginName(inventory, item.pluginId) };
  if (item.source === "built-in") return { kind: "builtin" };
  return { kind: item.source };
}

/** A path as people read it: relative to the workspace, or under `~`. */
export function displayPath(path: string, workspace: string, home?: string): string {
  if (path === workspace) return ".";
  if (path.startsWith(`${workspace}/`)) return path.slice(workspace.length + 1);
  if (home && path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  // Easy Agent's own folder is always `~/.easy-agent`.
  const own = path.indexOf("/.easy-agent/");
  if (own >= 0) return `~${path.slice(own)}`;
  return path.replace(/^\/(?:Users|home)\/[^/]+\//, "~/");
}

const REASONS: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^The workspace is not trusted\. Its hooks, MCP servers, and LSP servers do not run\.$/, () => "工作区未受信任，插件的 Hook、MCP 和 LSP 服务器不会运行"],
  [/^The workspace is not trusted\.$/, () => "工作区未受信任"],
  [/^Hooks are turned off/, () => "Hook 已全部停用（disableAllHooks 或 EASY_AGENT_DISABLE_HOOKS）"],
  [/^Hidden from the model; run it with (\/\S+?)\.?$/, (m) => `模型看不到它，只能用 ${m[1]} 调用`],
  [/^Listed to the model once a matching file/, () => "改到匹配的文件后才列给模型"],
  [/^Not approved yet\.$/, () => "还没有批准"],
  [/^Rejected in disabledMcpjsonServers\.$/, () => "已在 disabledMcpjsonServers 里拒绝"],
  [/^Matched by claudeMdExcludes\.$/, () => "被 claudeMdExcludes 排除"],
];

/** The Agent's reason for an item being off, in the interface language; unknown reasons stay as they are. */
export function reasonText(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  for (const [pattern, text] of REASONS) {
    const match = reason.match(pattern);
    if (match) return text(match);
  }
  return reason;
}

/** What an MCP server costs per turn now, and with every tool loaded. */
export function mcpTokens(server: McpServerInventoryItem): { now: number; all: number; deferred: boolean } {
  const all = server.tools.reduce((n, t) => n + t.schema.value, 0);
  const live = server.status === "connected";
  const now = live ? server.tools.filter((t) => !t.deferred).reduce((n, t) => n + t.schema.value, 0) : 0;
  return { now, all, deferred: server.tools.some((t) => t.deferred) };
}

export type FixedGroup = "skills" | "tools" | "mcp" | "plugins" | "rules";

/**
 * Tokens each capability adds to every request, from the inventory alone:
 * listed skills, built-in and MCP tool schemas that are sent in full, plugin
 * skills, sub-agents and tools, and rule files. The system prompt and the
 * conversation are only known once a session runs.
 */
export function fixedCost(inventory: RuntimeInventory | undefined): Record<FixedGroup, number> {
  const cost: Record<FixedGroup, number> = { skills: 0, tools: 0, mcp: 0, plugins: 0, rules: 0 };
  if (!inventory) return cost;
  for (const skill of inventory.skills) cost[skill.source === "plugin" ? "plugins" : "skills"] += skill.listing.value;
  for (const agent of inventory.agents) if (agent.source === "plugin") cost.plugins += agent.listing.value;
  for (const tool of inventory.tools) if (tool.enabled && !tool.mcpServer && !tool.deferred) cost.tools += tool.schema.value;
  for (const server of inventory.mcpServers) cost[server.source === "plugin" ? "plugins" : "mcp"] += mcpTokens(server).now;
  for (const rule of inventory.rules) if (rule.enabled) cost.rules += rule.tokens.value;
  return cost;
}

/** What each plugin adds to every request: its listed skills and sub-agents, and its MCP tools sent in full. */
export function pluginTokens(inventory: RuntimeInventory, pluginId: string): number {
  const skills = inventory.skills.filter((s) => s.pluginId === pluginId).reduce((n, s) => n + s.listing.value, 0);
  const agents = inventory.agents.filter((a) => a.pluginId === pluginId).reduce((n, a) => n + a.listing.value, 0);
  const mcp = inventory.mcpServers.filter((m) => m.pluginId === pluginId).reduce((n, m) => n + mcpTokens(m).now, 0);
  return skills + agents + mcp;
}

// ─── Built-in tools ───────────────────────────────────────────────────────

export type ToolGroup = "文件" | "执行" | "网络" | "协作" | "规划" | "任务" | "团队" | "扩展";

/** How the built-in tools are grouped and described on the tools page; tools not listed fall under 扩展. */
export const BUILTIN_TOOLS: Record<string, { group: ToolGroup; description: string }> = {
  Read: { group: "文件", description: "读取文件，支持图片和 PDF" },
  Write: { group: "文件", description: "创建或整个覆盖文件" },
  Edit: { group: "文件", description: "按字符串精确替换文件内容" },
  MultiEdit: { group: "文件", description: "一次对同一文件做多处替换" },
  Glob: { group: "文件", description: "按模式查找文件" },
  Grep: { group: "文件", description: "用 ripgrep 搜索文件内容" },
  Bash: { group: "执行", description: "在沙箱里执行 shell 命令" },
  PowerShell: { group: "执行", description: "在 Windows 上执行 PowerShell 命令" },
  WebFetch: { group: "网络", description: "抓取网页并转成 Markdown" },
  WebSearch: { group: "网络", description: "联网搜索" },
  Agent: { group: "协作", description: "派出子 Agent 处理独立的子任务" },
  AskUserQuestion: { group: "协作", description: "向用户提出选择题" },
  Skill: { group: "协作", description: "调用技能；技能清单另计" },
  ToolSearch: { group: "协作", description: "按需加载延迟工具的完整定义" },
  TodoWrite: { group: "规划", description: "维护本会话的任务清单" },
  EnterPlanMode: { group: "规划", description: "进入只读的计划模式" },
  ExitPlanMode: { group: "规划", description: "提交计划，等用户审批" },
  TaskCreate: { group: "任务", description: "创建持久化任务" },
  TaskUpdate: { group: "任务", description: "更新任务状态和依赖" },
  TaskList: { group: "任务", description: "列出任务" },
  TaskGet: { group: "任务", description: "读取单个任务" },
  TeamCreate: { group: "团队", description: "组建 Agent 团队并分派队友" },
  TeamDelete: { group: "团队", description: "解散团队" },
  SendMessage: { group: "团队", description: "给队友发消息" },
  LSP: { group: "扩展", description: "跳转定义、查引用、看诊断" },
  MemoryWrite: { group: "扩展", description: "写入项目自动记忆" },
  ListMcpResources: { group: "扩展", description: "列出 MCP 服务器提供的资源" },
  ReadMcpResource: { group: "扩展", description: "读取 MCP 资源" },
};

/** Why a built-in tool the Agent reports as off is off; these follow each tool's own enable condition. */
export function unavailableReason(name: string): string {
  if (name === "PowerShell") return "仅 Windows";
  if (name.startsWith("Task")) return "任务模式下可用";
  if (name === "TodoWrite") return "任务模式下由 Task 工具代替";
  if (name.startsWith("Team") || name === "SendMessage") return "开启 Agent Teams 后可用";
  if (name === "LSP") return "需要插件提供语言服务";
  return "当前不可用";
}

// ─── Hooks ────────────────────────────────────────────────────────────────

export interface HookCommandEntry {
  type?: string;
  command: string;
  timeout?: number;
  shell?: string;
}

export interface HookGroup {
  matcher?: string;
  hooks: HookCommandEntry[];
}

export type HooksBlock = Record<string, HookGroup[]>;

/** The fields the hook dialog edits. */
export interface HookDraft {
  event: string;
  matcher?: string;
  command: string;
  timeout: number;
  shell?: string;
}

const validHook = (h: unknown): h is HookCommandEntry =>
  !!h &&
  typeof h === "object" &&
  ((h as HookCommandEntry).type ?? "command") === "command" &&
  typeof (h as HookCommandEntry).command === "string" &&
  (h as HookCommandEntry).command.length > 0;

/** Index of a settings hook within its file and event, from its inventory id (`hook:<source>:<event>:<n>`). */
export function hookIndex(item: HookInventoryItem): number {
  return Number(item.id.split(":").at(-1));
}

/** The hooks block of one settings file with the `n`-th command of `event` removed, the way the Agent counts them. */
export function removeHook(block: HooksBlock, event: string, n: number): HooksBlock {
  let seen = 0;
  const groups = (block[event] ?? []).flatMap((group) => {
    if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) return [group];
    const hooks = group.hooks.filter((h) => !(validHook(h) && seen++ === n));
    return hooks.length > 0 ? [{ ...group, hooks }] : [];
  });
  const { [event]: _, ...rest } = block;
  return groups.length > 0 ? { ...rest, [event]: groups } : rest;
}

export function addHook(block: HooksBlock, draft: HookDraft): HooksBlock {
  const hook: HookCommandEntry = {
    type: "command",
    command: draft.command,
    ...(draft.timeout && draft.timeout !== 60 ? { timeout: draft.timeout } : {}),
    ...(draft.shell ? { shell: draft.shell } : {}),
  };
  const group: HookGroup = { ...(draft.matcher ? { matcher: draft.matcher } : {}), hooks: [hook] };
  return { ...block, [draft.event]: [...(block[draft.event] ?? []), group] };
}

// ─── Context breakdown ───────────────────────────────────────────────────

export const GROUP_COLORS: Record<ContextCategoryId, string> = {
  system: "#8b8b94",
  tools: "#a78bfa",
  mcp: "#60a5fa",
  skills: "#f5a524",
  plugins: "#f472b6",
  rules: "#34d399",
  messages: "var(--accent)",
};

export const GROUP_META: Record<ContextCategoryId, { label: string; hint: string; tab?: "skills" | "mcp" | "plugins" | "rules" | "tools" }> = {
  system: { label: "系统提示词", hint: "基础指令、环境信息和输出风格，整场会话不变" },
  tools: { label: "内置工具", hint: "每个启用的工具都要发送完整定义", tab: "tools" },
  mcp: { label: "MCP", hint: "延迟加载时只发工具名，用到时再取完整定义", tab: "mcp" },
  skills: { label: "技能", hint: "只计入名称和描述，调用后正文进入对话消息", tab: "skills" },
  plugins: { label: "插件", hint: "插件带来的技能、MCP 和子 Agent 都算在这里", tab: "plugins" },
  rules: { label: "规则", hint: "AGENTS.md 等规则文件全文加载", tab: "rules" },
  messages: { label: "对话消息", hint: "你的消息、模型回复和工具结果" },
};

const ITEM_LABELS: Record<string, string> = {
  instructions: "基础指令",
  environment: "环境信息",
  output_style: "输出风格",
  language: "回复语言",
  memory: "记忆说明",
  session_instructions: "会话指令",
  skills: "技能清单说明",
  agents: "子 Agent 清单",
  team: "Agent 团队",
  user: "你的消息",
  assistant: "模型回复",
  tool_results: "工具结果",
};

const SOURCE_LABELS: Record<string, string> = {
  "built-in": "内置",
  user: "全局",
  project: "项目",
  local: "本机",
  flag: "启动参数",
  policy: "策略",
  plugin: "插件",
};

export interface ContextGroupView {
  id: ContextCategoryId;
  label: string;
  hint: string;
  color: string;
  tokens: number;
  tab?: "skills" | "mcp" | "plugins" | "rules" | "tools";
  items: { id: string; label: string; tokens: number; source?: string }[];
}

/** The context panel's groups: Agent categories with labels, colors, and readable item names. */
export function contextGroups(context: SessionContext, workspace: string): ContextGroupView[] {
  return context.categories.map((category) => {
    const meta = GROUP_META[category.id];
    return {
      id: category.id,
      label: meta.label,
      hint: meta.hint,
      color: GROUP_COLORS[category.id],
      tokens: category.tokens,
      ...(meta.tab ? { tab: meta.tab } : {}),
      items: category.items.map((item) => ({
        id: item.id,
        tokens: item.tokens,
        label:
          category.id === "system" || category.id === "messages"
            ? (ITEM_LABELS[item.id] ?? item.label)
            : category.id === "rules"
              ? displayPath(item.label, workspace)
              : item.label,
        ...(item.source && category.id !== "system" ? { source: SOURCE_LABELS[item.source] ?? item.source } : {}),
      })),
    };
  });
}
