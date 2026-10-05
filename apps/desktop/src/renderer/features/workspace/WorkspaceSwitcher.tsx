import { ChevronsUpDown, FolderOpen, FolderPlus } from "lucide-react";
import { Menu, MenuContent, MenuItem, MenuTrigger, MOD } from "../../design/primitives";
import { notYet } from "../../state/ui";

/** Switcher before any workspace is open: it only offers to open one. */
export function WorkspaceSwitcher() {
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className="no-drag group flex h-11 w-full items-center gap-2.5 rounded-xl px-2 text-left transition-colors hover:bg-fg/[0.06] data-[state=open]:bg-fg/[0.06]"
        >
          <span className="flex size-[26px] shrink-0 items-center justify-center rounded-[7px] border border-dashed border-line-strong text-fg-3">
            <FolderOpen className="size-3.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] font-semibold tracking-[-0.01em] text-fg">打开工作区</span>
            <span className="block truncate text-[11px] text-fg-3">还没有打开文件夹</span>
          </span>
          <ChevronsUpDown className="size-3.5 text-fg-3 transition-colors group-hover:text-fg-2" />
        </button>
      </MenuTrigger>
      <MenuContent className="w-[260px]">
        <MenuItem icon={<FolderOpen />} hint={`${MOD} O`} onSelect={() => notYet("打开文件夹")}>
          打开文件夹…
        </MenuItem>
        <MenuItem icon={<FolderPlus />} onSelect={() => notYet("克隆仓库")}>
          克隆仓库…
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
