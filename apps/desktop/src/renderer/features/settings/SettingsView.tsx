import {
  Bot,
  Braces,
  Container,
  Cpu,
  Database,
  Info,
  Keyboard,
  KeyRound,
  Palette,
  PanelLeftOpen,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { DetailDrawer } from "../../design/Overlays";
import { Button, cn, IconButton, MOD, Spinner, Tooltip } from "../../design/primitives";
import { desktop } from "../../lib/desktop";
import { SCOPE_FILE, SCOPE_HINT, SCOPE_ICON, SCOPE_LABEL, WRITE_SCOPES } from "../../lib/scopes";
import { usePrefs } from "../../state/prefs";
import { AGENT_SECTIONS, loadConfig, type SettingsSection, useSettings } from "../../state/settings";
import { useActiveWorkspace, useRuntime } from "../../state/workspaces";
import { CodeBlock } from "../session/Markdown";
import { WindowControls } from "../shell/WindowControls";
import { WorkspaceAvatar } from "../workspace/WorkspaceAvatar";
import { ModelsPage } from "./ModelsPage";
import {
  AboutPage,
  AppearancePage,
  BehaviorPage,
  DataPage,
  EnvPage,
  GeneralPage,
  PermissionsPage,
  RuntimePage,
  SandboxPage,
  ShortcutsPage,
  TerminalPage,
} from "./pages";

const NAV: { group: string; hint: string; items: { id: SettingsSection; label: string; icon: typeof Palette }[] }[] = [
  {
    group: "应用",
    hint: "桌面端自己的偏好",
    items: [
      { id: "general", label: "通用", icon: Settings2 },
      { id: "appearance", label: "外观", icon: Palette },
      { id: "shortcuts", label: "快捷键", icon: Keyboard },
      { id: "runtime", label: "Agent 进程", icon: Cpu },
      { id: "about", label: "关于", icon: Info },
    ],
  },
  {
    group: "Agent",
    hint: "写入 settings.json",
    items: [
      { id: "models", label: "模型", icon: Bot },
      { id: "behavior", label: "行为", icon: SlidersHorizontal },
      { id: "permissions", label: "权限", icon: ShieldCheck },
      { id: "sandbox", label: "沙箱", icon: Container },
      { id: "env", label: "环境与凭据", icon: KeyRound },
      { id: "data", label: "会话与存储", icon: Database },
      { id: "terminal", label: "终端界面", icon: SquareTerminal },
    ],
  },
];

export function SettingsView() {
  const section = useSettings((s) => s.section);
  const openSettings = useSettings((s) => s.openSettings);
  const close = useSettings((s) => s.closeSettings);
  const writeScope = useSettings((s) => s.writeScope);
  const setWriteScope = useSettings((s) => s.setWriteScope);
  const config = useSettings((s) => s.config);
  const error = useSettings((s) => s.error);
  const sidebarOpen = usePrefs((s) => s.sidebarOpen);
  const toggleSidebar = usePrefs((s) => s.toggleSidebar);
  const workspace = useActiveWorkspace();
  const status = useRuntime(workspace?.id).status;
  const [jsonOpen, setJsonOpen] = useState(false);
  // What the file holds, as the Agent read it; secrets show as [redacted].
  const json = useMemo(() => {
    const src = config?.sources.find((s) => s.source === writeScope);
    if (!src?.exists) return "// 这个文件还不存在，第一次写入时创建";
    return JSON.stringify(src.values, null, 2);
  }, [config, writeScope]);
  const path = config?.sources.find((s) => s.source === writeScope)?.path ?? SCOPE_FILE[writeScope];

  // Read the settings again when the workspace's Agent becomes ready.
  useEffect(() => {
    if (status.state === "ready") void loadConfig();
  }, [status]);

  const Page = {
    general: GeneralPage,
    appearance: AppearancePage,
    shortcuts: ShortcutsPage,
    runtime: RuntimePage,
    about: AboutPage,
    models: ModelsPage,
    behavior: BehaviorPage,
    permissions: PermissionsPage,
    sandbox: SandboxPage,
    env: EnvPage,
    data: DataPage,
    terminal: TerminalPage,
  }[section];
  const agentSection = AGENT_SECTIONS.includes(section);
  const ready = !agentSection || !!config;
  const wide = section === "models";

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
        <h1 className="pl-1.5 text-[13.5px] font-semibold tracking-[-0.01em] text-fg">设置</h1>
        <span className="flex-1" />
        {agentSection ? (
          <>
            <div className="no-drag flex items-center gap-1 rounded-[10px] bg-surface-2/70 p-[3px]">
              <span className="px-2 text-[11.5px] text-fg-3">编辑</span>
              {WRITE_SCOPES.map((s) => {
                const Icon = SCOPE_ICON[s];
                return (
                  <Tooltip key={s} content={`${SCOPE_FILE[s]} · ${SCOPE_HINT[s]}`}>
                    <button
                      type="button"
                      onClick={() => setWriteScope(s)}
                      className={cn(
                        "flex h-[26px] items-center gap-1.5 rounded-[7px] px-2.5 text-[12px] font-medium transition-colors",
                        writeScope === s ? "bg-canvas text-fg shadow-[0_1px_2px_rgb(0_0_0/0.12),0_0_0_1px_var(--line)]" : "text-fg-3 hover:text-fg-2",
                      )}
                    >
                      <Icon className="size-3" />
                      {SCOPE_LABEL[s]}
                      {s !== "user" && writeScope === s && workspace && (
                        <span className="flex items-center gap-1 text-fg-3">
                          · <WorkspaceAvatar name={workspace.name} color={workspace.color} size={12} />
                        </span>
                      )}
                    </button>
                  </Tooltip>
                );
              })}
            </div>
            <Button size="sm" variant="ghost" className="no-drag" onClick={() => setJsonOpen(true)}>
              <Braces />
              settings.json
            </Button>
          </>
        ) : (
          <span className="text-[12px] text-fg-3">保存在本机的应用数据里</span>
        )}
        <Tooltip content="返回对话">
          <IconButton onClick={close} aria-label="返回对话">
            <X />
          </IconButton>
        </Tooltip>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="scroll-thin flex w-[220px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-line bg-surface/40 px-2.5 py-4">
          {NAV.map((g) => (
            <div key={g.group}>
              <div className="flex items-baseline gap-1.5 px-2.5 pb-1.5">
                <span className="text-[11px] font-medium text-fg-3">{g.group}</span>
                <span className="text-[10.5px] text-fg-4">{g.hint}</span>
              </div>
              {g.items.map((item) => {
                const active = section === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => openSettings(item.id)}
                    className={cn(
                      "relative flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors",
                      active ? "font-medium text-fg" : "text-fg-2 hover:bg-fg/[0.04] hover:text-fg",
                    )}
                  >
                    {active && (
                      <motion.span
                        layoutId="settings-nav"
                        className="absolute inset-0 rounded-lg bg-fg/[0.07]"
                        transition={{ type: "spring", bounce: 0.15, duration: 0.35 }}
                      />
                    )}
                    <item.icon className="relative size-[15px]" />
                    <span className="relative">{item.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {agentSection && (
            <div className="mt-auto rounded-xl border border-line bg-canvas p-3 text-[11.5px] leading-[1.55] text-fg-3">
              Agent 设置正在写入 <span className="font-medium text-fg-2">{SCOPE_LABEL[writeScope]}</span> 配置
              <div className="mt-1 truncate font-mono text-[10.5px] text-fg-4">{SCOPE_FILE[writeScope]}</div>
              <div className="mt-1.5">同一项在多份文件里都有时，按 全局 → 项目 → 本机 后者覆盖前者；--settings 指定的文件和企业策略再往上。</div>
            </div>
          )}
        </nav>

        <div className="relative min-w-0 flex-1 overflow-hidden">
          <div className={cn("h-full", wide ? "overflow-hidden" : "scroll-thin overflow-y-auto")}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={section}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className={wide ? "scroll-thin h-full overflow-y-auto" : "mx-auto w-full max-w-[820px] px-10 pb-16 pt-8"}
              >
                {ready ? (
                  <Page />
                ) : (
                  <div className="flex flex-col items-center gap-3 py-24 text-center text-[13px] text-fg-3">
                    {workspace && !error ? <Spinner /> : null}
                    {!workspace ? "打开一个工作区后，可以在这里编辑 Agent 的设置。" : (error ?? "正在读取设置…")}
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
          <DetailDrawer
            open={jsonOpen}
            onClose={() => setJsonOpen(false)}
            title={path}
            subtitle={`${SCOPE_LABEL[writeScope]}配置 · ${SCOPE_HINT[writeScope]}`}
            footer={
              <Button size="sm" variant="secondary" onClick={() => void desktop.app.openPath(path.replace(/\/[^/]+$/, ""))}>
                打开所在文件夹
              </Button>
            }
          >
            <CodeBlock code={json} lang="json" />
          </DetailDrawer>
        </div>
      </div>
    </section>
  );
}
