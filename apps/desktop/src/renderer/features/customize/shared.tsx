import { ChevronDown, FolderOpen, Globe, HardDrive, Package, Settings2, Shield } from "lucide-react";
import type { ReactNode } from "react";
import { cn, Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Tooltip } from "../../design/primitives";
import { desktop } from "../../lib/desktop";
import { tokens as fmt } from "../../lib/format";
import { SCOPE_FILE, SCOPE_HINT, SCOPE_LABEL, WRITE_SCOPES } from "../../lib/scopes";
import { useCustomize } from "../../state/customize";
import type { Origin } from "./model";

export { DetailDrawer, Modal } from "../../design/Overlays";

export const SCOPE_ICON = {
  user: Globe,
  project: FolderOpen,
  local: HardDrive,
  flag: Settings2,
  policy: Shield,
  plugin: Package,
  builtin: Package,
} as const;

export function ScopeBadge({ origin, className }: { origin: Origin; className?: string }) {
  const Icon = SCOPE_ICON[origin.kind];
  const label = origin.kind === "plugin" ? origin.plugin : origin.kind === "builtin" ? "内置" : SCOPE_LABEL[origin.kind];
  return (
    <span
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center gap-1 rounded-[5px] px-1.5 text-[10.5px] font-medium",
        origin.kind === "user" && "bg-info/10 text-info",
        origin.kind === "project" && "bg-success/12 text-success",
        origin.kind === "local" && "bg-warning/12 text-warning",
        (origin.kind === "plugin" || origin.kind === "builtin" || origin.kind === "flag" || origin.kind === "policy") && "bg-surface-3 text-fg-2",
        className,
      )}
    >
      <Icon className="size-2.5" />
      {label}
    </span>
  );
}

/** Context cost of one item; `per` explains when it is paid. */
export function TokenTag({ value, muted, per, className }: { value: number; muted?: boolean; per?: string; className?: string }) {
  return (
    <span className={cn("tabular inline-flex items-baseline gap-1 whitespace-nowrap text-[12px]", muted || value === 0 ? "text-fg-4" : "text-fg-2", className)}>
      {value === 0 ? "0" : fmt(value)}
      <span className="text-[10.5px] text-fg-3">{per ?? "tokens"}</span>
    </span>
  );
}

export function PageHeader({
  icon,
  title,
  en,
  description,
  actions,
}: {
  icon: ReactNode;
  title: string;
  en: string;
  description: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex items-start gap-4">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-[13px] border border-line bg-surface text-fg-2 [&_svg]:size-5">{icon}</span>
      <div className="min-w-0 flex-1">
        <h2 className="flex items-baseline gap-2 text-[20px] font-semibold tracking-[-0.02em] text-fg">
          {title}
          <span className="text-[13px] font-normal tracking-normal text-fg-3">{en}</span>
        </h2>
        <p className="mt-1 max-w-[620px] text-[13px] leading-[1.6] text-fg-2">{description}</p>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2 pt-1">{actions}</div>}
    </div>
  );
}

export interface ScopeCardInfo {
  id: string;
  scope: "user" | "project" | "local" | "plugin";
  title: string;
  path: string;
  /** Folder or file 「打开」 shows; the card has no 打开 without it. */
  open?: string;
  count: number;
  hint: string;
}

/** The homes a capability can live in, doubling as a filter. */
export function ScopeCards({ cards, active, onSelect }: { cards: ScopeCardInfo[]; active: string; onSelect: (id: string) => void }) {
  return (
    <div className="mb-5 grid gap-2.5" style={{ gridTemplateColumns: `repeat(${cards.length}, minmax(0, 1fr))` }}>
      {cards.map((c) => {
        const Icon = SCOPE_ICON[c.scope];
        const selected = active === c.id;
        return (
          // biome-ignore lint/a11y/useSemanticElements: the card holds a nested button
          <div
            key={c.id}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(selected ? "all" : c.id)}
            onKeyDown={(e) => e.key === "Enter" && onSelect(selected ? "all" : c.id)}
            className={cn(
              "group relative cursor-default rounded-xl border p-3 text-left transition-all",
              selected ? "border-accent-line bg-accent-softer shadow-[0_0_0_3px_var(--accent-softer)]" : "border-line bg-canvas hover:border-line-strong",
            )}
          >
            <div className="flex items-center gap-2">
              <Icon
                className={cn(
                  "size-3.5",
                  c.scope === "user" ? "text-info" : c.scope === "project" ? "text-success" : c.scope === "local" ? "text-warning" : "text-fg-3",
                )}
              />
              <span className="text-[12.5px] font-medium text-fg">{c.title}</span>
              <span className="tabular ml-auto text-[12px] text-fg-3">{c.count}</span>
            </div>
            <div className="mt-1.5 flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-3" title={c.path}>
                {c.path}
              </span>
              {c.open && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void desktop.app.openPath(c.open!);
                  }}
                  className="shrink-0 rounded px-1 text-[10.5px] text-fg-3 opacity-0 transition-opacity hover:text-fg group-hover:opacity-100"
                >
                  打开
                </button>
              )}
            </div>
            <div className="mt-1 text-[11px] text-fg-3">{c.hint}</div>
          </div>
        );
      })}
    </div>
  );
}

