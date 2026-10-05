import { Check, ChevronDown, ClipboardList, Cpu, Lightbulb, Search, Settings2, ShieldCheck, Zap } from "lucide-react";
import { Popover } from "radix-ui";
import { useState } from "react";
import type { Effort, PermissionMode } from "../../agent/viewModel";
import { cn, Kbd, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Tooltip } from "../../design/primitives";

const pill =
  "no-drag inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg data-[state=open]:bg-surface-2 data-[state=open]:text-fg [&_svg]:size-[14px]";

export const MODES: { id: PermissionMode; label: string; hint: string }[] = [
  { id: "default", label: "默认", hint: "编辑文件和执行命令前先问你" },
  { id: "plan", label: "计划", hint: "只读分析，先给出计划，批准后再动手" },
  { id: "auto", label: "自动", hint: "安全的操作直接执行，有风险的才问你" },
];

export const EFFORTS: { id: Effort; label: string; budget: string }[] = [
  { id: "off", label: "关闭", budget: "不思考" },
  { id: "default", label: "默认", budget: "由模型决定" },
  { id: "low", label: "低", budget: "low" },
  { id: "medium", label: "中", budget: "medium" },
  { id: "high", label: "高", budget: "high" },
  { id: "max", label: "最大", budget: "max" },
];

export const MODE_STYLE: Record<PermissionMode, { icon: typeof Zap; className: string }> = {
  default: { icon: ShieldCheck, className: "" },
  plan: { icon: ClipboardList, className: "!text-info bg-info/10 hover:!bg-info/15" },
  auto: { icon: Zap, className: "!text-warning bg-warning/10 hover:!bg-warning/15" },
};

export function ModePicker({ mode, onChange }: { mode: PermissionMode; onChange: (m: PermissionMode) => void }) {
  const current = MODES.find((m) => m.id === mode) ?? MODES[0]!;
  const Icon = MODE_STYLE[mode].icon;
  return (
    <Menu>
      <Tooltip content="权限模式" keys={["⇧", "Tab"]} side="top">
        <MenuTrigger asChild>
          <button type="button" className={cn(pill, MODE_STYLE[mode].className)}>
            <Icon />
            {current.label}
          </button>
        </MenuTrigger>
      </Tooltip>
      <MenuContent side="top" className="w-[300px]">
        <MenuLabel>权限模式</MenuLabel>
        {MODES.map((m) => {
          const MIcon = MODE_STYLE[m.id].icon;
          return (
            <MenuItem
              key={m.id}
              onSelect={() => onChange(m.id)}
              className="h-auto items-start py-2"
              icon={<MIcon className={cn("mt-0.5", m.id === "plan" && "text-info", m.id === "auto" && "text-warning")} />}
              hint={m.id === mode ? <Check className="mt-0.5 size-3.5 text-accent" /> : undefined}
            >
              <span className="block font-medium">{m.label}</span>
              <span className="block whitespace-normal text-[12px] text-fg-3">{m.hint}</span>
            </MenuItem>
          );
        })}
        <MenuSeparator />
        <div className="flex items-center gap-1.5 px-2 py-1.5 text-[11.5px] text-fg-3">
          <Kbd>⇧</Kbd>
          <Kbd>Tab</Kbd>
          在模式之间切换
        </div>
      </MenuContent>
    </Menu>
  );
}

/**
 * Model picker. TODO(G6): the configured model list comes with `config/read`;
 * until then it shows the current model and takes a model name or profile id.
 */
export function ModelPicker({
  model,
  onChange,
  open: openProp,
  onOpenChange,
}: {
  model: string | undefined;
  onChange: (id: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (v: boolean) => {
    setOpenState(v);
    onOpenChange?.(v);
  };
  const [query, setQuery] = useState("");
  const typed = query.trim();
  const choose = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery("");
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setQuery("");
      }}
    >
      <Popover.Trigger asChild>
        <button type="button" className={pill}>
          <Cpu />
          {model ?? "默认模型"}
          <ChevronDown className="!size-3 text-fg-3" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="pop-in z-[70] w-[340px] overflow-hidden rounded-xl border border-line bg-elevated shadow-pop outline-none"
        >
          <form
            className="flex h-10 items-center gap-2 border-b border-line px-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (typed) choose(typed);
            }}
          >
            <Search className="size-3.5 text-fg-3" />
            <input
              // biome-ignore lint/a11y/noAutofocus: the picker opens to type a model
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="输入模型名称或配置里的模型句柄"
              className="h-full flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-3"
            />
          </form>
          <div className="p-1">
            {model && (
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="flex h-9 w-full items-center gap-2.5 rounded-lg bg-surface-2 px-2 text-left text-[13px] text-fg"
              >
                <Cpu className="size-4 text-fg-3" />
                <span className="min-w-0 flex-1 truncate">{model}</span>
                <Check className="size-3.5 text-accent" />
              </button>
            )}
            {typed && typed !== model && (
              <button
                type="button"
                onClick={() => choose(typed)}
                className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[13px] text-fg hover:bg-surface-2"
              >
                <Cpu className="size-4 text-fg-3" />
                <span className="min-w-0 flex-1 truncate">
                  使用 <span className="font-mono">{typed}</span>
                </span>
              </button>
            )}
            <div className="px-2.5 py-2 text-[11.5px] leading-[1.6] text-fg-3">
              TODO：读取 settings.json 里配置的模型列表需要 Agent 提供 config/read（G6）。
            </div>
          </div>
          <button
            type="button"
            disabled
            className="flex h-9 w-full items-center gap-2 border-t border-line px-3 text-left text-[12px] text-fg-2 opacity-45 transition-colors"
          >
            <Settings2 className="size-3.5" />
            管理服务商和模型
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function EffortPicker({
  effort,
  onChange,
  open,
  onOpenChange,
}: {
  effort: Effort;
  onChange: (e: Effort) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const current = EFFORTS.find((e) => e.id === effort) ?? EFFORTS[1]!;
  const level = effort === "off" ? 0 : effort === "default" ? 2 : ["low", "medium", "high", "max"].indexOf(effort) + 1;
  return (
    <Menu {...(open !== undefined ? { open } : {})} {...(onOpenChange ? { onOpenChange } : {})}>
      <Tooltip content={`思考强度：${current.label}`} side="top">
        <MenuTrigger asChild>
          <button type="button" className={cn(pill, effort === "off" && "text-fg-3")}>
            <Lightbulb className={cn(effort !== "off" && effort !== "low" && "text-accent")} />
            <span className="flex h-3 items-end gap-[2px]">
              {[1, 2, 3, 4].map((n) => (
                <span
                  key={n}
                  className={cn("w-[3px] rounded-full transition-colors", n <= level ? "bg-current" : "bg-fg-4/60")}
                  style={{ height: 4 + n * 2 }}
                />
              ))}
            </span>
          </button>
        </MenuTrigger>
      </Tooltip>
      <MenuContent side="top" className="w-[220px]">
        <MenuLabel>思考强度</MenuLabel>
        {EFFORTS.map((e) => (
          <MenuItem key={e.id} onSelect={() => onChange(e.id)} hint={e.budget} selected={e.id === effort}>
            {e.label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
