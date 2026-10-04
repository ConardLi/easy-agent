import { CircleAlert, CircleCheck, Info } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "../../design/primitives";
import { useUi } from "../../state/ui";

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-[100] flex -translate-x-1/2 flex-col items-center gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const Icon = t.tone === "success" ? CircleCheck : t.tone === "danger" ? CircleAlert : Info;
          return (
            <motion.button
              layout
              key={t.id}
              type="button"
              onClick={() => dismiss(t.id)}
              initial={{ opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.97, transition: { duration: 0.15 } }}
              transition={{ type: "spring", bounce: 0.25, duration: 0.4 }}
              className="pointer-events-auto flex h-9 items-center gap-2 rounded-full border border-line bg-elevated pl-3 pr-4 text-[12.5px] font-medium text-fg shadow-pop"
            >
              <Icon className={cn("size-4", t.tone === "success" ? "text-success" : t.tone === "danger" ? "text-danger" : "text-fg-3")} />
              {t.text}
            </motion.button>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
