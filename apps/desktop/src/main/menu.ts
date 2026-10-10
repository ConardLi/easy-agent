import { Menu, type MenuItemConstructorOptions, shell } from "electron";
import { ACCENTS, type MenuCommand, type Prefs, type Theme } from "../shared/contract";

const THEME_LABELS: Record<Theme, string> = { system: "跟随系统", dark: "深色", light: "浅色" };

export interface MenuOptions {
  prefs: Prefs;
  send(command: MenuCommand): void;
  updatePrefs(patch: Partial<Prefs>): void;
}

/** Shortcuts live here so they show up in the system menu bar and work while any control has focus. */
export function buildMenu({ prefs, send, updatePrefs }: MenuOptions): Menu {
  const isMac = process.platform === "darwin";
  const command = (label: string, accelerator: string, cmd: MenuCommand): MenuItemConstructorOptions => ({
    id: cmd,
    label,
    accelerator,
    click: () => send(cmd),
  });

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: "Easy Agent",
            submenu: [
              { role: "about", label: "关于 Easy Agent" },
              { type: "separator" },
              command("设置…", "CmdOrCtrl+,", "open-settings"),
              { type: "separator" },
              { role: "services", label: "服务" },
              { type: "separator" },
              { role: "hide", label: "隐藏 Easy Agent" },
              { role: "hideOthers", label: "隐藏其他" },
              { role: "unhide", label: "全部显示" },
              { type: "separator" },
              { role: "quit", label: "退出 Easy Agent" },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "文件",
      submenu: [
        command("新建会话", "CmdOrCtrl+N", "new-session"),
        command("打开文件夹…", "CmdOrCtrl+O", "open-folder"),
        { type: "separator" },
        command("自定义…", "CmdOrCtrl+;", "open-customize"),
        { type: "separator" },
        ...(isMac ? [] : [command("设置…", "CmdOrCtrl+,", "open-settings"), { type: "separator" } as const]),
        isMac ? { role: "close", label: "关闭窗口" } : { role: "quit", label: "退出" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "显示",
      submenu: [
        command("切换侧边栏", "CmdOrCtrl+B", "toggle-sidebar"),
        { type: "separator" },
        {
          label: "主题",
          submenu: (Object.keys(THEME_LABELS) as Theme[]).map((theme) => ({
            id: `theme-${theme}`,
            label: THEME_LABELS[theme],
            type: "radio",
            checked: prefs.theme === theme,
            click: () => updatePrefs({ theme }),
          })),
        },
        {
          label: "强调色",
          submenu: ACCENTS.map((accent) => ({
            id: `accent-${accent.id}`,
            label: accent.label,
            type: "radio",
            checked: prefs.accent === accent.id,
            click: () => updatePrefs({ accent: accent.id }),
          })),
        },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" },
        { type: "separator" },
        { role: "reload", label: "重新加载" },
        { role: "toggleDevTools", label: "开发者工具" },
      ],
    },
    {
      label: "窗口",
      submenu: [{ role: "minimize", label: "最小化" }, { role: "zoom", label: "缩放" }, ...(isMac ? [{ role: "front", label: "前置全部窗口" } as const] : [])],
    },
    {
      label: "帮助",
      submenu: [{ label: "Easy Agent 文档", click: () => void shell.openExternal("https://github.com/ConardLi/easy-agent#readme") }],
    },
  ];
  return Menu.buildFromTemplate(template);
}
