import { PanelLeftClose, Search, Settings, SlidersHorizontal, SquarePen } from "lucide-react";
import { IconButton, Kbd, MOD, Tooltip } from "../../design/primitives";
import { usePrefs } from "../../state/prefs";
import { notYet, useUi } from "../../state/ui";
import { WindowControls } from "../shell/WindowControls";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

function UserBadge() {
  const userName = useUi((s) => s.appInfo?.userName) || "本机用户";
  return (
    <span data-visual-mask className="flex min-w-0 flex-1 items-center gap-2.5">
      <span className="flex size-7 items-center justify-center rounded-full bg-[linear-gradient(135deg,#f6d365,#fda085)] text-[11.5px] font-semibold text-[#5b2b0e]">
        {userName.slice(0, 1).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-fg">{userName}</span>
        <span className="block truncate text-[11px] text-fg-3">本地</span>
      </span>
    </span>
  );
}

export function Sidebar() {
  const toggleSidebar = usePrefs((s) => s.toggleSidebar);

  return (
    <aside className="flex h-full w-[272px] shrink-0 flex-col">
      <div className="drag flex h-[52px] shrink-0 items-center justify-between pl-4 pr-2.5">
        <WindowControls />
        <div className="flex items-center gap-0.5">
          <Tooltip content="搜索会话和命令" keys={[MOD, "K"]}>
            <IconButton onClick={() => notYet("搜索")} aria-label="搜索">
              <Search />
            </IconButton>
          </Tooltip>
          <Tooltip content="收起侧边栏" keys={[MOD, "B"]}>
            <IconButton onClick={toggleSidebar} aria-label="收起侧边栏">
              <PanelLeftClose />
            </IconButton>
          </Tooltip>
        </div>
      </div>

      <div className="px-2.5">
        <WorkspaceSwitcher />
      </div>

      <div className="mt-2 flex flex-col gap-0.5 px-2.5">
        <button
          type="button"
          disabled
          className="group flex h-[34px] items-center gap-2.5 rounded-[9px] px-2 text-[13px] font-medium text-fg-2 transition-colors hover:bg-fg/[0.06] hover:text-fg disabled:pointer-events-none disabled:opacity-45"
        >
          <SquarePen className="size-[15px]" />
          <span className="flex-1 text-left">新建会话</span>
          <span className="hidden items-center gap-0.5 group-hover:flex">
            <Kbd>{MOD}</Kbd>
            <Kbd>N</Kbd>
          </span>
        </button>
        <button
          type="button"
          onClick={() => notYet("自定义")}
          className="group flex h-[34px] items-center gap-2.5 rounded-[9px] px-2 text-[13px] font-medium text-fg-2 transition-colors hover:bg-fg/[0.06] hover:text-fg"
        >
          <SlidersHorizontal className="size-[15px]" />
          <span className="flex-1 text-left">自定义</span>
          <span className="text-[11px] font-normal text-fg-3 group-hover:hidden">技能 · MCP · 插件</span>
          <span className="hidden items-center gap-0.5 group-hover:flex">
            <Kbd>{MOD}</Kbd>
            <Kbd>;</Kbd>
          </span>
        </button>
      </div>

      <nav className="scroll-thin mt-3 min-h-0 flex-1 overflow-y-auto px-2.5 pb-4">
        <p className="px-2 py-6 text-center text-[12.5px] text-fg-3">打开文件夹后，会话会显示在这里</p>
      </nav>

      <div className="border-t border-line px-2.5 py-2.5">
        <div className="flex items-center gap-2.5 rounded-xl px-2 py-1.5">
          <UserBadge />
          <Tooltip content="设置" keys={[MOD, ","]} side="top">
            <IconButton onClick={() => notYet("设置")} aria-label="设置">
              <Settings />
            </IconButton>
          </Tooltip>
        </div>
      </div>
    </aside>
  );
}
