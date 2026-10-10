import { Download, Ellipsis, GitFork, PanelLeftClose, Pencil, Pin, PinOff, Search, Settings, SlidersHorizontal, SquarePen, Trash2 } from "lucide-react";
import { motion } from "motion/react";
import { useMemo, useState } from "react";
import { cn, IconButton, Kbd, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, MOD, Spinner, Tooltip } from "../../design/primitives";
import { type DayBucket, dayBucket, shortTime } from "../../lib/format";
import { deleteSession, exportSession, forkSession, newSession, openSession, renameSession, togglePin } from "../../state/actions";
import { usePrefs } from "../../state/prefs";
import { useSessions } from "../../state/sessions";
import { useCustomize } from "../../state/customize";
import { useSettings } from "../../state/settings";
import { notYet, useUi } from "../../state/ui";
import { useActiveWorkspace } from "../../state/workspaces";
import { WindowControls } from "../shell/WindowControls";
import { type SessionListItem, useSessionList } from "./sessionList";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

function StatusGlyph({ item, active }: { item: SessionListItem; active: boolean }) {
  if (item.status === "running") return <Spinner className="size-3 text-accent" />;
  if (item.status === "waiting")
    return (
      <span className="relative flex size-3 items-center justify-center">
        <span className="absolute size-2 animate-ping rounded-full bg-warning/50 [animation-duration:1.8s]" />
        <span className="size-[7px] rounded-full bg-warning" />
      </span>
    );
  if (item.unread && !active) return <span className="mx-[2.5px] size-[7px] rounded-full bg-accent" />;
  return <span className="mx-[2.5px] size-[7px] rounded-full bg-transparent" />;
}

function SessionItem({ item, workspaceId }: { item: SessionListItem; workspaceId: string }) {
  const active = useSessions((s) => s.activeId === item.id);
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div
      className={cn(
        "group relative flex h-[34px] items-center gap-2 rounded-[9px] pl-2 pr-1 text-[13px] transition-colors",
        active ? "text-fg" : "text-fg-2 hover:bg-fg/[0.04] hover:text-fg",
      )}
    >
      {active && (
        <motion.span
          layoutId="session-active"
          className="absolute inset-0 rounded-[9px] bg-fg/[0.06]"
          transition={{ type: "spring", bounce: 0.15, duration: 0.35 }}
        />
      )}
      <span className="relative flex w-3 justify-center">
        <StatusGlyph item={item} active={active} />
      </span>
      {editing ? (
        <input
          // biome-ignore lint/a11y/noAutofocus: inline rename takes focus on purpose
          autoFocus
          defaultValue={item.title}
          aria-label="会话名称"
          onBlur={(e) => {
            const title = e.currentTarget.value.trim();
            if (title && title !== item.title) void renameSession(workspaceId, item.id, title);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setEditing(false);
          }}
          className="relative h-6 min-w-0 flex-1 rounded-md border border-accent-line bg-canvas px-1.5 text-[13px] text-fg outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() => void openSession(workspaceId, item.id)}
          onDoubleClick={() => setEditing(true)}
          className="relative min-w-0 flex-1 truncate text-left after:absolute after:inset-0 after:content-['']"
        >
          {item.title}
        </button>
      )}
      {!editing && (
        <span className={cn("relative flex items-center", menuOpen ? "" : "group-hover:hidden")}>
          {item.status === "waiting" ? (
            <span className="text-[11px] font-medium text-warning">待确认</span>
          ) : (
            <span className="tabular text-[11px] text-fg-3">{shortTime(item.updatedAt)}</span>
          )}
        </span>
      )}
      {!editing && (
        <Menu open={menuOpen} onOpenChange={setMenuOpen}>
          <MenuTrigger asChild>
            <IconButton size="sm" className={cn("relative -my-1", menuOpen ? "flex" : "hidden group-hover:flex")} aria-label="更多">
              <Ellipsis />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="start" className="w-[180px]">
            <MenuItem icon={<Pencil />} onSelect={() => setEditing(true)}>
              重命名
            </MenuItem>
            <MenuItem icon={item.pinned ? <PinOff /> : <Pin />} onSelect={() => void togglePin(workspaceId, item.id)}>
              {item.pinned ? "取消置顶" : "置顶"}
            </MenuItem>
            <MenuItem icon={<GitFork />} onSelect={() => void forkSession(workspaceId, item.id, item.title)}>
              分叉
            </MenuItem>
            <MenuItem icon={<Download />} onSelect={() => void exportSession(item.id)}>
              导出为 Markdown
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Trash2 />} danger onSelect={() => void deleteSession(workspaceId, item.id)}>
              删除
            </MenuItem>
          </MenuContent>
        </Menu>
      )}
    </div>
  );
}

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
  const workspace = useActiveWorkspace();
  const activeId = useSessions((s) => s.activeId);
  const items = useSessionList(workspace?.id);

  const groups = useMemo(() => {
    const order: DayBucket[] = ["置顶", "今天", "昨天", "过去 7 天", "更早"];
    const map = new Map<DayBucket, SessionListItem[]>();
    for (const item of items) {
      const bucket = item.pinned ? "置顶" : dayBucket(item.updatedAt);
      map.set(bucket, [...(map.get(bucket) ?? []), item]);
    }
    return order.filter((k) => map.has(k)).map((k) => ({ label: k, items: map.get(k) ?? [] }));
  }, [items]);

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
          onClick={newSession}
          disabled={!workspace}
          className={cn(
            "group flex h-[34px] items-center gap-2.5 rounded-[9px] px-2 text-[13px] font-medium transition-colors hover:bg-fg/[0.06] disabled:pointer-events-none disabled:opacity-45",
            activeId === null && workspace ? "bg-fg/[0.06] text-fg" : "text-fg-2 hover:text-fg",
          )}
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
          onClick={() => useCustomize.getState().openCustomize()}
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
        {groups.length === 0 && (
          <p className="px-2 py-6 text-center text-[12.5px] text-fg-3">{workspace ? "这个工作区还没有会话" : "打开文件夹后，会话会显示在这里"}</p>
        )}
        {workspace &&
          groups.map((g) => (
            <section key={g.label} className="mt-3 first:mt-0">
              <h3 className="sticky top-0 z-10 bg-bg px-2 pb-1 pt-1 text-[11.5px] font-medium text-fg-3">{g.label}</h3>
              <div className="flex flex-col gap-px">
                {g.items.map((item) => (
                  <SessionItem key={item.id} item={item} workspaceId={workspace.id} />
                ))}
              </div>
            </section>
          ))}
      </nav>

      <div className="border-t border-line px-2.5 py-2.5">
        <div className="flex items-center gap-2.5 rounded-xl px-2 py-1.5">
          <UserBadge />
          <Tooltip content="设置" keys={[MOD, ","]} side="top">
            <IconButton onClick={() => useSettings.getState().openSettings()} aria-label="设置">
              <Settings />
            </IconButton>
          </Tooltip>
        </div>
      </div>
    </aside>
  );
}
