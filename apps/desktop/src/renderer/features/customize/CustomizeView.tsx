import { FileJson, FileText, Package, PanelLeftOpen, Plug, ScrollText, Search, Sparkles, Webhook, Wrench, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { cn, IconButton, MOD, Spinner, Tooltip } from "../../design/primitives";
import { desktop } from "../../lib/desktop";
import { tokens } from "../../lib/format";
import { type CustomizeTab, loadInventory, useCustomize, useWorkspaceData } from "../../state/customize";
import { usePrefs } from "../../state/prefs";
import { useActiveView } from "../../state/sessions";
import { useActiveWorkspace, useRuntime } from "../../state/workspaces";
import { WindowControls } from "../shell/WindowControls";
import { WorkspaceAvatar } from "../workspace/WorkspaceAvatar";
import { HooksPage } from "./HooksPage";
import { McpPage } from "./McpPage";
import { type FixedGroup, fixedCost, GROUP_COLORS } from "./model";
import { PluginsPage } from "./PluginsPage";
import { RulesPage } from "./RulesPage";
import { SkillsPage } from "./SkillsPage";
import { ToolsPage } from "./ToolsPage";

const TABS: { id: CustomizeTab; label: string; en: string; icon: typeof Sparkles; group: FixedGroup | null }[] = [
  { id: "skills", label: "技能", en: "Skills", icon: Sparkles, group: "skills" },
  { id: "mcp", label: "MCP", en: "Servers", icon: Plug, group: "mcp" },
  { id: "plugins", label: "插件", en: "Plugins", icon: Package, group: "plugins" },
  { id: "hooks", label: "Hooks", en: "不占上下文", icon: Webhook, group: null },
  { id: "rules", label: "规则", en: "Rules", icon: ScrollText, group: "rules" },
  { id: "tools", label: "工具", en: "Tools", icon: Wrench, group: "tools" },
];

export function CustomizeView() {
  const tab = useCustomize((s) => s.tab);
  const openCustomize = useCustomize((s) => s.openCustomize);
  const closeCustomize = useCustomize((s) => s.closeCustomize);
  const contexts = useCustomize((s) => s.contexts);
  const sidebarOpen = usePrefs((s) => s.sidebarOpen);
  const toggleSidebar = usePrefs((s) => s.toggleSidebar);
  const workspace = useActiveWorkspace();
  const status = useRuntime(workspace?.id).status;
  const view = useActiveView();
  const { inventory, error } = useWorkspaceData();
  const [query, setQuery] = useState("");

  // Read the inventory again when the workspace's Agent (re)starts.
  useEffect(() => {
    if (status.state === "ready") void loadInventory(workspace?.id ?? null);
  }, [status, workspace?.id]);

  const cost = fixedCost(inventory);
  // The system prompt is only measured for a running session; take it from the open one when there is one.
  const context = view && view.workspaceId === workspace?.id ? contexts[view.id] : undefined;
  const system = context?.categories.find((c) => c.id === "system")?.tokens ?? 0;
  const groups = [
    ...(system ? [{ id: "system", tokens: system, color: GROUP_COLORS.system }] : []),
    ...(Object.keys(cost) as FixedGroup[]).map((id) => ({ id, tokens: cost[id], color: GROUP_COLORS[id] })),
  ];
  const fixed = groups.reduce((n, g) => n + g.tokens, 0);

  const counts: Record<CustomizeTab, number> = {
    skills: inventory?.skills.length ?? 0,
    mcp: inventory?.mcpServers.length ?? 0,
    plugins: inventory?.plugins.length ?? 0,
    hooks: inventory?.hooks.length ?? 0,
    rules: inventory?.rules.length ?? 0,
    tools: inventory?.tools.filter((t) => !t.mcpServer && t.enabled).length ?? 0,
  };

  const files = [
    { label: "~/.easy-agent/settings.json", path: "~/.easy-agent/settings.json", icon: FileJson },
    { label: ".easy-agent/settings.json", path: `${workspace?.path}/.easy-agent/settings.json`, icon: FileJson },
    { label: ".easy-agent/settings.local.json", path: `${workspace?.path}/.easy-agent/settings.local.json`, icon: FileJson },
    { label: ".mcp.json", path: `${workspace?.path}/.mcp.json`, icon: FileJson },
    { label: "AGENTS.md", path: `${workspace?.path}/AGENTS.md`, icon: FileText },
  ];

  const Page = { skills: SkillsPage, mcp: McpPage, plugins: PluginsPage, hooks: HooksPage, rules: RulesPage, tools: ToolsPage }[tab];

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-3">
        {!sidebarOpen && (
          <div className="flex items-center gap-2 pl-1.5">
            <WindowControls />
            <Tooltip content="展开侧边栏" keys={[MOD, "B"]}>
              <IconButton onClick={toggleSidebar} className="ml-2" aria-label="展开侧边栏">
                <PanelLeftOpen />
              </IconButton>
            </Tooltip>
          </div>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2.5 pl-1.5">
          <h1 className="text-[13.5px] font-semibold tracking-[-0.01em] text-fg">自定义</h1>
          {workspace && (
            <span className="no-drag flex items-center gap-1.5 rounded-md border border-line px-1.5 py-0.5 text-[11.5px] text-fg-2">
              <WorkspaceAvatar name={workspace.name} color={workspace.color} size={14} />
              {workspace.name}
            </span>
          )}
          <span className="hidden text-[11.5px] text-fg-3 md:inline">项目配置作用于这个工作区，全局配置作用于所有工作区</span>
        </div>
        <div className="no-drag relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-3" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`搜索${TABS.find((t) => t.id === tab)?.label}`}
            className="h-7 w-[200px] rounded-lg border border-line bg-surface pl-8 pr-2 text-[12.5px] text-fg outline-none transition-colors placeholder:text-fg-3 focus:border-accent-line focus:bg-canvas"
          />
        </div>
        <Tooltip content="返回对话">
          <IconButton onClick={closeCustomize} aria-label="返回对话">
            <X />
          </IconButton>
        </Tooltip>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-[236px] shrink-0 flex-col border-r border-line bg-surface/40 px-2.5 py-3">
          <div className="flex flex-col gap-0.5">
            {TABS.map((t) => {
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    openCustomize(t.id);
                    setQuery("");
                  }}
                  className={cn(
                    "relative flex h-11 items-center gap-2.5 rounded-[10px] px-2.5 text-left transition-colors",
                    active ? "text-fg" : "text-fg-2 hover:bg-fg/[0.04] hover:text-fg",
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId="customize-tab"
                      className="absolute inset-0 rounded-[10px] bg-fg/[0.06]"
                      transition={{ type: "spring", bounce: 0.15, duration: 0.35 }}
                    />
                  )}
                  <span
                    className={cn(
                      "relative flex size-7 items-center justify-center rounded-lg border",
                      active ? "border-transparent bg-accent text-accent-fg" : "border-line bg-canvas",
                    )}
                  >
                    <t.icon className="size-3.5" />
                  </span>
                  <span className="relative min-w-0 flex-1">
                    <span className="block text-[13px] font-medium leading-tight">{t.label}</span>
                    <span className="tabular block text-[11px] leading-tight text-fg-3">{t.group ? `${tokens(cost[t.group])} tokens/轮` : t.en}</span>
                  </span>
                  <span className="tabular relative text-[11.5px] text-fg-3">{counts[t.id]}</span>
                </button>
              );
            })}
          </div>

          <div className="mt-5 rounded-xl border border-line bg-canvas p-3">
            <div className="text-[11px] text-fg-3">每轮固定开销</div>
            <div className="tabular mt-0.5 text-[17px] font-semibold tracking-[-0.02em] text-fg">
              {tokens(fixed)}
              <span className="ml-1 text-[11.5px] font-normal text-fg-3">tokens</span>
            </div>
            <div className="mt-2.5 flex h-1.5 gap-[2px] overflow-hidden rounded-full">
              {groups
                .filter((g) => g.tokens > 0)
                .map((g) => (
                  <span key={g.id} className="h-full first:rounded-l-full last:rounded-r-full" style={{ flexGrow: g.tokens, background: g.color }} />
                ))}
            </div>
            <div className="mt-2 text-[11px] leading-[1.5] text-fg-3">
              {system
                ? "系统提示词、工具、MCP、技能清单、插件和规则加起来，对话还没开始就已经占用的部分"
                : "工具、MCP、技能清单、插件和规则加起来，对话还没开始就已经占用的部分；系统提示词要开始会话后才算得出"}
            </div>
          </div>

          <div className="mt-auto">
            <div className="mb-1.5 px-1 text-[11px] font-medium text-fg-3">配置文件</div>
            {files.map((f) => (
              <button
                key={f.label}
                type="button"
                disabled={!workspace}
                onClick={() => void desktop.app.openPath(f.path)}
                className="flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left font-mono text-[11px] text-fg-3 transition-colors hover:bg-fg/[0.04] hover:text-fg-2"
              >
                <f.icon className="size-3 shrink-0" />
                <span className="truncate">{f.label}</span>
              </button>
            ))}
          </div>
        </nav>

        <div className="relative min-w-0 flex-1 overflow-hidden">
          <div className="scroll-thin h-full overflow-y-auto">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={`${tab}-${workspace?.id}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="mx-auto w-full max-w-[900px] px-10 pb-16 pt-8"
              >
                {inventory ? (
                  <Page query={query} />
                ) : (
                  <div className="flex flex-col items-center gap-3 py-24 text-center text-[13px] text-fg-3">
                    {workspace && !error ? <Spinner /> : null}
                    {!workspace ? "打开一个工作区后，可以在这里管理它的技能、MCP、规则和工具。" : (error ?? "正在读取 Agent 加载的内容…")}
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </section>
  );
}
