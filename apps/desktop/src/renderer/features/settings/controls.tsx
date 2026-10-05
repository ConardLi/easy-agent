import { Lock, Plus, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn, IconButton, Tooltip } from "../../design/primitives";
import { SCOPE_FILE, SCOPE_ICON, SCOPE_LABEL, type SettingLayer } from "../../lib/scopes";
import { useSettings } from "../../state/settings";
import { type SettingKey, TODO_SETTINGS } from "./agentSettings";

export function ScopeTag({ scope, plugin, className }: { scope?: SettingLayer; plugin?: string; className?: string }) {
  if (plugin)
    return (
      <span className={cn("inline-flex h-[18px] items-center rounded-[5px] bg-surface-3 px-1.5 text-[10.5px] font-medium text-fg-2", className)}>
        插件 {plugin}
      </span>
    );
  if (!scope) return <span className={cn("inline-flex h-[18px] items-center rounded-[5px] px-1.5 text-[10.5px] text-fg-4", className)}>默认</span>;
  const Icon = SCOPE_ICON[scope];
  return (
    <Tooltip content={SCOPE_FILE[scope]}>
      <span
        className={cn(
          "inline-flex h-[18px] shrink-0 items-center gap-1 rounded-[5px] px-1.5 text-[10.5px] font-medium",
          scope === "user" && "bg-info/10 text-info",
          scope === "project" && "bg-success/12 text-success",
          scope === "local" && "bg-warning/12 text-warning",
          (scope === "flag" || scope === "policy") && "bg-surface-3 text-fg-2",
          className,
        )}
      >
        <Icon className="size-2.5" />
        {SCOPE_LABEL[scope]}
      </span>
    </Tooltip>
  );
}