/** Which settings file switches on this page write to. */
export function WriteScopePicker({ what }: { what: string }) {
  const scope = useCustomize((s) => s.writeScope);
  const setScope = useCustomize((s) => s.setWriteScope);
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-[9px] border border-line bg-canvas pl-2.5 pr-2 text-[12.5px] text-fg-2 transition-colors hover:border-line-strong hover:text-fg data-[state=open]:border-line-strong"
        >
          <span className="text-fg-3">{what}写入</span>
          <span className="font-medium text-fg">{SCOPE_LABEL[scope]}</span>
          <ChevronDown className="size-3.5 text-fg-3" />
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="w-[300px]">
        <MenuLabel>开关和改动写到哪份配置</MenuLabel>
        {WRITE_SCOPES.map((s) => {
          const Icon = SCOPE_ICON[s];
          return (
            <MenuItem key={s} onSelect={() => setScope(s)} className="h-auto items-start py-2" icon={<Icon className="mt-0.5" />} selected={s === scope}>
              <span className="block font-medium">{SCOPE_LABEL[s]}</span>
              <span className="block font-mono text-[11px] text-fg-3">{SCOPE_FILE[s]}</span>
              <span className="block text-[11.5px] text-fg-3">{SCOPE_HINT[s]}</span>
            </MenuItem>
          );
        })}
        <div className="border-t border-line px-2 py-2 text-[11px] leading-[1.5] text-fg-3">
          同一项在多份配置里都有设置时，按 全局 → 项目 → 本机 的顺序，后面的覆盖前面的。
        </div>
      </MenuContent>
    </Menu>
  );
}

export function Section({ title, meta, children, action }: { title: ReactNode; meta?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center gap-2 px-1">
        <h3 className="text-[12.5px] font-semibold text-fg">{title}</h3>
        {meta && <span className="min-w-0 truncate font-mono text-[11px] text-fg-3">{meta}</span>}
        <span className="flex-1" />
        {action}
      </div>
      <div className="overflow-hidden rounded-xl border border-line bg-canvas">{children}</div>
    </section>
  );
}

export function ItemRow({
  icon,
  title,
  badges,
  description,
  right,
  onClick,
  selected,
  dimmed,
}: {
  icon: ReactNode;
  title: ReactNode;
  badges?: ReactNode;
  description?: ReactNode;
  right?: ReactNode;
  onClick?: () => void;
  selected?: boolean;
  dimmed?: boolean;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: rows contain switches
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => e.key === "Enter" && onClick?.()}
      className={cn(
        "group flex cursor-default items-center gap-3 border-b border-line px-3.5 py-3 transition-colors last:border-b-0",
        selected ? "bg-accent-softer" : "hover:bg-surface-2/50",
      )}
    >
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-[9px] border border-line bg-surface text-fg-2 [&_svg]:size-4",
          dimmed && "opacity-50",
        )}
      >
        {icon}
      </span>
      <div className={cn("min-w-0 flex-1", dimmed && "opacity-55")}>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-fg">{title}</span>
          {badges}
        </div>
        {description && <div className="mt-0.5 truncate text-[12px] text-fg-3">{description}</div>}
      </div>
      {right && (
        // biome-ignore lint/a11y/noStaticElementInteractions: stops row clicks from toggling details
        <div className="flex shrink-0 items-center gap-3" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          {right}
        </div>
      )}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1.5 text-[11.5px] font-medium text-fg-3">{label}</div>
      {children}
      {hint && <div className="mt-1.5 text-[11.5px] leading-[1.55] text-fg-3">{hint}</div>}
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
      <div className="text-[11px] text-fg-3">{label}</div>
      <div className="tabular mt-0.5 text-[14px] font-semibold text-fg">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-fg-3">{sub}</div>}
    </div>
  );
}

export function Chips({ items, mono = true }: { items: string[]; mono?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((i) => (
        <span key={i} className={cn("rounded-md border border-line bg-surface px-1.5 py-0.5 text-[11.5px] text-fg-2", mono && "font-mono")}>
          {i}
        </span>
      ))}
    </div>
  );
}

/** Pick one scope, shown as cards with the file or folder it writes to. */
export function ScopeChoice<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { id: T; scope: "user" | "project" | "local"; title: string; path: string; hint: string }[];
}) {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => {
        const Icon = SCOPE_ICON[o.scope];
        const selected = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            className={cn(
              "rounded-xl border p-3 text-left transition-all",
              selected ? "border-accent bg-accent-softer shadow-[0_0_0_3px_var(--accent-soft)]" : "border-line bg-surface hover:border-line-strong",
            )}
          >
            <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-fg">
              <Icon className={cn("size-3.5", o.scope === "user" ? "text-info" : o.scope === "project" ? "text-success" : "text-warning")} />
              {o.title}
            </div>
            <div className="mt-1 truncate font-mono text-[10.5px] text-fg-3">{o.path}</div>
            <div className="mt-1 text-[11px] leading-[1.45] text-fg-3">{o.hint}</div>
          </button>
        );
      })}
    </div>
  );
}

/**
 * A switch the Agent cannot honor yet: shown in place, turned off for input,
 * with the reason on hover. `reason` names what the Agent still has to add.
 */
export function PendingSwitch({ checked, reason }: { checked: boolean; reason: string }) {
  return (
    <Tooltip content={reason}>
      {/* A disabled button gets no pointer events, so the wrapper carries the tooltip. */}
      <span className="inline-flex cursor-not-allowed">
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          disabled
          className={cn("pointer-events-none relative h-5 w-[34px] shrink-0 rounded-full opacity-45", checked ? "bg-accent" : "bg-surface-3")}
        >
          <span className={cn("absolute top-[2px] size-4 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.25)]", checked ? "left-[16px]" : "left-[2px]")} />
        </button>
      </span>
    </Tooltip>
  );
}

export const inputClass =
  "h-9 w-full rounded-[10px] border border-line bg-canvas px-3 text-[13px] text-fg outline-none transition-colors placeholder:text-fg-3 focus:border-accent-line focus:shadow-[0_0_0_3px_var(--accent-softer)]";
