import {
  Ban,
  Bot,
  Check,
  ChevronRight,
  CircleSlash,
  FilePen,
  FilePlus2,
  FileText,
  Globe,
  ListChecks,
  Plug,
  Search,
  SquareTerminal,
  TextSearch,
  Wrench,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { basename, dirname, duration, tokens } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import type { ToolCall, ToolName } from "../../agent/viewModel";
import { cn, Spinner } from "../../design/primitives";
import { DiffStat, DiffView } from "./DiffView";
import { CopyButton, Markdown } from "./Markdown";

const ICONS: Record<ToolName, typeof FileText> = {
  Read: FileText,
  Write: FilePlus2,
  Edit: FilePen,
  Bash: SquareTerminal,
  Grep: TextSearch,
  Glob: Search,
  WebFetch: Globe,
  WebSearch: Globe,
  Task: Bot,
  TodoWrite: ListChecks,
  mcp: Plug,
  other: Wrench,
};

const VERBS: Record<ToolName, [running: string, done: string]> = {
  Read: ["正在读取", "读取"],
  Write: ["正在创建", "创建"],
  Edit: ["正在编辑", "编辑"],
  Bash: ["正在运行", "运行"],
  Grep: ["正在搜索", "搜索"],
  Glob: ["正在查找", "查找"],
  WebFetch: ["正在抓取", "抓取"],
  WebSearch: ["正在搜索网页", "搜索网页"],
  Task: ["子 Agent 工作中", "子 Agent"],
  TodoWrite: ["正在更新", "更新"],
  mcp: ["正在调用", "调用"],
  other: ["正在调用", "调用"],
};

export const isExploreTool = (name: ToolName): boolean => ["Read", "Grep", "Glob", "WebFetch", "WebSearch"].includes(name);

function Elapsed({ tool }: { tool: ToolCall }) {
  const running = tool.status === "running";
  const now = useNow(running, 100);
  const ms = running ? now - tool.startedAt : (tool.durationMs ?? 0);
  if (!running && ms < 1000) return null;
  return <span className="tabular text-[11.5px] text-fg-3">{duration(ms)}</span>;
}

export function StatusMark({ status }: { status: ToolCall["status"] }) {
  switch (status) {
    case "running":
      return <Spinner className="size-3.5 text-accent" />;
    case "success":
      return <Check className="size-3.5 text-success" strokeWidth={2.5} />;
    case "error":
      return <X className="size-3.5 text-danger" strokeWidth={2.5} />;
    case "denied":
      return (
        <span className="flex items-center gap-1 text-[11.5px] text-danger">
          <Ban className="size-3.5" />
          已拒绝
        </span>
      );
    case "interrupted":
      return (
        <span className="flex items-center gap-1 text-[11.5px] text-warning">
          <CircleSlash className="size-3.5" />
          已中断
        </span>
      );
  }
}

function Path({ path, className }: { path: string; className?: string }) {
  const dir = dirname(path);
  return (
    <span className={cn("min-w-0 truncate font-mono text-[12.5px]", className)}>
      {dir && <span className="text-fg-3">{dir}/</span>}
      <span className="text-fg">{basename(path)}</span>
    </span>
  );
}

function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ------------------------------------------------------------------ */
/* Compact rows: reads, searches, fetches                              */
/* ------------------------------------------------------------------ */

export function ToolRow({ tool, nested }: { tool: ToolCall; nested?: boolean }) {
  const [open, setOpen] = useState(false);
  const Icon = ICONS[tool.name];
  const verb = VERBS[tool.name][tool.status === "running" ? 0 : 1];
  const expandable = !!tool.output;
  const isPath = tool.name === "Read";

  return (
    <div>
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "group/row flex h-7 w-full min-w-0 items-center gap-2 rounded-lg text-left text-[13px] transition-colors",
          nested ? "px-2" : "-mx-2 w-[calc(100%+16px)] px-2",
          expandable && "hover:bg-surface-2/70",
        )}
      >
        <Icon className="size-[14px] shrink-0 text-fg-3" />
        <span className={cn("shrink-0", tool.status === "running" ? "text-shimmer font-medium" : "text-fg-2")}>{verb}</span>
        {tool.label && <span className="shrink-0 font-mono text-[12.5px] text-fg-2">{tool.server ? `${tool.server} · ${tool.label}` : tool.label}</span>}
        {isPath ? <Path path={tool.target} /> : <span className="min-w-0 truncate font-mono text-[12.5px] text-fg">{tool.target}</span>}
        {tool.summary && <span className="shrink-0 text-[12px] text-fg-3">{tool.summary}</span>}
        <span className="flex-1" />
        <Elapsed tool={tool} />
        {tool.status !== "success" && <StatusMark status={tool.status} />}
        {expandable && <ChevronRight className={cn("size-3.5 shrink-0 text-fg-4 transition-transform group-hover/row:text-fg-3", open && "rotate-90")} />}
      </button>
      <Collapse open={open}>
        <pre className="scroll-thin my-1 ml-[22px] max-h-56 overflow-auto rounded-lg border border-line bg-surface px-3 py-2 font-mono text-[11.5px] leading-[1.7] text-fg-2">
          {tool.output}
        </pre>
      </Collapse>
    </div>
  );
}

