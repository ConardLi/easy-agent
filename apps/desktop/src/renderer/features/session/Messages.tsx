import {
  ChevronRight,
  CircleAlert,
  CircleSlash,
  Eraser,
  FileCode2,
  FileImage,
  FileText,
  GitFork,
  Layers,
  Lightbulb,
  Repeat2,
  RotateCcw,
  SquareTerminal,
  ToggleRight,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import type { Block } from "../../agent/viewModel";
import { cn, IconButton, Menu, MenuContent, MenuItem, MenuTrigger, Tooltip } from "../../design/primitives";
import { duration, shortTime } from "../../lib/format";
import { CopyButton, Markdown } from "./Markdown";

type Of<K extends Block["kind"]> = Extract<Block, { kind: K }>;

/** TODO(G9): message-level fork and rewind need `session/rewind` and `session/fork` with `fromMessage`. */
const REWIND_PENDING = "需要 Agent 提供消息级回退（G9）";

export function UserMessage({ block }: { block: Of<"user"> }) {
  const [menu, setMenu] = useState(false);

  return (
    <div className="group/user flex flex-col items-end">
      {block.attachments && block.attachments.length > 0 && (
        <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
          {block.attachments.map((a) =>
            a.kind === "image" ? (
              <div key={a.id} className="h-20 w-28 overflow-hidden rounded-xl border border-line" style={{ background: a.preview }} title={a.name} />
            ) : (
              <span key={a.id} className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[12px] text-fg-2">
                <FileText className="size-3.5 text-fg-3" />
                {a.name}
              </span>
            ),
          )}
        </div>
      )}
      {block.text && (
        <div className="max-w-[82%] whitespace-pre-wrap rounded-[18px] rounded-br-[6px] bg-surface-2 px-4 py-2.5 text-[length:var(--chat-size)] leading-[1.62] text-fg">
          {block.text}
        </div>
      )}
      <div className={cn("mt-1 flex h-7 items-center gap-0.5 opacity-0 transition-opacity group-hover/user:opacity-100", menu && "opacity-100")}>
        {block.at !== undefined && <span className="tabular mr-1 text-[11px] text-fg-3">{shortTime(block.at)}</span>}
        <CopyButton text={block.text} />
        <Menu open={menu} onOpenChange={setMenu}>
          <Tooltip content="回退">
            <MenuTrigger asChild>
              <IconButton size="sm" aria-label="回退" active={menu}>
                <RotateCcw />
              </IconButton>
            </MenuTrigger>
          </Tooltip>
          <MenuContent align="end" className="w-[264px]">
            <MenuItem icon={<GitFork />} className="h-auto items-start py-2" disabled>
              <span className="block font-medium">从这里分叉</span>
              <span className="block whitespace-normal text-[12px] text-fg-3">{REWIND_PENDING}</span>
            </MenuItem>
            <MenuItem icon={<FileCode2 />} className="h-auto items-start py-2" disabled>
              <span className="block font-medium">只回退代码</span>
              <span className="block whitespace-normal text-[12px] text-fg-3">{REWIND_PENDING}</span>
            </MenuItem>
            <MenuItem icon={<RotateCcw />} className="h-auto items-start py-2" disabled>
              <span className="block font-medium">回退对话和代码</span>
              <span className="block whitespace-normal text-[12px] text-fg-3">{REWIND_PENDING}</span>
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </div>
  );
}

export function AssistantMessage({ block, last }: { block: Of<"assistant">; last: boolean }) {
  return (
    <div className="group/msg">
      <Markdown text={block.text} streaming={block.streaming} />
      {last && !block.streaming && block.text.length > 120 && (
        <div className="mt-1.5 flex h-7 items-center gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100">
          <CopyButton text={block.text} />
          <Tooltip content={`重新生成：${REWIND_PENDING}`}>
            <span>
              <IconButton size="sm" aria-label="重新生成" disabled>
                <Repeat2 />
              </IconButton>
            </span>
          </Tooltip>
        </div>
      )}
    </div>
  );
}

export function ThinkingBlock({ block, showThinking = true }: { block: Of<"thinking">; showThinking?: boolean }) {
  const [open, setOpen] = useState(false);
  const expanded = open || (block.streaming && showThinking);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group/row -mx-2 flex h-7 items-center gap-2 rounded-lg px-2 text-[13px] transition-colors hover:bg-surface-2/70"
      >
        <Lightbulb className={cn("size-[14px]", block.streaming ? "text-accent" : "text-fg-3")} />
        {block.streaming ? (
          <span className="text-shimmer font-medium">思考中</span>
        ) : (
          <span className="text-fg-2">{block.durationMs !== undefined ? `思考了 ${duration(block.durationMs)}` : "思考过程"}</span>
        )}
        <ChevronRight className={cn("size-3.5 text-fg-4 transition-transform group-hover/row:text-fg-3", expanded && "rotate-90")} />
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="ml-[7px] mt-1 border-l border-line pb-1 pl-4">
              <Markdown text={block.text} streaming={block.streaming} className="text-fg-2 [--chat-size:13.5px] [&_*]:!text-fg-2" />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const NOTICE_ICONS = {
  compact: Layers,
  mode: ToggleRight,
  interrupt: CircleSlash,
  clear: Eraser,
  command: SquareTerminal,
  error: CircleAlert,
  model: FileImage,
} as const;

export function NoticeBlock({ block }: { block: Of<"notice"> }) {
  const Icon = NOTICE_ICONS[block.icon];
  if (block.detail && block.icon === "command") {
    return (
      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        <div className="flex h-8 items-center gap-2 border-b border-line px-3 text-[12px] text-fg-2">
          <Icon className="size-3.5 text-fg-3" />
          <span className="font-mono">{block.text}</span>
        </div>
        <pre className="scroll-thin overflow-x-auto px-3.5 py-2.5 font-mono text-[12px] leading-[1.75] text-fg-2">
          {block.detail.split("\n").map((line, i) => (
            <div key={i} className={cn(line.startsWith("✓") && "[&>span]:text-success", line.startsWith("✗") && "text-danger")}>
              {line.startsWith("✓") ? (
                <>
                  <span>✓</span>
                  {line.slice(1)}
                </>
              ) : (
                line
              )}
            </div>
          ))}
        </pre>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 py-0.5 text-[12px]">
      <span className="h-px flex-1 bg-line" />
      <span
        className={cn(
          "flex items-center gap-1.5",
          block.tone === "warning" && "text-warning",
          block.tone === "danger" && "text-danger",
          block.tone === "success" && "text-success",
          block.tone === "info" && "text-fg-3",
        )}
      >
        <Icon className="size-3.5" />
        {block.text}
        {block.detail && <span className="text-fg-3">· {block.detail}</span>}
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}
