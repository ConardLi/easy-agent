import { Bot, Download, FileJson, PanelLeftOpen, Plus, Star, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, cn, IconButton, MOD, Spinner, Tooltip } from "../../design/primitives";
import { keyOf, loadAgent, pickImport, useAgents } from "../../state/agents";
import { usePrefs } from "../../state/prefs";
import { useActiveWorkspace, useRuntime } from "../../state/workspaces";
import { WindowControls } from "../shell/WindowControls";
import { WorkspaceAvatar } from "../workspace/WorkspaceAvatar";
import { type AgentDialog, AgentDialogs } from "./AgentDialogs";
import { HarnessView } from "./HarnessView";
import { SETTINGS_FILE } from "./model";

/**
 * The Agent page: every Agent of `harnesses` on the left, the Harness view
 * of the selected one on the right. Agents are global (user settings); the
 * workspace only picks its default.
 */
export function AgentsView() {
  const workspace = useActiveWorkspace();
  const runtime = useRuntime(workspace?.id);
  const name = useAgents((s) => s.name);
  const openAgents = useAgents((s) => s.openAgents);
  const closeAgents = useAgents((s) => s.closeAgents);
  const sidebarOpen = usePrefs((s) => s.sidebarOpen);
  const toggleSidebar = usePrefs((s) => s.toggleSidebar);
  const [dialog, setDialog] = useState<AgentDialog | null>(null);

  const agents = runtime.agents ?? [];
  const selected = agents.find((a) => a.name === name) ?? agents[0];
  const data = useAgents((s) => (workspace && selected ? s.data[keyOf(workspace.id, selected.name)] : undefined));
  const error = useAgents((s) => (workspace && selected ? s.errors[keyOf(workspace.id, selected.name)] : undefined));
  const ready = runtime.status.state === "ready";

  useEffect(() => {
    if (workspace && selected && ready) void loadAgent(workspace.id, selected.name);
  }, [workspace, selected?.name, ready]);

  if (!workspace) return null;
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
          <h1 className="text-[13.5px] font-semibold tracking-[-0.01em] text-fg">Agent</h1>
          <span className="no-drag flex items-center gap-1.5 rounded-md border border-line px-1.5 py-0.5 text-[11.5px] text-fg-2">
            <WorkspaceAvatar name={workspace.name} color={workspace.color} size={14} />
            {workspace.name}
          </span>
          <span className="hidden text-[11.5px] text-fg-3 md:inline">Agent 对所有工作区生效，每个工作区选一个默认 Agent</span>
        </div>
        <Tooltip content="返回对话">
          <IconButton onClick={closeAgents} aria-label="返回对话">
            <X />
          </IconButton>
        </Tooltip>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-[236px] shrink-0 flex-col border-r border-line bg-surface/40 px-2.5 py-3">
          <div className="mb-2 flex items-center gap-1.5 px-1">
            <Button size="sm" variant="secondary" className="flex-1" disabled={!ready} onClick={() => setDialog({ kind: "create" })}>
              <Plus />
              新建 Agent
            </Button>
            <Tooltip content="导入 Agent 文件">
              <IconButton onClick={() => void pickImport()} disabled={!ready} aria-label="导入 Agent">
                <Download />
              </IconButton>
            </Tooltip>
          </div>
          <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
            {agents.map((a) => {
              const active = a.name === selected?.name;
              const broken = a.errors.length > 0;
              return (
                <button
                  key={a.name}
                  type="button"
                  data-agent={a.name}
                  onClick={() => openAgents(a.name)}
                  className={cn(
                    "relative flex items-start gap-2.5 rounded-[10px] px-2.5 py-2 text-left transition-colors",
                    active ? "bg-fg/[0.06] text-fg" : "text-fg-2 hover:bg-fg/[0.04] hover:text-fg",
                  )}
                >
                  <span
                    className={cn(
                      "mt-px flex size-7 shrink-0 items-center justify-center rounded-[8px] border border-line bg-canvas [&_svg]:size-3.5",
                      broken ? "text-danger" : active ? "text-accent" : "text-fg-3",
                    )}
                  >
                    <Bot />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium">{a.name}</span>
                      {a.projectDefault && (
                        <Tooltip content="这个工作区默认用它">
                          <Star className="size-3 shrink-0 fill-accent text-accent" />
                        </Tooltip>
                      )}
                      {a.builtIn && <span className="rounded-[5px] bg-surface-3 px-1 text-[10px] font-medium leading-4 text-fg-3">内置</span>}
                      {a.builtIn && a.defined && <span className="rounded-[5px] bg-info/10 px-1 text-[10px] font-medium leading-4 text-info">改过</span>}
                    </span>
                    <span className={cn("block truncate text-[11.5px]", broken ? "text-danger" : "text-fg-3")}>
                      {broken ? a.errors[0] : a.extends ? `继承 ${a.extends}` : "Easy Agent 的默认行为"}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="mt-2 border-t border-line px-1.5 pt-2.5 text-[11px] leading-[1.5] text-fg-3">
            <div className="flex items-center gap-1.5">
              <FileJson className="size-3 shrink-0" />
              <span className="truncate font-mono">{SETTINGS_FILE}</span>
            </div>
            <div className="mt-0.5 text-fg-4">Agent 存在 harnesses 里，长文本放在 prompts/ 目录</div>
          </div>
        </nav>

        <div className="relative min-w-0 flex-1">
          {selected && data ? (
            <HarnessView summary={selected} data={data} onDialog={setDialog} />
          ) : (
            <div className="flex h-full items-center justify-center gap-2 text-[13px] text-fg-3">
              {error ? <span className="text-danger">{error}</span> : ready ? <Spinner /> : "Agent 进程还没有就绪"}
            </div>
          )}
        </div>
      </div>
      <AgentDialogs dialog={dialog} onClose={() => setDialog(null)} />
    </section>
  );
}