export function ExploreGroup({ tools }: { tools: ToolCall[] }) {
  const running = tools.some((t) => t.status === "running");
  const [open, setOpen] = useState(false);
  const files = tools.filter((t) => t.name === "Read").length;
  const searches = tools.filter((t) => t.name === "Grep" || t.name === "Glob").length;
  const web = tools.filter((t) => t.name === "WebFetch" || t.name === "WebSearch").length;
  const parts = [files && `${files} 个文件`, searches && `${searches} 次搜索`, web && `${web} 个网页`].filter(Boolean).join("，");
  const expanded = open || running;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group/row -mx-2 flex h-7 w-[calc(100%+16px)] items-center gap-2 rounded-lg px-2 text-left text-[13px] transition-colors hover:bg-surface-2/70"
      >
        <Search className="size-[14px] text-fg-3" />
        <span className={running ? "text-shimmer font-medium" : "text-fg-2"}>{running ? "正在探索代码" : "已探索"}</span>
        <span className="text-fg-3">{parts}</span>
        <span className="flex-1" />
        <ChevronRight className={cn("size-3.5 text-fg-4 transition-transform group-hover/row:text-fg-3", expanded && "rotate-90")} />
      </button>
      <Collapse open={expanded}>
        <div className="ml-[7px] mt-0.5 border-l border-line pl-2.5">
          {tools.map((t) => (
            <ToolRow key={t.id} tool={t} nested />
          ))}
        </div>
      </Collapse>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Cards: edits, commands, sub-agents                                  */
/* ------------------------------------------------------------------ */

function CardShell({ header, children, className }: { header: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-xl border border-line bg-surface", className)}>
      {header}
      {children}
    </div>
  );
}

export function EditCard({ tool }: { tool: ToolCall }) {
  const lines = tool.diff ?? [];
  const [open, setOpen] = useState(true);
  const Icon = ICONS[tool.name];
  const verb = tool.name === "Write" ? "新建" : "编辑";
  return (
    <CardShell
      header={
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex h-9 w-full items-center gap-2 px-3 text-left transition-colors hover:bg-surface-2/50",
            open && lines.length > 0 && "border-b border-line",
          )}
        >
          <Icon className="size-[14px] shrink-0 text-fg-3" />
          <span className={cn("shrink-0 text-[13px]", tool.status === "running" ? "text-shimmer font-medium" : "text-fg-2")}>{verb}</span>
          <Path path={tool.target} />
          <DiffStat added={tool.added} removed={tool.removed} className="ml-1" />
          <span className="flex-1" />
          <StatusMark status={tool.status} />
          <ChevronRight className={cn("size-3.5 text-fg-4 transition-transform", open && "rotate-90")} />
        </button>
      }
    >
      {lines.length > 0 && (
        <Collapse open={open}>
          <DiffView lines={lines} className="py-1.5" />
        </Collapse>
      )}
    </CardShell>
  );
}

function colorLine(line: string): string {
  if (/^\s*✓|passed|^\s*ok\b/.test(line)) return "text-success";
  if (/^\s*✗|failed(?! ·)|error|Error/.test(line) && !/0 failed/.test(line)) return "text-danger";
  if (/^>/.test(line)) return "text-fg-3";
  if (/^\S+$/.test(line) && line.length < 14) return "text-fg font-medium";
  return "text-fg-2";
}