export function PageTitle({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex items-end gap-4">
      <div className="min-w-0 flex-1">
        <h2 className="text-[20px] font-semibold tracking-[-0.02em] text-fg">{title}</h2>
        {description && <p className="mt-1 max-w-[640px] text-[13px] leading-[1.6] text-fg-2">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Group({ title, description, children, action }: { title?: string; description?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="mb-7">
      {(title || action) && (
        <div className="mb-2 flex items-end gap-2 px-1">
          <div className="min-w-0 flex-1">
            {title && <h3 className="text-[13px] font-semibold text-fg">{title}</h3>}
            {description && <p className="mt-0.5 text-[12px] leading-[1.55] text-fg-3">{description}</p>}
          </div>
          {action}
        </div>
      )}
      <div className="rounded-xl border border-line bg-canvas px-4">{children}</div>
    </section>
  );
}

/**
 * One setting. `k` is the settings key: it is shown in monospace, its source
 * file is shown as a tag, and user-only keys are locked while editing a
 * project or local file.
 */
export function Row({
  title,
  hint,
  k,
  children,
  stack,
}: {
  title: string;
  hint?: ReactNode;
  k?: SettingKey | keyof typeof TODO_SETTINGS;
  children: ReactNode;
  stack?: boolean;
}) {
  const sources = useSettings((s) => s.sources);
  const writeScope = useSettings((s) => s.writeScope);
  const userOnly = useSettings((s) => s.config?.userOnlyKeys);
  const locked = !!k && !!userOnly?.includes(k) && writeScope !== "user";
  const todo = k ? TODO_SETTINGS[k] : undefined;
  return (
    <div className={cn("group/row border-b border-line py-3.5 last:border-b-0", stack ? "flex flex-col gap-2.5" : "flex items-center justify-between gap-6")}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[13.5px] font-medium text-fg">{title}</span>
          {k && !todo && <ScopeTag scope={sources[k as SettingKey]} />}
          {todo && (
            <Tooltip content={`settings.json 里还没有这一项，现在通过 ${todo} 设置`}>
              <span className="rounded-[5px] bg-warning/12 px-1.5 text-[10px] font-semibold leading-[18px] text-warning">TODO</span>
            </Tooltip>
          )}
          {k && <span className="font-mono text-[10.5px] text-fg-4 opacity-0 transition-opacity group-hover/row:opacity-100">{k}</span>}
        </div>
        {hint && <div className="mt-0.5 text-[12.5px] leading-[1.55] text-fg-3">{hint}</div>}
        {todo && <div className="mt-0.5 font-mono text-[11px] text-fg-4">现在：{todo}</div>}
      </div>
      {locked ? (
        <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-fg-3">
          <Lock className="size-3.5" />
          只能写在全局设置
        </span>
      ) : (
        // Settings that only exist as environment variables cannot be saved from here yet.
        <div className={cn(stack ? "w-full" : "shrink-0", todo && "pointer-events-none opacity-45")} aria-disabled={todo ? true : undefined}>
          {children}
        </div>
      )}
    </div>
  );
}

export function NumberInput({
  value,
  onChange,
  onBlur,
  min = 0,
  step = 1,
  suffix,
  width = 96,
}: {
  value: number;
  onChange: (v: number) => void;
  onBlur?: () => void;
  min?: number;
  step?: number;
  suffix?: string;
  width?: number;
}) {
  return (
    <div className="flex h-8 items-center rounded-[9px] border border-line bg-surface focus-within:border-accent-line" style={{ width }}>
      <input
        type="number"
        min={min}
        step={step}
        value={value}
        onChange={(e) => onChange(Math.max(min, Number(e.target.value) || 0))}
        onBlur={onBlur}
        className="tabular h-full min-w-0 flex-1 bg-transparent px-2.5 text-[13px] text-fg outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
      />
      {suffix && <span className="pr-2.5 text-[12px] text-fg-3">{suffix}</span>}
    </div>
  );
}

export function TextInput({
  value,
  onChange,
  onBlur,
  placeholder,
  mono,
  width,
  type = "text",
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  mono?: boolean;
  width?: number;
  type?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      placeholder={placeholder}
      style={width ? { width } : undefined}
      className={cn(
        "h-8 w-full rounded-[9px] border border-line bg-surface px-2.5 text-[13px] text-fg outline-none transition-colors placeholder:text-fg-4 focus:border-accent-line focus:bg-canvas",
        mono && "font-mono text-[12.5px]",
      )}
    />
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  width = 180,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  width?: number;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      style={{ width }}
      className="h-8 rounded-[9px] border border-line bg-surface px-2 text-[13px] text-fg outline-none focus:border-accent-line"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** A list of strings (paths, domains, commands) with add and remove. */
export function ListEditor({
  items,
  onChange,
  placeholder,
  mono = true,
  empty,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  placeholder: string;
  mono?: boolean;
  empty?: string;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v || items.includes(v)) return;
    onChange([...items, v]);
    setDraft("");
  };
  return (
    <div className="w-full">
      <div className="flex flex-wrap gap-1.5">
        {items.map((i) => (
          <span
            key={i}
            className={cn(
              "group/chip inline-flex h-7 items-center gap-1 rounded-lg border border-line bg-surface pl-2.5 pr-1 text-[12px] text-fg-2",
              mono && "font-mono",
            )}
          >
            {i}
            <IconButton
              size="sm"
              className="size-5 opacity-50 group-hover/chip:opacity-100"
              onClick={() => onChange(items.filter((x) => x !== i))}
              aria-label={`删除 ${i}`}
            >
              <X />
            </IconButton>
          </span>
        ))}
        {items.length === 0 && empty && <span className="text-[12px] leading-7 text-fg-4">{empty}</span>}
      </div>
      <form
        className="mt-2 flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <TextInput value={draft} onChange={setDraft} placeholder={placeholder} mono={mono} />
        <IconButton type="submit" aria-label="添加" className="size-8 border border-line">
          <Plus />
        </IconButton>
      </form>
    </div>
  );
}
