import { Bot, Check, ChevronRight, Circle, FileMinus2, FilePen, FilePlus2, Layers, Plug, Square, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useMemo, useState } from "react";
import { changesOf } from "../../agent/projector/derive";
import type { SessionView } from "../../agent/projector/session";
import type { FileChange } from "../../agent/viewModel";
import { ContextRing } from "../../design/ContextRing";
import { Button, cn, IconButton, Spinner, Tooltip } from "../../design/primitives";
import { basename, dirname, relativeTime, tokens } from "../../lib/format";
import { runCommand, stopBackgroundAgent } from "../../state/actions";
import { useActiveView } from "../../state/sessions";
import { type RightTab, useUi } from "../../state/ui";
import { DiffStat, DiffView } from "../session/DiffView";

const TABS: { id: RightTab; label: string }[] = [
  { id: "changes", label: "改动" },
  { id: "tasks", label: "任务" },
  { id: "context", label: "上下文" },
  { id: "agents", label: "后台" },
];

function Empty({ icon, title, hint }: { icon: ReactNode; title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-8 py-16 text-center">
      <span className="mb-3 flex size-10 items-center justify-center rounded-xl border border-line bg-surface text-fg-3 [&_svg]:size-[18px]">{icon}</span>
      <div className="text-[13px] font-medium text-fg-2">{title}</div>
      <div className="mt-1 text-[12px] leading-[1.6] text-fg-3">{hint}</div>
    </div>
  );
}