export function BashCard({ tool }: { tool: ToolCall }) {
  const ref = useRef<HTMLDivElement>(null);
  const running = tool.status === "running";
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (running && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [tool.output, running]);

  return (
    <CardShell
      header={
        <div className={cn("group/bash flex h-9 items-center gap-2 pl-3 pr-1.5", open && tool.output && "border-b border-line")}>
          <button type="button" onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
            <SquareTerminal className="size-[14px] shrink-0 text-fg-3" />
            <span className="shrink-0 font-mono text-[12.5px] text-fg-3">$</span>
            <span className="min-w-0 truncate font-mono text-[12.5px] text-fg">{tool.target}</span>
          </button>
          <Elapsed tool={tool} />
          {tool.summary && tool.status === "success" && <span className="text-[11.5px] text-fg-3">{tool.summary}</span>}
          <StatusMark status={tool.status} />
          <CopyButton text={tool.target} label="复制命令" className="opacity-0 group-hover/bash:opacity-100" />
        </div>
      }
    >
      {tool.output !== undefined && tool.output.length > 0 && (
        <Collapse open={open}>
          <div ref={ref} className="scroll-thin max-h-64 overflow-auto px-3.5 py-2.5 font-mono text-[11.75px] leading-[1.75]">
            {tool.output.split("\n").map((line, i) => (
              <div key={i} className={cn("whitespace-pre", colorLine(line))}>
                {line || " "}
              </div>
            ))}
            {running && <span className="stream-caret inline-block" />}
          </div>
        </Collapse>
      )}
    </CardShell>
  );
}

export function TaskCard({ tool }: { tool: ToolCall }) {
  const agent = tool.agent;
  const running = tool.status === "running";
  const [open, setOpen] = useState(true);
  if (!agent) return null;
  const done = agent.steps.filter((s) => s.done).length;

  return (
    <CardShell
      header={
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface-2/50"
        >
          <span className="relative flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <Bot className="size-4" />
            {running && <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-accent ring-2 ring-surface animate-pulse" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-fg-3">
              子 Agent
              <span className="rounded bg-surface-3 px-1 py-px font-mono text-[10.5px] text-fg-2">{agent.type}</span>
              {agent.tokens && tool.status === "success" && <span className="tabular">· {tokens(agent.tokens)} tokens</span>}
            </span>
            <span className={cn("block truncate text-[13px]", running ? "text-shimmer font-medium" : "text-fg")}>{tool.target}</span>
          </span>
          {(tool.status === "running" || tool.status === "success") && agent.steps.length > 0 ? (
            <span className="tabular text-[11.5px] text-fg-3">
              {done}/{agent.steps.length}
            </span>
          ) : tool.status === "running" || tool.status === "success" ? (
            // The Agent reports a count of tool calls rather than a step list.
            agent.toolUses !== undefined && (
              <span className="tabular text-[11.5px] text-fg-3">
                {agent.toolUses} 次工具调用{running && agent.lastTool ? ` · ${agent.lastTool}` : ""}
              </span>
            )
          ) : (
            <StatusMark status={tool.status} />
          )}
          <Elapsed tool={tool} />
          <ChevronRight className={cn("size-3.5 text-fg-4 transition-transform", open && "rotate-90")} />
        </button>
      }
    >
      <Collapse open={open}>
        <div className="border-t border-line px-3 pb-3 pt-2.5">
          <ol className="flex flex-col gap-1.5 pl-1">
            {agent.steps.map((step, i) => {
              const active = running && !step.done && agent.steps.slice(0, i).every((s) => s.done);
              return (
                <li key={step.label} className="flex items-center gap-2.5 text-[12.5px]">
                  <span
                    className={cn(
                      "flex size-4 items-center justify-center rounded-full border",
                      step.done ? "border-transparent bg-success/15 text-success" : active ? "border-accent-line" : "border-line-strong",
                    )}
                  >
                    {step.done ? (
                      <Check className="size-2.5" strokeWidth={3} />
                    ) : active ? (
                      <span className="size-1.5 animate-pulse rounded-full bg-accent" />
                    ) : null}
                  </span>
                  <span className={cn(step.done ? "text-fg-2" : active ? "text-fg" : "text-fg-3")}>{step.label}</span>
                </li>
              );
            })}
          </ol>
          {agent.result && tool.status === "success" && (
            <div className="mt-3 rounded-lg border border-line bg-canvas px-3 py-2.5">
              <div className="mb-1 text-[11px] font-medium text-fg-3">结论</div>
              <Markdown text={agent.result} className="text-[13px] [--chat-size:13px] [--chat-leading:1.65]" />
            </div>
          )}
        </div>
      </Collapse>
    </CardShell>
  );
}

export function ToolBlock({ tool }: { tool: ToolCall }) {
  if (tool.name === "Edit" || tool.name === "Write") return <EditCard tool={tool} />;
  if (tool.name === "Bash") return <BashCard tool={tool} />;
  if (tool.name === "Task") return <TaskCard tool={tool} />;
  return <ToolRow tool={tool} />;
}
