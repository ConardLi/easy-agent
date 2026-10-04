import { FolderGit2, FolderOpen, ShieldCheck } from "lucide-react";
import { motion } from "motion/react";
import { AppMark } from "../../design/AppMark";
import { MOD, Shortcut } from "../../design/primitives";
import { notYet } from "../../state/ui";

/** First launch: no workspace is open, so there is no Agent process yet. */
export function FirstRun() {
  const actions = [
    { icon: FolderOpen, title: "打开文件夹", hint: "选择本地的项目目录", keys: [MOD, "O"], onClick: () => notYet("打开文件夹") },
    { icon: FolderGit2, title: "克隆仓库", hint: "从 Git 地址克隆到本地", onClick: () => notYet("克隆仓库") },
  ];

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto scroll-thin">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(60%_60%_at_50%_0%,var(--accent-softer),transparent_70%)]" />
      <div className="relative mx-auto flex w-full max-w-[560px] flex-1 flex-col justify-center px-6 py-16">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}>
          <div className="mb-8 flex flex-col items-center text-center">
            <AppMark />
            <h2 className="text-[26px] font-semibold tracking-[-0.025em] text-fg">欢迎使用 Easy Agent</h2>
            <p className="mt-2 text-[13.5px] text-fg-2">打开一个项目文件夹，Agent 会在里面读代码、改文件、跑命令。</p>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            {actions.map((a) => (
              <button
                key={a.title}
                type="button"
                onClick={a.onClick}
                className="no-drag group flex items-start gap-3 rounded-2xl border border-line bg-canvas/60 p-3.5 text-left transition-all hover:-translate-y-px hover:border-line-strong hover:bg-canvas hover:shadow-[0_8px_24px_-16px_rgb(0_0_0/0.4)]"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-surface-2 text-fg-2 transition-colors group-hover:bg-accent-soft group-hover:text-accent">
                  <a.icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-fg">{a.title}</span>
                  <span className="mt-0.5 block text-[12px] text-fg-3">{a.hint}</span>
                </span>
                {a.keys && <Shortcut keys={a.keys} className="mt-0.5" />}
              </button>
            ))}
          </div>

          <p className="mt-6 flex items-start justify-center gap-1.5 text-center text-[12px] leading-[1.6] text-fg-3">
            <ShieldCheck className="mt-[3px] size-3.5 shrink-0" />
            每个工作区单独运行一个 Agent 进程，项目里的配置要你信任后才会生效。
          </p>
        </motion.div>
      </div>
    </div>
  );
}
