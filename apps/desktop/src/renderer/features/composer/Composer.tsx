import { ArrowUp, Paperclip, Square } from "lucide-react";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn, Tooltip } from "../../design/primitives";
import { interrupt, sendMessage, setEffort, setMode, setModel } from "../../state/actions";
import { useActiveView, useSessions } from "../../state/sessions";
import { useActiveWorkspace, useRuntime } from "../../state/workspaces";
import { EffortPicker, MODES, ModelPicker, ModePicker } from "./Pickers";

/**
 * Message input. TODO(M2): `/` skills and commands, `@` files, and image
 * attachments arrive with the next milestone.
 */
export function Composer({ variant = "dock" }: { variant?: "dock" | "hero" }) {
  const view = useActiveView();
  const draft = useSessions((s) => s.draft);
  const workspace = useActiveWorkspace();
  const runtime = useRuntime(workspace?.id);
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  const ready = runtime.status.state === "ready";
  const running = view?.busy ?? false;
  const settings = view ? { model: view.model, mode: view.permissionMode, effort: view.effort } : draft;

  // Keep the box sized to its content.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, variant === "hero" ? 280 : 240)}px`;
  }, [text, variant]);

  // Refocus when switching sessions.
  useEffect(() => {
    input.current?.focus();
  }, [view?.id]);

  const submit = async () => {
    const value = text.trim();
    if (!value || running || sending || !ready) return;
    setSending(true);
    const sent = await sendMessage(value);
    setSending(false);
    if (sent) setText("");
  };

  const cycleMode = () => {
    const order = MODES.map((m) => m.id);
    void setMode(order[(order.indexOf(settings.mode) + 1) % order.length]!);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.defaultPrevented) return;
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      cycleMode();
      return;
    }
    if (e.key === "Escape" && running) {
      e.preventDefault();
      void interrupt();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      void submit();
    }
  };

  const hero = variant === "hero";
  const canSend = text.trim().length > 0 && !running && !sending && ready;
  const placeholder = !ready
    ? runtime.status.state === "crashed"
      ? "Agent 进程已停止"
      : "Agent 正在启动…"
    : running
      ? "Agent 正在工作…"
      : hero
        ? `在 ${workspace?.name ?? "工作区"} 里想做点什么？`
        : "继续对话";

  return (
    <div className={cn("relative mx-auto w-full", hero ? "max-w-[720px]" : "max-w-[796px] px-8 pb-5")}>
      {!hero && <div className="pointer-events-none absolute inset-x-0 -top-10 h-10 bg-gradient-to-t from-canvas to-transparent" />}
      <div
        className={cn(
          "relative rounded-[20px] bg-canvas shadow-composer transition-[box-shadow,transform] duration-200",
          focused && "shadow-[0_0_0_1px_var(--accent-line),0_0_0_5px_var(--accent-softer),0_18px_40px_-18px_rgb(0_0_0/0.35)]",
        )}
      >
        <textarea
          ref={input}
          value={text}
          rows={1}
          placeholder={placeholder}
          aria-label="消息"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          className={cn(
            "scroll-thin block w-full resize-none bg-transparent px-4 text-fg outline-none placeholder:text-fg-3",
            hero ? "min-h-[92px] pt-4 text-[15.5px] leading-[1.6]" : "min-h-[52px] pt-3.5 text-[14.5px] leading-[1.6]",
          )}
        />

        <div className="flex items-center gap-0.5 px-2 pb-2 pt-1">
          <Tooltip content="附件在下一个版本接入" side="top">
            <span>
              <button
                type="button"
                disabled
                aria-label="添加附件"
                className="no-drag inline-flex size-7 items-center justify-center rounded-lg text-fg-3 opacity-45 transition-colors"
              >
                <Paperclip className="size-[15px]" />
              </button>
            </span>
          </Tooltip>
          <ModePicker mode={settings.mode} onChange={(mode) => void setMode(mode)} />
          <ModelPicker model={settings.model} onChange={(model) => void setModel(model)} />
          <EffortPicker effort={settings.effort} onChange={(effort) => void setEffort(effort)} />

          <span className="flex-1" />

          {running ? (
            <Tooltip content="中断" keys={["Esc"]} side="top">
              <button
                type="button"
                onClick={() => void interrupt()}
                className="relative flex size-8 items-center justify-center rounded-full bg-fg text-canvas transition-transform active:scale-95"
                aria-label="中断"
              >
                <span className="absolute inset-0 animate-ping rounded-full bg-fg/20 [animation-duration:2s]" />
                <Square className="size-3 fill-current" />
              </button>
            </Tooltip>
          ) : (
            <Tooltip content="发送" keys={["↵"]} side="top">
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!canSend}
                className={cn(
                  "flex size-8 items-center justify-center rounded-full transition-all active:scale-95",
                  canSend ? "bg-accent text-accent-fg shadow-[inset_0_1px_0_rgb(255_255_255/0.2)] hover:bg-accent-hover" : "bg-surface-3 text-fg-4",
                )}
                aria-label="发送"
              >
                <ArrowUp className="size-4" strokeWidth={2.4} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>

      {!hero && (
        <div className="mt-2 flex items-center justify-center gap-3 text-[11px] text-fg-4">
          <span>Easy Agent 可能会出错，重要改动请复核</span>
        </div>
      )}
    </div>
  );
}