function ChangeRow({ change }: { change: FileChange }) {
  const [open, setOpen] = useState(false);
  const Icon = change.kind === "added" ? FilePlus2 : change.kind === "deleted" ? FileMinus2 : FilePen;
  return (
    <div className="border-b border-line last:border-b-0">
      <button type="button" onClick={() => setOpen((v) => !v)} className="group flex h-10 w-full items-center gap-2 px-3 text-left hover:bg-surface-2/50">
        <ChevronRight className={cn("size-3.5 shrink-0 text-fg-4 transition-transform", open && "rotate-90")} />
        <Icon className={cn("size-3.5 shrink-0", change.kind === "added" ? "text-success" : change.kind === "deleted" ? "text-danger" : "text-fg-3")} />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-mono text-[12.5px] text-fg">{basename(change.path)}</span>
          <span className="ml-1.5 font-mono text-[11px] text-fg-3">{dirname(change.path)}</span>
        </span>
        <DiffStat added={change.added} removed={change.removed} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="border-t border-line bg-surface">
              <DiffView lines={change.diff} collapseAfter={18} className="py-1 text-[11.5px]" />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ChangesTab({ changes }: { changes: FileChange[] }) {
  if (changes.length === 0) {
    return <Empty icon={<FilePen />} title="还没有文件改动" hint="Agent 编辑或创建文件后，改动会汇总在这里。命令行里改的文件不会出现在这里。" />;
  }
  const added = changes.reduce((n, c) => n + c.added, 0);
  const removed = changes.reduce((n, c) => n + c.removed, 0);
  return (
    <div className="p-3">
      <div className="mb-2.5 flex items-center justify-between px-0.5">
        <div className="text-[12.5px] text-fg-2">
          <span className="font-medium text-fg">{changes.length}</span> 个文件
          <DiffStat added={added} removed={removed} className="ml-2" />
        </div>
        {/* TODO(G9): reverting every change needs `session/rewind`. */}
        <Tooltip content="全部回退需要 Agent 提供 session/rewind（G9）">
          <span className="text-[11.5px] text-fg-4">全部回退</span>
        </Tooltip>
      </div>
      <div className="overflow-hidden rounded-xl border border-line bg-canvas">
        {changes.map((c) => (
          <ChangeRow key={c.path} change={c} />
        ))}
      </div>
    </div>
  );
}

interface TaskRow {
  id: string;
  label: string;
  status: "pending" | "in_progress" | "completed";
}

function TasksTab({ view }: { view: SessionView }) {
  const rows: TaskRow[] =
    view.taskMode === "task"
      ? view.tasks.map((t) => ({ id: t.id, label: t.status === "in_progress" ? (t.activeForm ?? t.subject) : t.subject, status: t.status }))
      : view.todos.map((t, i) => ({ id: String(i), label: t.status === "in_progress" ? t.activeForm : t.content, status: t.status }));
  if (rows.length === 0) {
    return <Empty icon={<Check />} title="没有任务清单" hint="复杂的任务开始前，Agent 会先列出步骤，执行时在这里实时更新进度。" />;
  }
  const done = rows.filter((t) => t.status === "completed").length;
  return (
    <div className="p-3">
      <div className="mb-3 px-0.5">
        <div className="mb-1.5 flex items-center justify-between text-[12.5px]">
          <span className="text-fg-2">
            已完成 <span className="font-medium text-fg">{done}</span> / {rows.length}
          </span>
          <span className="tabular text-fg-3">{Math.round((done / rows.length) * 100)}%</span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-surface-3">
          <motion.div
            className="h-full rounded-full bg-accent"
            animate={{ width: `${(done / rows.length) * 100}%` }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          />
        </div>
      </div>
      <ol className="flex flex-col gap-0.5">
        {rows.map((t) => (
          <li key={t.id} className={cn("flex items-start gap-2.5 rounded-lg px-2 py-2", t.status === "in_progress" && "bg-accent-softer")}>
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
              {t.status === "completed" ? (
                <span className="flex size-4 items-center justify-center rounded-full bg-success/15 text-success">
                  <Check className="size-2.5" strokeWidth={3} />
                </span>
              ) : t.status === "in_progress" ? (
                <Spinner className="size-3.5 text-accent" />
              ) : (
                <Circle className="size-3.5 text-fg-4" />
              )}
            </span>
            <span
              className={cn(
                "text-[13px] leading-[1.5]",
                t.status === "completed" ? "text-fg-3 line-through decoration-fg-4" : t.status === "in_progress" ? "font-medium text-fg" : "text-fg-2",
              )}
            >
              {t.label}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ContextTab({ view }: { view: SessionView }) {
  const usage = view.usage;
  const context = usage?.context;
  const total = usage?.total;
  const input = (total?.input_tokens ?? 0) + (total?.cache_read_input_tokens ?? 0) + (total?.cache_creation_input_tokens ?? 0);
  const hit = input > 0 ? (total?.cache_read_input_tokens ?? 0) / input : 0;
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="rounded-xl border border-line bg-canvas p-4">
        <div className="flex items-center gap-4">
          <div className="relative">
            <ContextRing used={context?.tokens ?? 0} total={context?.window ?? 1} size={60} stroke={6} />
            <span className="tabular absolute inset-0 flex items-center justify-center text-[12.5px] font-semibold text-fg">
              {context ? `${context.percent}%` : "–"}
            </span>
          </div>
          <div className="min-w-0">
            <div className="tabular text-[20px] font-semibold tracking-[-0.02em] text-fg">
              {context ? tokens(context.tokens) : "–"}
              {context && <span className="ml-1 text-[13px] font-normal text-fg-3">/ {tokens(context.window)}</span>}
            </div>
            <div className="text-[12px] text-fg-3">{context ? "最近一次请求占用的上下文" : "发出第一条消息后显示"}</div>
          </div>
        </div>
      </div>

      {/* TODO(G5): the per-category breakdown needs `session/context`. */}
      <div className="rounded-xl border border-dashed border-line px-4 py-4 text-center text-[12px] leading-[1.6] text-fg-3">
        按类别拆分（系统提示词、工具、MCP、技能、规则、对话）需要 Agent 提供 session/context（G5）。
      </div>

      <div className="grid grid-cols-2 gap-2">
        {[
          { label: "缓存命中率", value: `${Math.round(hit * 100)}%` },
          { label: "本会话输入", value: tokens(input) },
          { label: "本会话输出", value: tokens(total?.output_tokens ?? 0) },
          { label: "最近一轮输出", value: tokens(usage?.turn?.output_tokens ?? 0) },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border border-line bg-canvas px-3 py-2.5">
            <div className="text-[11.5px] text-fg-3">{s.label}</div>
            <div className="tabular mt-0.5 text-[15px] font-semibold tracking-[-0.01em] text-fg">{s.value}</div>
          </div>
        ))}
      </div>

      <Button variant="secondary" size="sm" disabled={!context || view.busy} onClick={() => void runCommand("compact")}>
        <Layers />
        压缩对话消息
      </Button>
    </div>
  );
}

function AgentsTab({ view }: { view: SessionView }) {
  return (
    <div className="flex flex-col gap-4 p-3">
      <section>
        <h4 className="mb-1.5 px-0.5 text-[11.5px] font-medium text-fg-3">后台 Agent</h4>
        {view.backgroundAgents.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line px-4 py-5 text-center text-[12px] leading-[1.6] text-fg-3">
            让 Agent 在后台跑长任务时，进度会显示在这里，完成后自动唤醒会话。
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-line bg-canvas">
            {view.backgroundAgents.map((a) => (
              <div key={a.agentId} className="group flex items-center gap-3 border-b border-line px-3 py-2.5 last:border-b-0">
                <span className="flex size-7 items-center justify-center rounded-lg bg-accent-soft text-accent">
                  <Bot className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] text-fg">{a.description || a.prompt.slice(0, 60)}</span>
                  <span className="block text-[11px] text-fg-3">
                    {a.teammateName ?? a.agentType} · {a.toolUseCount} 次工具调用 · {relativeTime(Date.parse(a.startedAt))}
                  </span>
                </span>
                {a.status === "running" ? (
                  <>
                    <Spinner className="text-accent group-hover:hidden" />
                    <Tooltip content="停止">
                      <IconButton size="sm" className="hidden group-hover:flex" aria-label="停止" onClick={() => void stopBackgroundAgent(view.id, a.agentId)}>
                        <Square className="!size-3 fill-current" />
                      </IconButton>
                    </Tooltip>
                  </>
                ) : a.status === "completed" ? (
                  <Check className="size-3.5 text-success" />
                ) : (
                  <X className="size-3.5 text-danger" />
                )}
              </div>
            ))}
          </div>
        )}
      </section>
      <section>
        <h4 className="mb-1.5 px-0.5 text-[11.5px] font-medium text-fg-3">MCP 服务器</h4>
        {/* TODO(G4): server status comes with `runtime/inventory`. */}
        <div className="flex items-center gap-2.5 rounded-xl border border-dashed border-line px-3 py-3 text-[12px] text-fg-3">
          <Plug className="size-3.5 shrink-0" />
          连接状态需要 Agent 提供 runtime/inventory（G4）。
        </div>
      </section>
    </div>
  );
}

export function RightPanel() {
  const view = useActiveView();
  const tab = useUi((s) => s.rightTab);
  const setRightPanel = useUi((s) => s.setRightPanel);
  const changes = useMemo(() => (view ? changesOf(view) : []), [view]);
  if (!view) return null;

  const rows = view.taskMode === "task" ? view.tasks : view.todos;
  const badge: Partial<Record<RightTab, number>> = {
    changes: changes.length,
    tasks: rows.filter((t) => t.status !== "completed").length,
    agents: view.backgroundAgents.filter((a) => a.status === "running").length,
  };

  return (
    <aside aria-label="详情面板" className="flex h-full w-[360px] shrink-0 flex-col border-l border-line bg-surface/40">
      <div className="drag flex h-[52px] shrink-0 items-center gap-1 border-b border-line px-2.5">
        <div role="tablist" className="no-drag flex flex-1 items-center gap-0.5 rounded-[10px] bg-surface-2/70 p-[3px]">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setRightPanel(true, t.id)}
              className={cn(
                "relative flex h-[26px] flex-1 items-center justify-center gap-1.5 rounded-[7px] text-[12.5px] font-medium transition-colors",
                tab === t.id ? "text-fg" : "text-fg-3 hover:text-fg-2",
              )}
            >
              {tab === t.id && (
                <motion.span
                  layoutId="right-tab"
                  className="absolute inset-0 rounded-[7px] bg-canvas shadow-[0_1px_2px_rgb(0_0_0/0.12),0_0_0_1px_var(--line)]"
                  transition={{ type: "spring", bounce: 0.15, duration: 0.35 }}
                />
              )}
              <span className="relative">{t.label}</span>
              {!!badge[t.id] && <span className="tabular relative rounded-full bg-accent-soft px-1.5 text-[10.5px] text-accent">{badge[t.id]}</span>}
            </button>
          ))}
        </div>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={tab} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
            {tab === "changes" && <ChangesTab changes={changes} />}
            {tab === "tasks" && <TasksTab view={view} />}
            {tab === "context" && <ContextTab view={view} />}
            {tab === "agents" && <AgentsTab view={view} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </aside>
  );
}
