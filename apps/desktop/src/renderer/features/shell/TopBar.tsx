import {
  Copy,
  Download,
  Ellipsis,
  Eraser,
  GitBranch,
  GitFork,
  Layers,
  PanelLeftOpen,
  PanelRight,
  Search,
  SquareArrowOutUpRight,
  SquarePen,
} from "lucide-react";
import { agent, describeError } from "../../agent/client";
import { blocksOf } from "../../agent/projector/session";
import { ContextRing } from "../../design/ContextRing";
import { IconButton, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, MOD, Tooltip } from "../../design/primitives";
import { tokens } from "../../lib/format";
import { forkSession, newSession } from "../../state/actions";
import { usePrefs } from "../../state/prefs";
import { useActiveView } from "../../state/sessions";
import { notYet, useUi } from "../../state/ui";
import { useActiveWorkspace, useRuntime } from "../../state/workspaces";
import { useSessionList } from "../workspace/sessionList";
import { WindowControls } from "./WindowControls";

export function TopBar() {
  const sidebarOpen = usePrefs((s) => s.sidebarOpen);
  const toggleSidebar = usePrefs((s) => s.toggleSidebar);
  const workspace = useActiveWorkspace();
  const runtime = useRuntime(workspace?.id);
  const view = useActiveView();
  const items = useSessionList(workspace?.id);
  const toast = useUi((s) => s.toast);

  const title = !workspace ? "Easy Agent" : view ? (items.find((i) => i.id === view.id)?.title ?? "新会话") : "新会话";
  const context = view?.usage?.context ?? null;

  const command = (name: string) => {
    if (!view) return;
    if (view.busy) return toast("这一轮结束后再操作");
    void agent.call(view.workspaceId, "session/command", { sessionId: view.id, name }).catch((error) => toast(describeError(error), "danger"));
  };

  const copyLastReply = () => {
    if (!view) return;
    const last = [...blocksOf(view)].reverse().find((b) => b.kind === "assistant");
    if (last?.kind !== "assistant") return toast("还没有回复可以复制");
    void navigator.clipboard.writeText(last.text).then(() => toast("已复制到剪贴板"));
  };

  return (
    <header className="drag titlebar-end flex h-[52px] shrink-0 items-center gap-3 border-b border-line px-3">
      {!sidebarOpen && (
        <div className="flex items-center gap-2 pl-1.5">
          <WindowControls />
          <div className="ml-2 flex items-center">
            <Tooltip content="展开侧边栏" keys={[MOD, "B"]}>
              <IconButton onClick={toggleSidebar} aria-label="展开侧边栏">
                <PanelLeftOpen />
              </IconButton>
            </Tooltip>
            <Tooltip content="新建会话" keys={[MOD, "N"]}>
              <IconButton onClick={() => (workspace ? newSession() : notYet("新建会话"))} aria-label="新建会话">
                <SquarePen />
              </IconButton>
            </Tooltip>
            <Tooltip content="搜索会话和命令" keys={[MOD, "K"]}>
              <IconButton onClick={() => notYet("搜索")} aria-label="搜索">
                <Search />
              </IconButton>
            </Tooltip>
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 items-center gap-2.5 pl-1.5">
        <h1 className="truncate text-[13.5px] font-semibold tracking-[-0.01em] text-fg">{title}</h1>
        {workspace && runtime.branch && (
          <span className="no-drag hidden shrink-0 items-center gap-1 rounded-md border border-line px-1.5 py-0.5 font-mono text-[11px] text-fg-3 sm:flex">
            <GitBranch className="size-3" />
            {runtime.branch}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1">
        {view && context && (
          <Tooltip
            content={
              <span className="flex flex-col gap-0.5 py-0.5">
                <span>
                  上下文 {tokens(context.tokens)} / {tokens(context.window)}（{context.percent}%）
                </span>
                {view.usage && (
                  <span className="text-white/60">
                    本会话输入 {tokens(view.usage.total.input_tokens)} · 输出 {tokens(view.usage.total.output_tokens)}
                  </span>
                )}
              </span>
            }
          >
            <span className="no-drag tabular flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] text-fg-3">
              <ContextRing used={context.tokens} total={context.window} size={15} />
              {context.percent}%
            </span>
          </Tooltip>
        )}
        {workspace && (
          <Tooltip content="在编辑器中打开">
            <IconButton onClick={() => notYet("在编辑器中打开")} aria-label="在编辑器中打开">
              <SquareArrowOutUpRight />
            </IconButton>
          </Tooltip>
        )}
        {view && (
          <Menu>
            <Tooltip content="会话操作">
              <MenuTrigger asChild>
                <IconButton aria-label="会话操作">
                  <Ellipsis />
                </IconButton>
              </MenuTrigger>
            </Tooltip>
            <MenuContent align="end" className="w-[220px]">
              <MenuItem icon={<GitFork />} onSelect={() => void forkSession(view.workspaceId, view.id, title)}>
                分叉会话
              </MenuItem>
              <MenuItem icon={<Copy />} onSelect={copyLastReply}>
                复制最后一条回复
              </MenuItem>
              <MenuItem icon={<Download />} onSelect={() => notYet("导出")}>
                导出为 Markdown
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<Layers />} onSelect={() => command("compact")}>
                压缩上下文
              </MenuItem>
              <MenuItem icon={<Eraser />} onSelect={() => command("clear")}>
                清空上下文
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
        <Tooltip content="显示详情面板" keys={[MOD, "J"]}>
          <IconButton disabled aria-label="详情面板">
            <PanelRight />
          </IconButton>
        </Tooltip>
      </div>
    </header>
  );
}
