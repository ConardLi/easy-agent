import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Dialog } from "radix-ui";
import type { ReactNode } from "react";
import { IconButton } from "./primitives";

/** Details of the selected item, sliding in from the right edge of the view. */
export function DetailDrawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          initial={{ x: 24, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 24, opacity: 0 }}
          transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
          className="absolute inset-y-0 right-0 z-20 flex w-[420px] flex-col border-l border-line bg-canvas shadow-[-24px_0_48px_-24px_rgb(0_0_0/0.35)]"
        >
          <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line pl-5 pr-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-semibold text-fg">{title}</div>
              {subtitle && <div className="truncate text-[11.5px] text-fg-3">{subtitle}</div>}
            </div>
            <IconButton onClick={onClose} aria-label="关闭">
              <X />
            </IconButton>
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex shrink-0 items-center gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 560,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer: ReactNode;
  width?: number;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay-in fixed inset-0 z-[90] bg-black/35 backdrop-blur-[3px]" />
        <Dialog.Content
          onOpenAutoFocus={(e) => e.preventDefault()}
          style={{ width: `min(${width}px, calc(100vw - 48px))` }}
          className="dialog-in fixed left-1/2 top-1/2 z-[91] flex max-h-[calc(100vh-64px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-elevated shadow-pop outline-none"
        >
          <div className="flex items-start gap-3 px-6 pb-2 pt-5">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-[16px] font-semibold tracking-[-0.01em] text-fg">{title}</Dialog.Title>
              {description && <Dialog.Description className="mt-1 text-[12.5px] leading-[1.55] text-fg-3">{description}</Dialog.Description>}
            </div>
            <Dialog.Close asChild>
              <IconButton aria-label="关闭">
                <X />
              </IconButton>
            </Dialog.Close>
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 py-3">{children}</div>
          <div className="flex items-center justify-end gap-2 border-t border-line px-6 py-3.5">{footer}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
