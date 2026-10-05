import { ArrowDown } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Fragment, useLayoutEffect, useMemo, useRef, useState } from "react";
import { blocksOf, type SessionView } from "../../agent/projector/session";
import type { Block, ToolCall } from "../../agent/viewModel";
import { cn, Spinner } from "../../design/primitives";
import { AssistantMessage, NoticeBlock, ThinkingBlock, UserMessage } from "./Messages";
import { RequestBlock } from "./RequestCards";
import { ExploreGroup, isExploreTool, ToolBlock } from "./ToolCards";

type Item = { key: string; kind: "block"; block: Block } | { key: string; kind: "explore"; tools: ToolCall[] };

function toItems(blocks: Block[]): Item[] {
  const items: Item[] = [];
  let run: ToolCall[] = [];
  const flush = () => {
    if (run.length === 0) return;
    if (run.length === 1) items.push({ key: run[0]!.id, kind: "block", block: { kind: "tool", id: run[0]!.id, tool: run[0]! } });
    else items.push({ key: `g_${run[0]!.id}`, kind: "explore", tools: run });
    run = [];
  };
  for (const b of blocks) {
    if (b.kind === "tool" && isExploreTool(b.tool.name)) {
      run.push(b.tool);
      continue;
    }
    flush();
    items.push({ key: b.id, kind: "block", block: b });
  }
  flush();
  return items;
}

function spacing(item: Item, prev: Item | undefined): string {
  if (!prev) return "";
  const kind = item.kind === "block" ? item.block.kind : "tool";
  const prevKind = prev.kind === "block" ? prev.block.kind : "tool";
  if (kind === "user") return "mt-10";
  // The user bubble already ends with its hover action row.
  if (prevKind === "user") return "mt-1";
  const compact = (k: string, it: Item) =>
    k === "thinking" ||
    it.kind === "explore" ||
    (it.kind === "block" && it.block.kind === "tool" && (isExploreTool(it.block.tool.name) || it.block.tool.name === "TodoWrite"));
  if (compact(kind, item) && compact(prevKind, prev)) return "mt-1";
  if (kind === "assistant" || prevKind === "assistant") return "mt-4";
  return "mt-3";
}

function Working({ busy, blocks }: { busy: boolean; blocks: Block[] }) {
  const last = blocks[blocks.length - 1];
  const show =
    busy &&
    !(
      last &&
      ((last.kind === "request" && !last.resolution) ||
        (last.kind === "assistant" && last.streaming) ||
        (last.kind === "thinking" && last.streaming) ||
        (last.kind === "tool" && last.tool.status === "running"))
    );
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, delay: 0.15 }}
          className="mt-3 flex h-7 items-center gap-2 text-[13px]"
        >
          <Spinner className="text-accent" />
          <span className="text-shimmer font-medium">正在处理</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Conversation({ view, workspaceName, startedAt }: { view: SessionView; workspaceName: string; startedAt?: number }) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const blocks = useMemo(() => blocksOf(view), [view]);
  const items = useMemo(() => toItems(blocks), [blocks]);

  // Only the newest open request takes keyboard shortcuts.
  const latestRequest = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]!;
      if (b.kind === "request" && !b.resolution) return b.id;
    }
    return null;
  }, [blocks]);

  const lastAssistant = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i]!.kind === "assistant") return blocks[i]!.id;
    return null;
  }, [blocks]);

  // Jump to the bottom when the session changes.
  useLayoutEffect(() => {
    stick.current = true;
    setAway(false);
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [view.id]);

  // Follow new content while pinned to the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [blocks]);

  const started = new Date(startedAt ?? Date.now());

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
          stick.current = distance < 64;
          setAway(distance > 240);
        }}
        className="scroll-thin h-full overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-[796px] px-8 pb-10 pt-8">
          <div className="mb-8 flex items-center justify-center gap-2 text-[11.5px] text-fg-3">
            <span>
              {started.getMonth() + 1}月{started.getDate()}日 {String(started.getHours()).padStart(2, "0")}:{String(started.getMinutes()).padStart(2, "0")}
            </span>
            <span className="size-[3px] rounded-full bg-fg-4" />
            <span>{workspaceName}</span>
            <span className="size-[3px] rounded-full bg-fg-4" />
            <span>{view.model}</span>
          </div>

          {items.map((item, i) => (
            <Fragment key={item.key}>
              <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
                className={cn(spacing(item, items[i - 1]))}
              >
                {item.kind === "explore" ? (
                  <ExploreGroup tools={item.tools} />
                ) : item.block.kind === "user" ? (
                  <UserMessage block={item.block} />
                ) : item.block.kind === "assistant" ? (
                  <AssistantMessage block={item.block} last={item.block.id === lastAssistant} />
                ) : item.block.kind === "thinking" ? (
                  <ThinkingBlock block={item.block} />
                ) : item.block.kind === "tool" ? (
                  <ToolBlock tool={item.block.tool} />
                ) : item.block.kind === "request" ? (
                  <RequestBlock block={item.block} sessionId={view.id} cwd={view.cwd} latest={item.block.id === latestRequest} />
                ) : (
                  <NoticeBlock block={item.block} />
                )}
              </motion.div>
            </Fragment>
          ))}
          <Working busy={view.busy} blocks={blocks} />
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
        <AnimatePresence>
          {away && (
            <motion.button
              type="button"
              initial={{ opacity: 0, y: 8, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.96 }}
              onClick={() => {
                const el = scroller.current;
                el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
              }}
              className="pointer-events-auto flex h-8 items-center gap-1.5 rounded-full border border-line bg-elevated px-3 text-[12px] font-medium text-fg-2 shadow-pop transition-colors hover:text-fg"
            >
              <ArrowDown className="size-3.5" />
              回到最新
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
