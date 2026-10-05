import { ArrowUpRight, Bug, ClipboardList, FlaskConical, GitBranch, Microscope } from "lucide-react";
import { motion } from "motion/react";
import type { WorkspaceInfo } from "../../../shared/contract";
import type { PermissionMode } from "../../agent/viewModel";
import { AppMark } from "../../design/AppMark";
import { sendMessage } from "../../state/actions";
import { useSessions } from "../../state/sessions";
import { useUi } from "../../state/ui";
import { useRuntime } from "../../state/workspaces";
import { Composer } from "../composer/Composer";
import { HostBanner } from "./HostBanner";
import { WorkspaceAvatar } from "./WorkspaceAvatar";

const SUGGESTIONS: { icon: typeof Bug; title: string; prompt: string; mode?: PermissionMode; hint: string }[] = [
  { icon: Microscope, title: "讲讲这个仓库的架构", hint: "只读探索", prompt: "解释一下这个项目的整体架构，主要模块之间是怎么协作的？" },
  { icon: Bug, title: "找找潜在的 bug", hint: "阅读代码 · 列出问题", prompt: "通读一下核心代码，列出你觉得最可能出 bug 的几个地方，说明原因。" },
  { icon: ClipboardList, title: "先出计划再动手", hint: "计划模式 · 审批", mode: "plan", prompt: "我想给这个项目补一个小功能，先读代码，给我一个实现计划。" },
  { icon: FlaskConical, title: "补充单元测试", hint: "编辑 · 运行测试", prompt: "找一个测试覆盖不足的模块，给它补上单元测试并跑一遍。" },
];

function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return "夜深了";
  if (h < 11) return "早上好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

/** The new-session page of an open workspace. */
export function Welcome({ workspace }: { workspace: WorkspaceInfo }) {
  const { branch, status } = useRuntime(workspace.id);
  const userName = useUi((s) => s.appInfo?.userName);
  const setDraft = useSessions((s) => s.setDraft);

  const start = (prompt: string, mode?: PermissionMode) => {
    if (status.state !== "ready") return;
    if (mode) setDraft({ mode });
    void sendMessage(prompt);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto scroll-thin">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(60%_60%_at_50%_0%,var(--accent-softer),transparent_70%)]" />
      <div className="relative mx-auto flex w-full max-w-[720px] flex-1 flex-col justify-center px-6 py-16">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}>
          <div className="mb-7 flex flex-col items-center text-center">
            <AppMark />
            <h2 className="text-[26px] font-semibold tracking-[-0.025em] text-fg">
              {greeting()}
              {userName ? `，${userName}` : ""}
            </h2>
            <p className="mt-2 flex items-center gap-1.5 text-[13.5px] text-fg-2">
              在
              <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-1.5 py-0.5 text-[12.5px] text-fg">
                <WorkspaceAvatar name={workspace.name} color={workspace.color} size={14} />
                {workspace.name}
              </span>
              {branch && (
                <span className="inline-flex items-center gap-1 font-mono text-[12px] text-fg-3">
                  <GitBranch className="size-3" />
                  {branch}
                </span>
              )}
              里工作
            </p>
          </div>

          <HostBanner workspace={workspace} className="mb-4" />

          <Composer variant="hero" />

          <div className="mt-6 grid grid-cols-2 gap-2.5">
            {SUGGESTIONS.map((s, i) => (
              <motion.button
                key={s.title}
                type="button"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.08 + i * 0.05, ease: [0.16, 1, 0.3, 1] }}
                onClick={() => start(s.prompt, s.mode)}
                className="group flex items-start gap-3 rounded-2xl border border-line bg-canvas/60 p-3.5 text-left transition-all hover:-translate-y-px hover:border-line-strong hover:bg-canvas hover:shadow-[0_8px_24px_-16px_rgb(0_0_0/0.4)]"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-surface-2 text-fg-2 transition-colors group-hover:bg-accent-soft group-hover:text-accent">
                  <s.icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-fg">{s.title}</span>
                  <span className="mt-0.5 block text-[12px] text-fg-3">{s.hint}</span>
                </span>
                <ArrowUpRight className="size-3.5 text-fg-4 opacity-0 transition-opacity group-hover:opacity-100" />
              </motion.button>
            ))}
          </div>
        </motion.div>
      </div>
    </div>
  );
}
