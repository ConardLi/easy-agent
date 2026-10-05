import { clsx, type ClassValue } from "clsx";
import { Loader } from "lucide-react";
import { DropdownMenu, Tooltip as RTooltip } from "radix-ui";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export const cn = (...v: ClassValue[]): string => clsx(v);

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? "⌘" : "Ctrl";

/* ------------------------------------------------------------------ */

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-line bg-surface-2 px-1 font-sans text-[10.5px] font-medium text-fg-3",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function Shortcut({ keys, className }: { keys: string[]; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)}>
      {keys.map((k) => (
        <Kbd key={k}>{k}</Kbd>
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ */

export function Tooltip({
  content,
  keys,
  side = "bottom",
  children,
  delay = 350,
}: {
  content: ReactNode;
  keys?: string[];
  side?: "top" | "bottom" | "left" | "right";
  children: ReactNode;
  delay?: number;
}) {
  return (
    <RTooltip.Root delayDuration={delay}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={6}
          className="z-[80] flex items-center gap-2 rounded-lg bg-[#1d1d21] px-2.5 py-1.5 text-[12px] font-medium text-white shadow-pop tip-in dark:bg-[#2a2a30]"
        >
          {content}
          {keys && (
            <span className="flex items-center gap-0.5">
              {keys.map((k) => (
                <span key={k} className="rounded bg-white/12 px-1 text-[10.5px] text-white/70">
                  {k}
                </span>
              ))}
            </span>
          )}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

/* ------------------------------------------------------------------ */

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: "sm" | "md" | "lg";
  active?: boolean;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ size = "md", active, className, children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        "no-drag inline-flex shrink-0 items-center justify-center rounded-lg text-fg-3 transition-colors hover:bg-surface-2 hover:text-fg disabled:pointer-events-none disabled:opacity-40",
        size === "sm" && "size-6 [&_svg]:size-3.5",
        size === "md" && "size-7 [&_svg]:size-4",
        size === "lg" && "size-8 [&_svg]:size-[17px]",
        active && "bg-surface-2 text-fg",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "outline";
  size?: "sm" | "md";
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = "secondary", size = "md", className, children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        "no-drag inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] font-medium transition-all active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-[15px]",
        size === "sm" ? "h-7 px-2.5 text-[12.5px]" : "h-8 px-3 text-[13px]",
        variant === "primary" && "bg-accent text-accent-fg shadow-[inset_0_1px_0_rgb(255_255_255/0.16),0_1px_2px_rgb(0_0_0/0.2)] hover:bg-accent-hover",
        variant === "secondary" && "bg-surface-2 text-fg hover:bg-surface-3",
        variant === "outline" && "border border-line-strong bg-transparent text-fg hover:bg-surface-2",
        variant === "ghost" && "text-fg-2 hover:bg-surface-2 hover:text-fg",
        variant === "danger" && "text-danger hover:bg-danger/10",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

/* ------------------------------------------------------------------ */

export function Spinner({ className }: { className?: string }) {
  return <Loader className={cn("size-3.5 animate-spin text-fg-3 [animation-duration:1.4s]", className)} />;
}

/* ------------------------------------------------------------------ */
/* Menus                                                               */
/* ------------------------------------------------------------------ */

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;

export function MenuContent({
  children,
  align = "start",
  side = "bottom",
  className,
  sideOffset = 6,
}: {
  children: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
  sideOffset?: number;
}) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        align={align}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={12}
        className={cn("pop-in z-[70] min-w-[200px] rounded-xl border border-line bg-elevated p-1 shadow-pop outline-none", className)}
      >
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}

export function MenuItem({
  children,
  onSelect,
  icon,
  hint,
  danger,
  selected,
  className,
}: {
  children: ReactNode;
  onSelect?: () => void;
  icon?: ReactNode;
  hint?: ReactNode;
  danger?: boolean;
  selected?: boolean;
  className?: string;
}) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={cn(
        "group flex h-8 cursor-default select-none items-center gap-2.5 rounded-lg px-2 text-[13px] text-fg outline-none data-[highlighted]:bg-surface-2 [&_svg]:size-[15px] [&_svg]:shrink-0",
        danger && "text-danger data-[highlighted]:bg-danger/10",
        className,
      )}
    >
      {icon && <span className={cn("flex text-fg-3", danger && "text-danger")}>{icon}</span>}
      <span className="flex-1 truncate">{children}</span>
      {hint && <span className="text-[11.5px] text-fg-3">{hint}</span>}
      {selected !== undefined && <span className={cn("size-1.5 rounded-full", selected ? "bg-accent" : "bg-transparent")} />}
    </DropdownMenu.Item>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DropdownMenu.Label className="px-2 pb-1 pt-2 text-[11px] font-medium text-fg-3">{children}</DropdownMenu.Label>;
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="mx-1 my-1 h-px bg-line" />;
}

/* ------------------------------------------------------------------ */

export function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn("relative h-5 w-[34px] shrink-0 rounded-full transition-colors", checked ? "bg-accent" : "bg-surface-3")}
    >
      <span
        className={cn(
          "absolute top-[2px] size-4 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.25)] transition-all",
          checked ? "left-[16px]" : "left-[2px]",
        )}
      />
    </button>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-[10px] bg-surface-2 p-[3px]">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-[7px] px-3 text-[12.5px] font-medium transition-all",
            value === o.value ? "bg-canvas text-fg shadow-[0_1px_2px_rgb(0_0_0/0.12),0_0_0_1px_var(--line)]" : "text-fg-3 hover:text-fg-2",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
