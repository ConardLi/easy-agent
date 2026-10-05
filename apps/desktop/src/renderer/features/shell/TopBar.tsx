import { PanelLeftOpen, PanelRight, Search, SquarePen } from "lucide-react";
import { IconButton, MOD, Tooltip } from "../../design/primitives";
import { usePrefs } from "../../state/prefs";
import { notYet } from "../../state/ui";
import { WindowControls } from "./WindowControls";

/** Top bar before a workspace is open. Session controls arrive with sessions. */
export function TopBar() {
  const sidebarOpen = usePrefs((s) => s.sidebarOpen);
  const toggleSidebar = usePrefs((s) => s.toggleSidebar);

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
              <IconButton onClick={() => notYet("新建会话")} aria-label="新建会话">
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
        <h1 className="truncate text-[13.5px] font-semibold tracking-[-0.01em] text-fg">Easy Agent</h1>
      </div>

      <div className="flex items-center gap-1">
        <Tooltip content="显示详情面板" keys={[MOD, "J"]}>
          <IconButton disabled aria-label="详情面板">
            <PanelRight />
          </IconButton>
        </Tooltip>
      </div>
    </header>
  );
}
