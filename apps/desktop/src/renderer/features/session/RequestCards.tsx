import {
  ArrowRight,
  Ban,
  Check,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  CornerDownLeft,
  MessageSquareText,
  ShieldCheck,
  ShieldQuestion,
  ShieldX,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { InteractionResolution, InteractionResponse, PermissionInteraction, PlanApprovalInteraction, QuestionInteraction } from "../../../shared/agent";
import { toolCall } from "../../agent/tools";
import type { Block } from "../../agent/viewModel";
import { Button, cn, Kbd } from "../../design/primitives";
import { interrupt, respond } from "../../state/actions";
import { useSessions } from "../../state/sessions";
import { DiffStat, DiffView } from "./DiffView";
import { Markdown } from "./Markdown";

/** Keyboard shortcuts for the request that is waiting on the user. */
function useRequestKeys(active: boolean, onKey: (key: string, e: KeyboardEvent) => boolean) {
  const handler = useRef(onKey);
  handler.current = onKey;
  useEffect(() => {
    if (!active) return;
    const listener = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT") && (el as HTMLInputElement).value.length > 0;
      if (typing && e.key !== "Escape") return;
      if (el?.closest("[role=dialog]")) return;
      if (handler.current(e.key, e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [active]);
}

function PendingShell({
  icon,
  title,
  subtitle,
  children,
  footer,
}: {
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  footer: ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6, scale: 0.995 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
      className="relative overflow-hidden rounded-2xl border border-accent-line bg-canvas shadow-[0_0_0_4px_var(--accent-softer),0_12px_32px_-16px_color-mix(in_oklab,var(--accent)_45%,transparent)]"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-accent-softer to-transparent" />
      <div className="relative flex items-start gap-3 px-4 pb-3 pt-3.5">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-accent-soft text-accent">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold tracking-[-0.01em] text-fg">{title}</div>
          {subtitle && <div className="mt-0.5 text-[12.5px] text-fg-2">{subtitle}</div>}
        </div>
      </div>
      {children && <div className="relative px-4 pb-3">{children}</div>}
      <div className="relative flex flex-wrap items-center gap-2 border-t border-line bg-surface/60 px-4 py-2.5">{footer}</div>
    </motion.div>
  );
}

function ResolvedRow({
  icon,
  children,
  tone = "default",
  detail,
}: {
  icon: ReactNode;
  children: ReactNode;
  tone?: "default" | "success" | "danger" | "warning";
  detail?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        disabled={!detail}
        onClick={() => setOpen((v) => !v)}
        className="group/row -mx-2 flex h-7 w-[calc(100%+16px)] items-center gap-2 rounded-lg px-2 text-left text-[13px] text-fg-2 transition-colors enabled:hover:bg-surface-2/70"
      >
        <span
          className={cn(
            "flex [&_svg]:size-[14px]",
            tone === "success" && "text-success",
            tone === "danger" && "text-danger",
            tone === "warning" && "text-warning",
            tone === "default" && "text-fg-3",
          )}
        >
          {icon}
        </span>
        {children}
        <span className="flex-1" />
        {detail && <ChevronRight className={cn("size-3.5 text-fg-4 transition-transform", open && "rotate-90")} />}
      </button>
      <AnimatePresence initial={false}>
        {open && detail && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="my-1.5 ml-[22px]">{detail}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** How a resolved request ended, from the response this window sent or the Agent's reason. */
type Outcome = { by: "user"; response: InteractionResponse } | { by: "interrupt" } | { by: "other" };

function outcomeOf(resolution: InteractionResolution, response: InteractionResponse | undefined): Outcome {
  if (response && (resolution === "response" || resolution === "handler")) return { by: "user", response };
  if (resolution === "interrupt" || resolution === "turn_end" || resolution === "closed") return { by: "interrupt" };
  return { by: "other" };
}

/* ------------------------------------------------------------------ */
/* Permission                                                          */
/* ------------------------------------------------------------------ */

const RISK: Record<string, string> = {
  "High risk: destructive shell command detected": "高风险：可能删除或覆盖数据的命令",
  "Low risk: read-only shell command": "低风险：只读命令",
  "Medium risk: shell command may change files or git state": "中等风险：命令可能修改文件或 git 状态",
  "Low risk: read-only tool": "低风险：只读工具",
  "Medium risk: writes files in the workspace": "中等风险：会写入工作区里的文件",
  "Medium risk: operation may change local state": "中等风险：可能改变本地状态",
};

function permissionView(request: PermissionInteraction, cwd: string) {
  const card = toolCall({ id: request.id, name: request.toolName, input: request.input, running: false, cwd });
  const verb =
    card.name === "Bash"
      ? "运行命令"
      : request.toolName === "Write"
        ? "创建文件"
        : card.name === "Edit"
          ? "编辑文件"
          : card.name === "WebFetch"
            ? "访问网页"
            : `使用 ${card.label ?? request.toolName}`;
  const preview =
    card.name === "Bash" && card.target
      ? ({ kind: "command", text: card.target } as const)
      : card.diff && card.diff.length > 0
        ? ({ kind: "diff", lines: card.diff, added: card.added ?? 0, removed: card.removed ?? 0 } as const)
        : undefined;
  return { card, verb, preview, reason: RISK[request.risk] ?? request.risk ?? request.summary };
}

function PermissionPreview({ view }: { view: ReturnType<typeof permissionView> }) {
  const { preview, card } = view;
  if (!preview) return card.target ? <div className="font-mono text-[12.5px] text-fg-2">{card.target}</div> : null;
  if (preview.kind === "command") {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-line bg-surface px-3.5 py-2.5 font-mono text-[12.5px] leading-[1.6]">
        <span className="select-none text-fg-3">$</span>
        <span className="whitespace-pre-wrap break-all text-fg">{preview.text}</span>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex h-8 items-center gap-2 border-b border-line px-3 font-mono text-[12px] text-fg-2">
        {card.target}
        <DiffStat added={preview.added} removed={preview.removed} />
      </div>
      <DiffView lines={preview.lines} collapseAfter={12} className="py-1" />
    </div>
  );
}

function PermissionCard({ sessionId, cwd, request, resolution, latest }: CardProps<PermissionInteraction>) {
  const response = useSessions((s) => s.responses[request.id]);
  const view = permissionView(request, cwd);
  const decide = (decision: "allow_once" | "allow_always" | "deny") => void respond(sessionId, request.id, { decision });
  useRequestKeys(!resolution && latest, (key) => {
    if (key === "Enter" || key === "1") decide("allow_once");
    else if (key === "2") decide("allow_always");
    else if (key === "Escape" || key === "3") decide("deny");
    else return false;
    return true;
  });

  if (resolution) {
    const outcome = outcomeOf(resolution, response);
    const decision = outcome.by === "user" && "decision" in outcome.response ? outcome.response.decision : "deny";
    if (decision === "deny" || outcome.by !== "user") {
      return (
        <ResolvedRow icon={<ShieldX />} tone="danger" detail={<PermissionPreview view={view} />}>
          <span>{outcome.by === "interrupt" ? "中断时已拒绝" : outcome.by === "other" ? "请求已结束" : "已拒绝"}</span>
          <span className="truncate font-mono text-[12.5px] text-fg-3">{view.card.target}</span>
        </ResolvedRow>
      );
    }
    return (
      <ResolvedRow icon={<ShieldCheck />} tone="success" detail={<PermissionPreview view={view} />}>
        <span>{decision === "allow_always" ? "已总是允许" : "已允许一次"}</span>
        {decision === "allow_always" ? (
          <span className="rounded-md border border-line bg-surface px-1.5 py-px font-mono text-[11.5px] text-fg-2">{request.ruleHint}</span>
        ) : (
          <span className="truncate font-mono text-[12.5px] text-fg-3">{view.card.target}</span>
        )}
      </ResolvedRow>
    );
  }

  const showName = view.card.name === "Write" || view.card.name === "Edit";
  return (
    <PendingShell
      icon={<ShieldQuestion className="size-[17px]" />}
      title={
        <>
          允许 Easy Agent {view.verb}
          {showName && <span className="ml-1.5 font-mono text-[13px] font-medium text-fg-2">{view.card.target.split("/").pop()}</span>}？
        </>
      }
      subtitle={view.reason}
      footer={
        <>
          <Button variant="primary" onClick={() => decide("allow_once")}>
            允许一次
            <CornerDownLeft className="!size-3.5 opacity-70" />
          </Button>
          <Button variant="outline" onClick={() => decide("allow_always")} className="max-w-[60%]">
            <span className="shrink-0">总是允许</span>
            <span className="truncate font-mono text-[11.5px] text-fg-3">{request.ruleHint}</span>
          </Button>
          <Button variant="ghost" onClick={() => decide("deny")}>
            拒绝
          </Button>
          <span className="ml-auto hidden items-center gap-1.5 text-[11.5px] text-fg-3 md:flex">
            <Kbd>1</Kbd>
            <Kbd>2</Kbd>
            <Kbd>3</Kbd>
            <span>或</span>
            <Kbd>Esc</Kbd>
            <span>拒绝</span>
          </span>
        </>
      }
    >
      <PermissionPreview view={view} />
    </PendingShell>
  );
}

/* ------------------------------------------------------------------ */
/* Plan approval                                                       */
/* ------------------------------------------------------------------ */

function Toggle({ checked, onChange, children, hint }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; hint?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="group flex items-center gap-2 text-left"
      title={hint}
    >
      <span className={cn("relative h-[18px] w-[30px] rounded-full transition-colors", checked ? "bg-accent" : "bg-surface-3")}>
        <span className={cn("absolute top-[2px] size-[14px] rounded-full bg-white shadow-sm transition-all", checked ? "left-[14px]" : "left-[2px]")} />
      </span>
      <span className="text-[12.5px] text-fg-2 group-hover:text-fg">{children}</span>
    </button>
  );
}

function PlanCard({ sessionId, request, resolution, latest }: CardProps<PlanApprovalInteraction>) {
  const response = useSessions((s) => s.responses[request.id]);
  const [clearContext, setClearContext] = useState(true);
  const [acceptEdits, setAcceptEdits] = useState(false);
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");
  const plan = request.planContent ?? (typeof request.input.plan === "string" ? request.input.plan : request.summary);
  const approve = () => void respond(sessionId, request.id, { decision: "approve", clearContext, acceptEdits });
  const reject = () => void respond(sessionId, request.id, { decision: "reject", ...(feedback.trim() ? { feedback: feedback.trim() } : {}) });

  useRequestKeys(!resolution && latest && !revising, (key) => {
    if (key === "Enter") approve();
    else if (key === "Escape") void interrupt();
    else return false;
    return true;
  });

  const planBox = (
    <div className="scroll-thin max-h-[380px] overflow-y-auto rounded-xl border border-line bg-surface px-5 py-4">
      <Markdown text={plan} className="[--chat-size:14px]" />
    </div>
  );

  if (resolution) {
    const outcome = outcomeOf(resolution, response);
    const r = outcome.by === "user" ? outcome.response : undefined;
    if (r && "decision" in r && r.decision === "approve") {
      return (
        <ResolvedRow icon={<Check />} tone="success" detail={planBox}>
          <span>已批准计划</span>
          <span className="text-fg-3">
            {[r.clearContext && "清空上下文后执行", r.acceptEdits && "自动接受编辑"].filter(Boolean).join(" · ") || "保留上下文"}
          </span>
        </ResolvedRow>
      );
    }
    const fb = r && "decision" in r && r.decision === "reject" ? r.feedback : undefined;
    const stopped = outcome.by !== "user";
    return (
      <ResolvedRow icon={stopped ? <Ban /> : <MessageSquareText />} tone={stopped ? "warning" : "default"} detail={planBox}>
        <span>{stopped ? "计划未批准" : "要求修改计划"}</span>
        {fb && <span className="truncate text-fg-3">「{fb}」</span>}
      </ResolvedRow>
    );
  }

  return (
    <PendingShell
      icon={<ClipboardList className="size-[17px]" />}
      title="计划已就绪，等你确认"
      subtitle="批准后退出计划模式，按计划开始修改代码"
      footer={
        revising ? (
          <div className="flex w-full flex-col gap-2">
            <textarea
              // biome-ignore lint/a11y/noAutofocus: opening the feedback box is an explicit request to type
              autoFocus
              value={feedback}
              aria-label="修改意见"
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) reject();
                if (e.key === "Escape") setRevising(false);
              }}
              placeholder="说说哪里要改，比如：先不动配置文件，只改界面"
              rows={2}
              className="w-full resize-none rounded-xl border border-line bg-canvas px-3 py-2 text-[13px] text-fg outline-none placeholder:text-fg-3 focus:border-accent-line"
            />
            <div className="flex items-center gap-2">
              <Button variant="primary" onClick={reject}>
                提交修改意见
                <ArrowRight />
              </Button>
              <Button variant="ghost" onClick={() => setRevising(false)}>
                返回
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Button variant="primary" onClick={approve}>
              批准并执行
              <CornerDownLeft className="!size-3.5 opacity-70" />
            </Button>
            <Button variant="outline" onClick={() => setRevising(true)}>
              修改计划
            </Button>
            <div className="ml-auto flex flex-wrap items-center gap-4">
              <Toggle checked={clearContext} onChange={setClearContext} hint="丢掉规划阶段的对话，只带着计划开始实现">
                清空上下文
              </Toggle>
              <Toggle checked={acceptEdits} onChange={setAcceptEdits} hint="执行期间编辑文件不再逐个确认">
                自动接受编辑
              </Toggle>
            </div>
          </>
        )
      }
    >
      {planBox}
    </PendingShell>
  );
}

/* ------------------------------------------------------------------ */
/* Questions                                                           */
/* ------------------------------------------------------------------ */

function QuestionCard({ sessionId, request, resolution, latest }: CardProps<QuestionInteraction>) {
  const response = useSessions((s) => s.responses[request.id]);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [focus, setFocus] = useState(0);
  const complete = request.questions.every((q) => (answers[q.question]?.length ?? 0) > 0);

  const pick = (qi: number, label: string) => {
    const q = request.questions[qi];
    if (!q) return;
    setAnswers((prev) => {
      const current = prev[q.question] ?? [];
      const next = q.multiSelect ? (current.includes(label) ? current.filter((l) => l !== label) : [...current, label]) : [label];
      return { ...prev, [q.question]: next };
    });
    if (!q.multiSelect && qi < request.questions.length - 1) setFocus(qi + 1);
  };
  const submit = () =>
    complete && void respond(sessionId, request.id, { answers: Object.fromEntries(Object.entries(answers).map(([q, a]) => [q, a.join(", ")])) });
  const skip = () => void respond(sessionId, request.id, { cancelled: true });

  useRequestKeys(!resolution && latest, (key) => {
    const n = Number(key);
    const q = request.questions[focus];
    if (q && n >= 1 && n <= q.options.length) pick(focus, q.options[n - 1]!.label);
    else if (key === "Enter" && complete) submit();
    else if (key === "Escape") skip();
    else if (key === "Tab") setFocus((f) => (f + 1) % request.questions.length);
    else return false;
    return true;
  });

  if (resolution) {
    const outcome = outcomeOf(resolution, response);
    if (outcome.by === "user" && "answers" in outcome.response) {
      const given = outcome.response.answers;
      return (
        <ResolvedRow
          icon={<CircleHelp />}
          tone="default"
          detail={
            <div className="flex flex-col gap-1 text-[12.5px]">
              {Object.entries(given).map(([q, a]) => (
                <div key={q} className="flex gap-2">
                  <span className="text-fg-3">{q}</span>
                  <span className="text-fg">{a}</span>
                </div>
              ))}
            </div>
          }
        >
          <span>已回答 {Object.keys(given).length} 个问题</span>
          <span className="truncate text-fg-3">{Object.values(given).join(" · ")}</span>
        </ResolvedRow>
      );
    }
    return (
      <ResolvedRow icon={<Ban />} tone="warning">
        <span>{outcome.by === "interrupt" ? "中断时已取消提问" : "已跳过提问"}</span>
      </ResolvedRow>
    );
  }

  return (
    <PendingShell
      icon={<CircleHelp className="size-[17px]" />}
      title="需要你做个选择"
      subtitle={`${request.questions.length} 个问题，按数字键快速选择`}
      footer={
        <>
          <Button variant="primary" disabled={!complete} onClick={submit}>
            提交
            <CornerDownLeft className="!size-3.5 opacity-70" />
          </Button>
          <Button variant="ghost" onClick={skip}>
            跳过，让 Agent 决定
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {request.questions.map((q, qi) => (
          <div key={q.question} onFocusCapture={() => setFocus(qi)}>
            <div className="mb-2 flex items-center gap-2">
              {q.header && (
                <span className={cn("rounded-md px-1.5 py-px text-[11px] font-medium", focus === qi ? "bg-accent-soft text-accent" : "bg-surface-2 text-fg-3")}>
                  {q.header}
                </span>
              )}
              <span className="text-[13.5px] font-medium text-fg">{q.question}</span>
            </div>
            <div className="grid gap-1.5">
              {q.options.map((o, oi) => {
                const selected = answers[q.question]?.includes(o.label) ?? false;
                return (
                  <button
                    key={o.label}
                    type="button"
                    onClick={() => {
                      setFocus(qi);
                      pick(qi, o.label);
                    }}
                    className={cn(
                      "group flex items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-all",
                      selected ? "border-accent-line bg-accent-softer" : "border-line bg-surface hover:border-line-strong hover:bg-surface-2/60",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-px flex size-[18px] shrink-0 items-center justify-center rounded-md border text-[10.5px] font-semibold tabular transition-colors",
                        selected ? "border-transparent bg-accent text-accent-fg" : "border-line-strong text-fg-3",
                      )}
                    >
                      {selected ? <Check className="size-3" strokeWidth={3} /> : oi + 1}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium text-fg">{o.label}</span>
                      {o.description && <span className="mt-0.5 block text-[12.5px] leading-[1.55] text-fg-2">{o.description}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </PendingShell>
  );
}

interface CardProps<R> {
  sessionId: string;
  cwd: string;
  request: R;
  resolution?: InteractionResolution;
  latest: boolean;
}

export function RequestBlock({
  block,
  sessionId,
  cwd,
  latest,
}: {
  block: Extract<Block, { kind: "request" }>;
  sessionId: string;
  cwd: string;
  latest: boolean;
}) {
  const props = { sessionId, cwd, latest, ...(block.resolution ? { resolution: block.resolution } : {}) };
  const { request } = block;
  if (request.kind === "permission") return <PermissionCard {...props} request={request} />;
  if (request.kind === "plan_approval") return <PlanCard {...props} request={request} />;
  return <QuestionCard {...props} request={request} />;
}
