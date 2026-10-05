import { ArrowUp, ArrowUpRight, AtSign, Bot, Camera, FileCode2, ImagePlus, Paperclip, Slash, Sparkles, Square, SquareSlash, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ClipboardEvent, type DragEvent, type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ImageInput } from "../../../shared/agent";
import type { Attachment } from "../../agent/viewModel";
import { cn, Kbd, Menu, MenuContent, MenuItem, MenuTrigger, MOD, Tooltip } from "../../design/primitives";
import { desktop } from "../../lib/desktop";
import { basename, dirname, uid } from "../../lib/format";
import { aliasFor, GROUP_LABEL, listSlash, matchSlash, type SlashEntry, type SlashGroup } from "../../lib/slash";
import { usePrefs } from "../../state/prefs";
import { interrupt, runUiAction, sendMessage, setEffort, setMode, setModel } from "../../state/actions";
import { useActiveView, useSessions } from "../../state/sessions";
import { notYet, useUi } from "../../state/ui";
import { useActiveWorkspace, useRuntime } from "../../state/workspaces";
import { EffortPicker, MODES, ModelPicker, ModePicker } from "./Pickers";

type Suggest = { kind: "slash"; query: string } | { kind: "mention"; query: string; start: number } | null;

type Pending = Attachment & { image: ImageInput };

const GROUP_ICON: Record<SlashGroup, typeof Sparkles> = { skill: Sparkles, command: SquareSlash, agent: Bot, action: ArrowUpRight };

/** Image types the model accepts, and the largest file sent as-is (the API limit is 5 MB of base64). */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 3_750_000;

function detectSuggest(text: string, caret: number): Suggest {
  const before = text.slice(0, caret);
  if (/^\/[\w:-]*$/.test(before)) return { kind: "slash", query: before.slice(1) };
  const m = /(^|\s)@([\w./-]*)$/.exec(before);
  if (m) return { kind: "mention", query: m[2] ?? "", start: before.length - (m[2] ?? "").length - 1 };
  return null;
}

function readAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function Composer({ variant = "dock" }: { variant?: "dock" | "hero" }) {
  const view = useActiveView();
  const draft = useSessions((s) => s.draft);
  const workspace = useActiveWorkspace();
  const runtime = useRuntime(workspace?.id);
  const toast = useUi((s) => s.toast);
  const picker = useUi((s) => s.picker);
  const setPicker = useUi((s) => s.setPicker);
  const sendWith = usePrefs((s) => s.sendWith);

  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Pending[]>([]);
  const [suggest, setSuggest] = useState<Suggest>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const imagePicker = useRef<HTMLInputElement>(null);

  const status = runtime.status;
  const ready = status.state === "ready";
  const running = view?.busy ?? false;
  const waiting = (view?.pendingRequests.length ?? 0) > 0;
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
    setSuggest(null);
  }, [view?.id]);

  const entries = useMemo(() => listSlash(status.state === "ready" ? status.init.capabilities : undefined), [status]);
  const commands = useMemo(() => (suggest?.kind === "slash" ? matchSlash(entries, suggest.query) : []), [suggest, entries]);
  /** The skill or command the message starts with, shown above the text. */
  const invoked = useMemo(() => {
    const m = /^\/([\w:-]+)(\s|$)/.exec(text);
    return m ? entries.find((e) => e.name === m[1]) : undefined;
  }, [text, entries]);

  // Workspace files for `@`, fetched as the query changes.
  const mentionQuery = suggest?.kind === "mention" ? suggest.query : null;
  useEffect(() => {
    if (mentionQuery === null || !workspace) return setFiles([]);
    let current = true;
    const timer = setTimeout(() => {
      void desktop.workspaces.files(workspace.id, mentionQuery).then((list) => current && setFiles(list.slice(0, 8)));
    }, 60);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [mentionQuery, workspace]);

  const options = suggest?.kind === "slash" ? commands.length : files.length;
  // Reset the highlight when the menu changes.
  useEffect(() => setCursor(0), [suggest?.kind, suggest?.query]);

  const refreshSuggest = (value: string, caret: number) => setSuggest(detectSuggest(value, caret));

  const runAction = (e: SlashEntry) => {
    setText("");
    setSuggest(null);
    if (e.action === "model" || e.action === "effort") setPicker(e.action);
    else if (e.action === "plan" || e.action === "auto") void setMode(settings.mode === e.action ? "default" : e.action);
    else if (e.action) runUiAction(e.action);
  };

  const pick = (e: SlashEntry | undefined) => {
    if (!e) return;
    if (e.group === "action") return runAction(e);
    setSuggest(null);
    if (e.group === "agent" && !e.args && !running) {
      setText("");
      void sendMessage(`/${e.name}`);
      return;
    }
    setText(`/${e.name} `);
    requestAnimationFrame(() => input.current?.focus());
  };

  const insertMention = (path: string) => {
    const caret = input.current?.selectionStart ?? text.length;
    const start = suggest?.kind === "mention" ? suggest.start : caret;
    const next = `${text.slice(0, start)}@${path} ${text.slice(caret)}`;
    setText(next);
    setSuggest(null);
    requestAnimationFrame(() => {
      const pos = start + path.length + 2;
      input.current?.focus();
      input.current?.setSelectionRange(pos, pos);
    });
  };

  const submit = async () => {
    const value = text.trim();
    if ((!value && attachments.length === 0) || sending || !ready) return;
    if (running) return toast(waiting ? "先处理上面的请求，或按 Esc 中断" : "Agent 正在工作，按 Esc 中断后再发送");
    const slash = /^\/([\w:-]+)\s*$/.exec(value);
    const alias = slash && !entries.some((e) => e.name === slash[1]) ? aliasFor(slash[1]!) : undefined;
    if (alias) return runAction(alias);
    setSending(true);
    const sent = await sendMessage(
      value,
      attachments.map((a) => a.image),
    );
    setSending(false);
    if (!sent) return;
    setText("");
    setAttachments([]);
    setSuggest(null);
  };

  const cycleMode = () => {
    const order = MODES.map((m) => m.id);
    void setMode(order[(order.indexOf(settings.mode) + 1) % order.length]!);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.defaultPrevented) return;
    if (suggest && options > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => (c + (e.key === "ArrowDown" ? 1 : options - 1)) % options);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (suggest.kind === "slash") pick(commands[cursor]);
        else if (files[cursor]) insertMention(files[cursor]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSuggest(null);
        return;
      }
    }
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
    if (e.key === "Enter" && !e.shiftKey) {
      const mod = e.metaKey || e.ctrlKey;
      if (sendWith === "enter" ? !mod : mod) {
        e.preventDefault();
        void submit();
      }
    }
  };

  const addImage = async (blob: Blob, name: string) => {
    if (!IMAGE_TYPES.has(blob.type)) return toast("只支持 PNG、JPEG、GIF 和 WebP 图片");
    if (blob.size > MAX_IMAGE_BYTES) return toast("图片太大了，超过 3.75 MB");
    const data = await readAsBase64(blob);
    const mimeType = blob.type as ImageInput["mimeType"];
    setAttachments((list) => [
      ...list,
      { id: uid("att"), kind: "image", name, preview: `center / cover no-repeat url(data:${mimeType};base64,${data})`, image: { data, mimeType } },
    ]);
  };

  /** Images become attachments; other files inside the workspace become `@` mentions. */
  const takeFiles = (list: FileList | File[]) => {
    for (const file of Array.from(list)) {
      if (file.type.startsWith("image/")) {
        void addImage(file, file.name || "粘贴的图片");
        continue;
      }
      const path = desktop.pathOf(file);
      const root = workspace ? `${workspace.path.replace(/[/\\]+$/, "")}/` : "";
      if (path && root && path.startsWith(root)) insertMention(path.slice(root.length));
      else toast("只能引用当前工作区里的文件");
    }
  };

  const captureScreen = async () => {
    const shot = await desktop.app.captureScreen();
    if (!shot) return;
    const bytes = Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0));
    const time = new Date().toTimeString().slice(0, 8).replace(/:/g, ".");
    await addImage(new Blob([bytes], { type: shot.mimeType }), `截图 ${time}.png`);
  };

  const onPaste = (e: ClipboardEvent) => {
    if (e.clipboardData.files.length > 0) {
      e.preventDefault();
      takeFiles(e.clipboardData.files);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) takeFiles(e.dataTransfer.files);
  };

  const hero = variant === "hero";
  const canSend = (text.trim().length > 0 || attachments.length > 0) && !running && !sending && ready;
  const placeholder = !ready
    ? status.state === "crashed"
      ? "Agent 进程已停止"
      : "Agent 正在启动…"
    : waiting
      ? "先处理上面的请求，或按 Esc 中断"
      : running
        ? "Agent 正在工作…"
        : hero
          ? `在 ${workspace?.name ?? "工作区"} 里想做点什么？`
          : "继续对话，/ 使用技能，@ 引用文件";

  return (
    <div className={cn("relative mx-auto w-full", hero ? "max-w-[720px]" : "max-w-[796px] px-8 pb-5")}>
      {!hero && <div className="pointer-events-none absolute inset-x-0 -top-10 h-10 bg-gradient-to-t from-canvas to-transparent" />}
      <AnimatePresence>
        {suggest && options > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.14 }}
            className={cn(
              "absolute bottom-full z-30 mb-2 overflow-hidden rounded-xl border border-line bg-elevated shadow-pop",
              hero ? "inset-x-0" : "inset-x-8",
            )}
          >
            <div className="flex h-8 items-center gap-1.5 border-b border-line px-3 text-[11.5px] font-medium text-fg-3">
              {suggest.kind === "slash" ? <Slash className="size-3" /> : <AtSign className="size-3" />}
              {suggest.kind === "slash" ? "技能与命令" : `${workspace?.name ?? ""} 中的文件`}
              <span className="ml-auto flex items-center gap-1">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
                选择
                <Kbd className="ml-1">↵</Kbd>
                确认
              </span>
            </div>
            <div role="listbox" aria-label={suggest.kind === "slash" ? "技能与命令" : "文件"} className="scroll-thin max-h-[280px] overflow-y-auto p-1">
              {suggest.kind === "slash"
                ? commands.map((c, i) => {
                    const Icon = GROUP_ICON[c.group];
                    const header = i === 0 || commands[i - 1]!.group !== c.group;
                    return (
                      <div key={`${c.group}-${c.name}`}>
                        {header && (
                          <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-[11px] font-medium text-fg-3">
                            {GROUP_LABEL[c.group]}
                            {c.group === "action" && <span className="font-normal text-fg-4">不会发送消息</span>}
                          </div>
                        )}
                        <button
                          type="button"
                          role="option"
                          aria-selected={i === cursor}
                          onMouseEnter={() => setCursor(i)}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            pick(c);
                          }}
                          className={cn("flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left", i === cursor && "bg-surface-2")}
                        >
                          <Icon className={cn("size-3.5 shrink-0", c.group === "skill" ? "text-accent" : "text-fg-3")} />
                          {c.group === "action" ? (
                            <span className="shrink-0 text-[13px] text-fg">{c.name}</span>
                          ) : (
                            <span className="shrink-0 whitespace-nowrap font-mono text-[12.5px] text-fg">
                              /{c.name}
                              {c.args && <span className="text-fg-4"> {c.args}</span>}
                            </span>
                          )}
                          <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-3">{c.description}</span>
                          {c.source && <span className="shrink-0 rounded px-1.5 py-px text-[10.5px] text-fg-3 ring-1 ring-line">{c.source}</span>}
                          {c.group === "action" && <span className="shrink-0 font-mono text-[11px] text-fg-4">/{c.aliases?.[0]}</span>}
                        </button>
                      </div>
                    );
                  })
                : files.map((f, i) => (
                    <button
                      key={f}
                      type="button"
                      role="option"
                      aria-selected={i === cursor}
                      onMouseEnter={() => setCursor(i)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        insertMention(f);
                      }}
                      className={cn("flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left", i === cursor && "bg-surface-2")}
                    >
                      <FileCode2 className="size-3.5 shrink-0 text-fg-3" />
                      <span className="font-mono text-[12.5px] text-fg">{basename(f)}</span>
                      <span className="truncate font-mono text-[11.5px] text-fg-3">{dirname(f)}</span>
                    </button>
                  ))}
            </div>
            {suggest.kind === "slash" && (
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setSuggest(null);
                  notYet("自定义");
                }}
                className="flex h-8 w-full items-center gap-1.5 border-t border-line px-3 text-left text-[11.5px] text-fg-3 hover:bg-surface-2 hover:text-fg"
              >
                <Sparkles className="size-3" />
                管理技能和命令
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* biome-ignore lint/a11y/noStaticElementInteractions: the drop target wraps the text box, which stays the focusable control */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "relative rounded-[20px] bg-canvas shadow-composer transition-[box-shadow,transform] duration-200",
          focused && "shadow-[0_0_0_1px_var(--accent-line),0_0_0_5px_var(--accent-softer),0_18px_40px_-18px_rgb(0_0_0/0.35)]",
          dragging && "shadow-[0_0_0_1.5px_var(--accent),0_0_0_6px_var(--accent-soft)]",
        )}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[20px] bg-accent-softer text-[13px] font-medium text-accent">
            松开即可添加附件
          </div>
        )}

        <AnimatePresence initial={false}>
          {attachments.length > 0 && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <div className="flex flex-wrap gap-2 px-3.5 pt-3.5">
                {attachments.map((a) => (
                  <div key={a.id} className="group/att relative">
                    <div className="size-14 rounded-xl border border-line" style={{ background: a.preview }} title={a.name} />
                    <button
                      type="button"
                      onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
                      className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border border-line bg-elevated text-fg-2 opacity-0 shadow-sm transition-opacity hover:text-fg group-hover/att:opacity-100"
                      aria-label="移除附件"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {invoked && invoked.group !== "action" && (
          <div className="flex items-center gap-2 px-4 pt-3 text-[12px]">
            {(() => {
              const Icon = GROUP_ICON[invoked.group];
              return (
                <span
                  className={cn(
                    "inline-flex h-6 items-center gap-1.5 rounded-md px-2 font-medium",
                    invoked.group === "skill" ? "bg-accent-soft text-accent" : "bg-surface-2 text-fg-2",
                  )}
                >
                  <Icon className="size-3" />
                  {GROUP_LABEL[invoked.group]} /{invoked.name}
                </span>
              );
            })()}
            <span className="min-w-0 truncate text-fg-3">{invoked.description}</span>
            {invoked.args && <span className="shrink-0 font-mono text-[11.5px] text-fg-4">参数 {invoked.args}</span>}
          </div>
        )}
        <textarea
          ref={input}
          value={text}
          rows={1}
          placeholder={placeholder}
          aria-label="消息"
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setSuggest(null);
          }}
          onChange={(e) => {
            setText(e.target.value);
            refreshSuggest(e.target.value, e.target.selectionStart);
          }}
          onSelect={(e) => refreshSuggest(e.currentTarget.value, e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className={cn(
            "scroll-thin block w-full resize-none bg-transparent px-4 text-fg outline-none placeholder:text-fg-3",
            hero ? "min-h-[92px] pt-4 text-[15.5px] leading-[1.6]" : "min-h-[52px] pt-3.5 text-[14.5px] leading-[1.6]",
          )}
        />
        <input
          ref={imagePicker}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          aria-label="选择图片"
          onChange={(e) => {
            if (e.target.files) takeFiles(e.target.files);
            e.target.value = "";
          }}
        />

        <div className="flex items-center gap-0.5 px-2 pb-2 pt-1">
          <Menu>
            <Tooltip content="添加附件" side="top">
              <MenuTrigger asChild>
                <button
                  type="button"
                  aria-label="添加附件"
                  className="no-drag inline-flex size-7 items-center justify-center rounded-lg text-fg-3 transition-colors hover:bg-surface-2 hover:text-fg data-[state=open]:bg-surface-2"
                >
                  <Paperclip className="size-[15px]" />
                </button>
              </MenuTrigger>
            </Tooltip>
            <MenuContent side="top" className="w-[220px]">
              <MenuItem icon={<ImagePlus />} onSelect={() => imagePicker.current?.click()}>
                上传图片
              </MenuItem>
              {desktop.platform === "darwin" && (
                <MenuItem icon={<Camera />} onSelect={() => void captureScreen()}>
                  截取屏幕
                </MenuItem>
              )}
              <MenuItem
                icon={<AtSign />}
                onSelect={() => {
                  const next = `${text}${text && !text.endsWith(" ") ? " " : ""}@`;
                  setText(next);
                  requestAnimationFrame(() => {
                    input.current?.focus();
                    input.current?.setSelectionRange(next.length, next.length);
                    refreshSuggest(next, next.length);
                  });
                }}
              >
                引用文件
              </MenuItem>
            </MenuContent>
          </Menu>
          <ModePicker mode={settings.mode} onChange={(mode) => void setMode(mode)} />
          <ModelPicker
            model={settings.model}
            onChange={(model) => void setModel(model)}
            open={picker === "model"}
            onOpenChange={(v) => setPicker(v ? "model" : null)}
          />
          <EffortPicker
            effort={settings.effort}
            onChange={(effort) => void setEffort(effort)}
            open={picker === "effort"}
            onOpenChange={(v) => setPicker(v ? "effort" : null)}
          />

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
            <Tooltip content="发送" keys={sendWith === "enter" ? ["↵"] : [MOD, "↵"]} side="top">
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
