import { Check, ChevronsUpDown, FolderOpen, FolderPlus, ShieldAlert } from "lucide-react";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, MOD } from "../../design/primitives";
import { openFolder, switchWorkspace } from "../../state/actions";
import { notYet } from "../../state/ui";
import { useActiveWorkspace, useWorkspaces } from "../../state/workspaces";
import { WorkspaceAvatar } from "./WorkspaceAvatar";

function OpenItems() {
  return (
    <>
      <MenuItem icon={<FolderOpen />} hint={`${MOD} O`} onSelect={() => void openFolder()}>
        打开文件夹…
      </MenuItem>
      <MenuItem icon={<FolderPlus />} onSelect={() => notYet("克隆仓库")}>
        克隆仓库…
      </MenuItem>
    </>
  );
}

export function WorkspaceSwitcher() {
  const workspaces = useWorkspaces((s) => s.workspaces);
  const runtime = useWorkspaces((s) => s.runtime);
  const active = useActiveWorkspace();

  if (!active)
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
          <OpenItems />
        </MenuContent>
      </Menu>
    );

  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className="no-drag group flex h-11 w-full items-center gap-2.5 rounded-xl px-2 text-left transition-colors hover:bg-fg/[0.06] data-[state=open]:bg-fg/[0.06]"
        >
          <WorkspaceAvatar name={active.name} color={active.color} size={26} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] font-semibold tracking-[-0.01em] text-fg">{active.name}</span>
            <span className="block truncate font-mono text-[11px] text-fg-3">{active.path}</span>
          </span>
          <ChevronsUpDown className="size-3.5 text-fg-3 transition-colors group-hover:text-fg-2" />
        </button>
      </MenuTrigger>
      <MenuContent className="w-[260px]">
        <MenuLabel>工作区</MenuLabel>
        {workspaces.map((w) => {
          const status = runtime[w.id]?.status;
          const untrusted = status?.state === "ready" && !status.init.workspace.projectTrusted && status.trust === "persisted";
          return (
            <MenuItem
              key={w.id}
              onSelect={() => void switchWorkspace(w.id)}
              className="h-10"
              icon={<WorkspaceAvatar name={w.name} color={w.color} size={20} />}
              hint={
                w.id === active.id ? (
                  <Check className="size-3.5 text-accent" />
                ) : untrusted ? (
                  <span className="flex items-center gap-1 text-[11px] text-fg-3">
                    <ShieldAlert className="size-3" />
                    未信任
                  </span>
                ) : undefined
              }
            >
              <span className="block truncate">{w.name}</span>
            </MenuItem>
          );
        })}
        <MenuSeparator />
        <OpenItems />
      </MenuContent>
    </Menu>
  );
}
