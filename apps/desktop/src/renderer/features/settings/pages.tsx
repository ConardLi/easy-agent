import { Check, FolderOpen, Globe, HardDrive, Monitor, Moon, Plus, ShieldAlert, ShieldCheck, Sun, X } from "lucide-react";
import { useState } from "react";
import { ACCENTS, type Theme } from "../../../shared/contract";
import { Button, cn, IconButton, isMac, Kbd, MOD, Segmented, Switch } from "../../design/primitives";
import { desktop } from "../../lib/desktop";
import { usePrefs } from "../../state/prefs";
import { restartIdleAgents, setWorkspaceTrust, updateAgent, useSettings } from "../../state/settings";
import { useUi } from "../../state/ui";
import { useRuntime, useWorkspaces } from "../../state/workspaces";
import { MODES } from "../composer/Pickers";
import type { AgentSettings, RuleEntry, SettingKey } from "./agentSettings";
import { Group, ListEditor, NumberInput, PageTitle, Row, ScopeTag, Select, TextInput } from "./controls";

/** Write one or more settings keys to the file being edited. */
function useSetting() {
  return (keys: SettingKey[], fn: (a: AgentSettings) => AgentSettings, quiet = false) => void updateAgent(fn, keys, quiet);
}

/** The Agent settings; the settings view only shows Agent pages once they are loaded. */
const useAgent = (): AgentSettings => useSettings((s) => s.agent)!;

/** A value kept in a text field and written when the field loses focus. */
function Draft({ value, onCommit, ...rest }: { value: string; onCommit: (v: string) => void } & Omit<Parameters<typeof TextInput>[0], "value" | "onChange">) {
  const [draft, setDraft] = useState(value);
  return <TextInput value={draft} onChange={setDraft} onBlur={() => draft !== value && onCommit(draft)} {...rest} />;
}

/** A number field written when it loses focus. */
function DraftNumber({
  value,
  onCommit,
  ...rest
}: { value: number; onCommit: (v: number) => void } & Omit<Parameters<typeof NumberInput>[0], "value" | "onChange">) {
  const [draft, setDraft] = useState(value);
  return <NumberInput value={draft} onChange={setDraft} onBlur={() => draft !== value && onCommit(draft)} {...rest} />;
}

/* ------------------------------------------------------------------ */

export function GeneralPage() {
  const prefs = usePrefs();
  const setPrefs = prefs.update;
  return (
    <>
      <PageTitle title="通用" description="桌面端自己的偏好，保存在本机的应用数据里，和 Agent 的 settings.json 无关。" />
      <Group>
        <Row title="界面语言" hint="TODO：英文界面放在 M6">
          <Segmented value="zh" onChange={() => {}} options={[{ value: "zh", label: "简体中文" }]} />
        </Row>
        <Row title="发送消息" hint="另一种组合用来换行">
          <Segmented
            value={prefs.sendWith}
            onChange={(sendWith) => setPrefs({ sendWith })}
            options={[
              { value: "enter", label: "Enter" },
              { value: "mod-enter", label: `${MOD} Enter` },
            ]}
          />
        </Row>
        <Row title="完成时通知" hint="后台会话跑完或需要你确认时发系统通知">
          <Switch checked={prefs.notifyOnFinish} onChange={(notifyOnFinish) => setPrefs({ notifyOnFinish })} />
        </Row>
        <Row title="启动时打开上次的工作区">
          <Switch checked={prefs.reopenLastWorkspace} onChange={(reopenLastWorkspace) => setPrefs({ reopenLastWorkspace })} />
        </Row>
      </Group>
    </>
  );
}

/* ------------------------------------------------------------------ */

export function BehaviorPage() {
  const agent = useAgent();
  const toolSearch = agent.toolSearch;
  const set = useSetting();
  const todo = { taskMode: "task", agentTeams: false, maxRetries: 10, promptCaching: true, experimentalBetas: true, mcpConnectTimeout: 30 };
  return (
    <>
      <PageTitle
        title="行为"
        description="Agent 怎么回复、一次最多做多少事、怎么处理工具。标 TODO 的几项 settings.json 里还没有，现在只能用环境变量或启动参数设置。"
      />
      <Group title="回复">
        <Row title="回复语言" hint="写进系统提示词，代码和标识符保持原样" k="language">
          <Select
            value={agent.language}
            onChange={(language) => set(["language"], (a) => ({ ...a, language }))}
            options={[
              { value: "", label: "跟随对话" },
              ...["简体中文", "繁體中文", "English", "日本語"].map((v) => ({ value: v, label: v })),
              ...(agent.language && !["简体中文", "繁體中文", "English", "日本語"].includes(agent.language)
                ? [{ value: agent.language, label: agent.language }]
                : []),
            ]}
          />
        </Row>
        <Row
          title="输出风格"
          hint="讲解风格会顺带解释为什么这么改；学习风格会留一些小任务让你自己动手。也可以在 ~/.easy-agent/output-styles/ 里自己写"
          k="outputStyle"
        >
          <Segmented
            value={agent.outputStyle}
            onChange={(outputStyle) => set(["outputStyle"], (a) => ({ ...a, outputStyle }))}
            options={[
              { value: "default", label: "默认" },
              { value: "explanatory", label: "讲解" },
              { value: "learning", label: "学习" },
            ]}
          />
        </Row>
      </Group>
      <Group title="执行">
        <Row title="单次请求的工具轮数上限" hint="到了上限就停下来，等你说继续。子 Agent 用自己定义里的 maxTurns" k="maxTurns">
          <DraftNumber value={agent.maxTurns} min={1} step={10} suffix="轮" onCommit={(maxTurns) => set(["maxTurns"], (a) => ({ ...a, maxTurns }))} />
        </Row>
        <Row title="遵守 .gitignore" hint="Glob 和 Grep 跳过被忽略的文件" k="respectGitignore">
          <Switch checked={agent.respectGitignore} onChange={(respectGitignore) => set(["respectGitignore"], (a) => ({ ...a, respectGitignore }))} />
        </Row>
        <Row title="任务系统" hint="任务图可以跨会话保存、带依赖；待办清单只在当前会话里有效" k="taskMode">
          <Segmented
            value={todo.taskMode}
            onChange={() => {}}
            options={[
              { value: "task", label: "任务图" },
              { value: "todo", label: "待办清单" },
            ]}
          />
        </Row>
        <Row title="Agent Teams" hint="允许 Agent 组建团队、派出有名字的队友并互相发消息" k="agentTeams">
          <Switch checked={todo.agentTeams} onChange={() => {}} />
        </Row>
      </Group>
      <Group title="工具加载">
        <Row title="ToolSearch" hint="工具多的时候先只给模型看工具名，用到时再加载定义，能省不少上下文" k="toolSearch">
          <Segmented
            value={toolSearch}
            onChange={(v) => set(["toolSearch"], (a) => ({ ...a, toolSearch: v }))}
            options={[
              { value: "off", label: "关闭" },
              { value: "auto", label: "自动" },
              { value: "on", label: "总是" },
            ]}
          />
        </Row>
        {toolSearch === "auto" && (
          <Row title="自动启用的阈值" hint="工具定义超过上下文窗口的这个比例时启用" k="toolSearchAutoThreshold">
            <DraftNumber
              value={agent.toolSearchAutoThreshold}
              min={1}
              suffix="%"
              onCommit={(toolSearchAutoThreshold) => set(["toolSearchAutoThreshold"], (a) => ({ ...a, toolSearchAutoThreshold }))}
            />
          </Row>
        )}
        <Row title="MCP 连接超时" hint="启动 MCP 服务器时等待握手的时间" k="mcpConnectTimeout">
          <NumberInput value={todo.mcpConnectTimeout} min={1} suffix="秒" onChange={() => {}} />
        </Row>
      </Group>
      <Group title="请求">
        <Row title="失败重试次数" hint="遇到限流、过载和网络错误时自动重试，间隔逐次加长" k="maxRetries">
          <NumberInput value={todo.maxRetries} min={0} suffix="次" onChange={() => {}} />
        </Row>
        <Row title="提示词缓存" hint="有的兼容接口不认 cache_control 或 prompt_cache_key，会报错，这时关掉" k="promptCaching">
          <Switch checked={todo.promptCaching} onChange={() => {}} />
        </Row>
        <Row title="实验性 beta 头" hint="Anthropic 接口上带上实验功能的 beta 头。网关不认的时候关掉" k="experimentalBetas">
          <Switch checked={todo.experimentalBetas} onChange={() => {}} />
        </Row>
      </Group>
      <Group title="网络搜索" description="WebSearch 工具用的搜索后端。">
        <Row title="后端" k="webSearch.adapter">
          <Segmented
            value="auto"
            onChange={() => {}}
            options={[
              { value: "auto", label: "自动" },
              { value: "api", label: "搜索 API" },
              { value: "bing", label: "Bing" },
            ]}
          />
        </Row>
        <Row title="API Key" hint="选「自动」时有 Key 就用搜索 API，没有就用 Bing" k="webSearch.apiKey">
          <TextInput value="" onChange={() => {}} type="password" mono width={240} />
        </Row>
      </Group>
    </>
  );
}

/* ------------------------------------------------------------------ */

export function TerminalPage() {
  const agent = useAgent();
  const set = useSetting();
  return (
    <>
      <PageTitle title="终端界面" description="这几项只影响命令行里的 eagent，桌面端不受影响。和其他 Agent 设置一样写在 settings.json 里，所以在这里也能改。" />
      <Group>
        <Row title="状态栏命令" hint="命令的输出显示在输入框下方，标准输入会拿到当前会话的 JSON" k="statusLine" stack>
          <Draft
            value={agent.statusLine}
            onCommit={(statusLine) => set(["statusLine"], (a) => ({ ...a, statusLine }))}
            placeholder="~/.easy-agent/statusline.sh"
            mono
          />
        </Row>
        <Row title="代码高亮" hint="关闭后代码块用纯文本显示，不输出 ANSI 颜色" k="syntaxHighlightingDisabled">
          <Switch
            checked={!agent.syntaxHighlightingDisabled}
            onChange={(v) => set(["syntaxHighlightingDisabled"], (a) => ({ ...a, syntaxHighlightingDisabled: !v }))}
          />
        </Row>
        <Row title="减少动画" hint="加载指示改成静态的" k="prefersReducedMotion">
          <Switch
            checked={agent.prefersReducedMotion}
            onChange={(prefersReducedMotion) => set(["prefersReducedMotion"], (a) => ({ ...a, prefersReducedMotion }))}
          />
        </Row>
      </Group>
    </>
  );
}

/* ------------------------------------------------------------------ */

/** The command line and environment the desktop app starts the Agent with. */
export function RuntimePage() {
  const prefs = usePrefs();
  const setPrefs = prefs.update;
  const workspace = useWorkspaces((s) => s.workspaces.find((w) => w.id === s.activeId));
  const status = useRuntime(workspace?.id).status;
  const version = status.state === "ready" ? status.init.serverInfo.version : null;
  const bin = prefs.agentRuntime === "bundled" ? "<应用内置>/eagent" : prefs.agentPath || "eagent";
  const args = ["--rpc", prefs.extraSettingsFile && `--settings ${prefs.extraSettingsFile}`].filter(Boolean);
  const env = [prefs.debugLogging && "EASY_AGENT_DEBUG=1", "EASY_AGENT_KEY_*=<钥匙串里的密钥>"].filter(Boolean) as string[];

  return (
    <>
      <PageTitle
        title="Agent 进程"
        description="桌面端为每个工作区启动一个 eagent --rpc 子进程，通过 JSON-RPC 和它通信。这里决定用哪个 eagent、带什么参数启动，改动在进程重启后生效。"
      />
      <Group title="运行时">
        <Row
          title="eagent"
          hint={
            prefs.agentRuntime === "bundled" ? `用应用自带的版本${version ? ` ${version}` : ""}，随应用一起更新` : "用你自己安装的版本，适合调试 Agent 本身"
          }
        >
          <Segmented
            value={prefs.agentRuntime}
            onChange={(agentRuntime) => setPrefs({ agentRuntime })}
            options={[
              { value: "bundled", label: "内置" },
              { value: "system", label: "系统安装" },
            ]}
          />
        </Row>
        {prefs.agentRuntime === "system" && (
          <Row title="路径" hint={version ? `当前进程的版本 ${version}` : "命令名或可执行文件的路径"} stack>
            <Draft value={prefs.agentPath} onCommit={(agentPath) => setPrefs({ agentPath })} mono />
          </Row>
        )}
        <Row title="额外的配置文件" hint="用 --settings 加载，优先级高于全局、项目和本机配置，适合团队统一下发" stack>
          <Draft
            value={prefs.extraSettingsFile}
            onCommit={(extraSettingsFile) => setPrefs({ extraSettingsFile })}
            placeholder="~/company/easy-agent-policy.json"
            mono
          />
        </Row>
        <Row title="崩溃后自动重启" hint="进程意外退出时重新启动，并恢复正在进行的会话">
          <Switch checked={prefs.autoRestart} onChange={(autoRestart) => setPrefs({ autoRestart })} />
        </Row>
        <Row title="调试日志" hint="设置 EASY_AGENT_DEBUG=1，日志写到 ~/.easy-agent/debug/">
          <Switch checked={prefs.debugLogging} onChange={(debugLogging) => setPrefs({ debugLogging })} />
        </Row>
      </Group>

      <section className="mb-7">
        <div className="mb-2 flex items-end px-1">
          <div className="flex-1">
            <h3 className="text-[13px] font-semibold text-fg">启动命令</h3>
            <p className="mt-0.5 text-[12px] text-fg-3">钥匙串里的密钥作为环境变量传给进程，settings.json 里只写 {"${EASY_AGENT_KEY_…}"} 引用。</p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => void restartIdleAgents("已按新的设置启动")}>
            重启所有进程
          </Button>
        </div>
        <div className="overflow-hidden rounded-xl border border-line bg-canvas font-mono text-[12px] leading-[1.7]">
          <div className="border-b border-line px-4 py-3 text-fg">
            {env.map((e) => (
              <div key={e} className="text-fg-3">
                {e} \
              </div>
            ))}
            <span className="text-accent">{bin}</span> {args.join(" ")}
          </div>
          <div className="px-4 py-2.5 text-[11.5px] text-fg-3">
            工作区目录作为 cwd；工作区信任、模型和权限模式在 initialize 和 session/create 里传，不走命令行。
          </div>
        </div>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ */

function ThemeTile({ theme, active, onClick }: { theme: Theme; active: boolean; onClick: () => void }) {
  const label = { light: "浅色", dark: "深色", system: "跟随系统" }[theme];
  const Icon = { light: Sun, dark: Moon, system: Monitor }[theme];
  const pane = (dark: boolean) => (
    <div className={cn("flex h-full flex-1 gap-1.5 p-1.5", dark ? "bg-[#0c0c0e]" : "bg-[#f4f4f2]")}>
      <div className="flex w-5 flex-col gap-1 pt-1">
        {[0, 1, 2].map((i) => (
          <span key={i} className={cn("h-1 rounded-full", dark ? "bg-white/15" : "bg-black/10")} />
        ))}
      </div>
      <div className={cn("flex flex-1 flex-col justify-end gap-1 rounded-md p-1.5", dark ? "bg-[#18181b]" : "bg-white")}>
        <span className={cn("ml-auto h-1.5 w-8 rounded-full", dark ? "bg-white/15" : "bg-black/8")} />
        <span className={cn("h-1.5 w-12 rounded-full", dark ? "bg-white/10" : "bg-black/6")} />
        <span className="mt-1 h-3 rounded-[4px] border" style={{ borderColor: "var(--accent-line)" }} />
      </div>
    </div>
  );
  return (
    <button type="button" onClick={onClick} className="group flex flex-1 flex-col gap-2 text-left">
      <div
        className={cn(
          "flex h-[92px] overflow-hidden rounded-xl border transition-all",
          active ? "border-accent shadow-[0_0_0_3px_var(--accent-soft)]" : "border-line group-hover:border-line-strong",
        )}
      >
        {theme === "system" ? (
          <>
            {pane(false)}
            {pane(true)}
          </>
        ) : (
          pane(theme === "dark")
        )}
      </div>
      <span className={cn("flex items-center gap-1.5 text-[12.5px] font-medium", active ? "text-fg" : "text-fg-2")}>
        <Icon className="size-3.5" />
        {label}
      </span>
    </button>
  );
}

export function AppearancePage() {
  const prefs = usePrefs();
  const setPrefs = prefs.update;
  return (
    <>
      <PageTitle title="外观" />
      <div className="mb-7 flex gap-3">
        {(["light", "dark", "system"] as const).map((t) => (
          <ThemeTile key={t} theme={t} active={prefs.theme === t} onClick={() => setPrefs({ theme: t })} />
        ))}
      </div>
      <Group>
        <Row title="强调色" hint="按钮、焦点和需要你处理的请求用这个颜色">
          <div className="flex gap-2">
            {ACCENTS.map((a) => (
              <button
                key={a.id}
                type="button"
                title={a.label}
                onClick={() => setPrefs({ accent: a.id })}
                className={cn(
                  "flex size-6 items-center justify-center rounded-full transition-transform hover:scale-110",
                  prefs.accent === a.id && "ring-2 ring-offset-2 ring-offset-canvas",
                )}
                style={{ background: a.color, ["--tw-ring-color" as string]: a.color }}
              >
                {prefs.accent === a.id && <Check className="size-3 text-white" strokeWidth={3} />}
              </button>
            ))}
          </div>
        </Row>
        <Row title="对话字号">
          <Segmented
            value={prefs.fontSize}
            onChange={(fontSize) => setPrefs({ fontSize })}
            options={[
              { value: 14, label: "小" },
              { value: 15, label: "标准" },
              { value: 16, label: "大" },
            ]}
          />
        </Row>
        <Row title="展开思考过程" hint="模型思考时实时显示，结束后自动收起">
          <Switch checked={prefs.showThinking} onChange={(showThinking) => setPrefs({ showThinking })} />
        </Row>
      </Group>
    </>
  );
}

/* ------------------------------------------------------------------ */

const EFFECT = {
  allow: { label: "允许", tone: "bg-success/12 text-success", hint: "直接执行，不再询问" },
  ask: { label: "询问", tone: "bg-warning/12 text-warning", hint: "每次都先问你，哪怕处在自动模式" },
  deny: { label: "拒绝", tone: "bg-danger/12 text-danger", hint: "直接拒绝，任何模式和确认都推翻不了" },
} as const;

export function PermissionsPage() {
  const agent = useAgent();
  const writeScope = useSettings((s) => s.writeScope);
  const [dir, setDir] = useState("");
  const set = useSetting();
  const [effect, setEffect] = useState<RuleEntry["effect"]>("allow");
  const [draft, setDraft] = useState("");
  const rules = agent.rules.filter((r) => r.effect === effect);

  const addRule = () => {
    const rule = draft.trim();
    if (!rule) return;
    set(["rules"], (a) => ({ ...a, rules: [...a.rules, { rule, effect, scope: writeScope }] }));
    setDraft("");
  };

  return (
    <>
      <PageTitle
        title="权限"
        description="Agent 每次调用工具前，按 拒绝 → 询问 → 允许 的顺序匹配规则，都没匹配上再看权限模式。规则来自所有配置文件，合并后一起生效。"
      />
      <Group title="默认权限模式" description="新会话开始时的模式。仓库里的配置不能替你打开自动模式，所以这一项只能写在全局设置。">
        <Row title="模式" k="mode">
          <Segmented
            value={agent.mode}
            onChange={(mode) => set(["mode"], (a) => ({ ...a, mode }))}
            options={MODES.map((m) => ({ value: m.id, label: m.label }))}
          />
        </Row>
      </Group>

      <section className="mb-7">
        <div className="mb-2 flex items-center gap-3 px-1">
          <h3 className="text-[13px] font-semibold text-fg">规则</h3>
          <Segmented
            value={effect}
            onChange={setEffect}
            options={(["allow", "ask", "deny"] as const).map((e) => ({
              value: e,
              label: `${EFFECT[e].label} ${agent.rules.filter((r) => r.effect === e).length}`,
            }))}
          />
          <span className="text-[12px] text-fg-3">{EFFECT[effect].hint}</span>
        </div>
        <div className="overflow-hidden rounded-xl border border-line bg-canvas">
          {rules.map((r) => (
            <div key={`${r.rule}-${r.scope}`} className="group flex h-11 items-center gap-3 border-b border-line px-4 last:border-b-0">
              <span className={cn("w-10 rounded-md py-0.5 text-center text-[11px] font-medium", EFFECT[r.effect].tone)}>{EFFECT[r.effect].label}</span>
              <span className="flex-1 font-mono text-[12.5px] text-fg">{r.rule}</span>
              <ScopeTag scope={r.scope} />
              <IconButton
                size="sm"
                className="opacity-0 group-hover:opacity-100"
                onClick={() => set(["rules"], (a) => ({ ...a, rules: a.rules.filter((x) => x !== r) }))}
                aria-label="删除规则"
              >
                <X />
              </IconButton>
            </div>
          ))}
          <form
            className="flex items-center gap-2 bg-surface/50 px-4 py-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              addRule();
            }}
          >
            <TextInput value={draft} onChange={setDraft} placeholder="Bash(pnpm lint:*)、Edit(src/**)、WebFetch(domain:github.com)、mcp__github" mono />
            <Button type="submit" variant="secondary" size="sm">
              <Plus />
              添加{EFFECT[effect].label}规则
            </Button>
          </form>
        </div>
        <p className="mt-2 px-1 text-[11.5px] leading-[1.6] text-fg-3">
          写法：<code className="font-mono">工具名</code> 匹配整个工具，<code className="font-mono">Bash(命令前缀:*)</code> 匹配命令前缀，
          <code className="font-mono">Read(路径 glob)</code> 匹配文件，<code className="font-mono">mcp__服务器</code> 匹配一个 MCP 服务器的全部工具。
        </p>
      </section>

      <Group title="额外允许访问的目录" description="工作区之外，文件工具还可以读写这些目录。只在受信任的配置里生效，不要用符号链接代替。">
        <div className="py-3.5">
          <div className="flex flex-col gap-1.5">
            {agent.additionalDirectories.map((d) => (
              <div key={d.path} className="group flex h-9 items-center gap-2.5 rounded-lg border border-line bg-surface px-3">
                <FolderOpen className="size-3.5 text-fg-3" />
                <span className="flex-1 font-mono text-[12.5px] text-fg">{d.path}</span>
                <ScopeTag scope={d.scope} />
                <IconButton
                  size="sm"
                  className="opacity-0 group-hover:opacity-100"
                  onClick={() => set(["additionalDirectories"], (a) => ({ ...a, additionalDirectories: a.additionalDirectories.filter((x) => x !== d) }))}
                  aria-label="移除"
                >
                  <X />
                </IconButton>
              </div>
            ))}
          </div>
          <form
            className="mt-2 flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const path = dir.trim();
              if (!path) return;
              set(["additionalDirectories"], (a) => ({ ...a, additionalDirectories: [...a.additionalDirectories, { path, scope: writeScope }] }));
              setDir("");
            }}
          >
            <TextInput value={dir} onChange={setDir} placeholder="~/code/shared-lib" mono />
            <Button type="submit" variant="secondary" size="sm">
              <Plus />
              添加目录
            </Button>
          </form>
        </div>
      </Group>
    </>
  );
}

/* ------------------------------------------------------------------ */

export function SandboxPage() {
  const sb = useAgent().sandbox;
  const workspaceId = useWorkspaces((s) => s.activeId) ?? undefined;
  const status = useRuntime(workspaceId).status;
  const unavailable = status.state === "ready" ? status.init.workspace.sandboxUnavailableReason : null;
  const set = useSetting();
  const put = <K extends keyof AgentSettings["sandbox"]>(key: K, value: AgentSettings["sandbox"][K], quiet = false) =>
    set([`sandbox.${key}`], (a) => ({ ...a, sandbox: { ...a.sandbox, [key]: value } }), quiet);

  return (
    <>
      <PageTitle title="沙箱" description="Bash 命令在操作系统级的沙箱里执行：文件系统按白名单可写，网络只能经过本地代理按域名放行。" />
      {unavailable ? (
        <div className="mb-7 flex items-center gap-3 rounded-xl border border-warning/30 bg-warning/[0.06] px-4 py-3">
          <ShieldAlert className="size-5 text-warning" />
          <div className="flex-1 text-[12.5px] text-fg-2">
            <span className="font-medium text-fg">沙箱不可用</span> · {unavailable}
          </div>
        </div>
      ) : (
        <div className="mb-7 flex items-center gap-3 rounded-xl border border-success/30 bg-success/[0.06] px-4 py-3">
          <ShieldCheck className="size-5 text-success" />
          <div className="flex-1 text-[12.5px] text-fg-2">
            <span className="font-medium text-fg">沙箱可用</span> · {isMac ? "macOS sandbox-exec" : "Linux bubblewrap"}
          </div>
        </div>
      )}
      <Group title="行为">
        <Row title="启用沙箱" hint="关闭后命令直接在你的系统上运行，每条都要你确认" k="sandbox.enabled">
          <Switch checked={sb.enabled} onChange={(v) => put("enabled", v)} />
        </Row>
        <Row title="沙箱不可用时拒绝执行" hint="打开后，沙箱起不来就不执行命令，不会退回普通的权限确认" k="sandbox.failClosed">
          <Switch checked={sb.failClosed} onChange={(v) => put("failClosed", v)} />
        </Row>
        <Row title="沙箱内的命令免确认" hint="能在沙箱里跑的命令直接执行，越界的写入和网络访问仍会被拦下" k="sandbox.autoAllowBashIfSandboxed">
          <Switch checked={sb.autoAllowBashIfSandboxed} onChange={(v) => put("autoAllowBashIfSandboxed", v)} />
        </Row>
        <Row title="允许模型要求跳出沙箱" hint="命令被沙箱挡住时，模型可以申请在沙箱外重试，仍需你确认" k="sandbox.allowUnsandboxedCommands">
          <Switch checked={sb.allowUnsandboxedCommands} onChange={(v) => put("allowUnsandboxedCommands", v)} />
        </Row>
        <Row title="不进沙箱的命令" hint="这些命令按前缀匹配，始终在沙箱外执行，比如需要访问 Docker 守护进程的命令" k="sandbox.excludedCommands" stack>
          <ListEditor items={sb.excludedCommands} onChange={(v) => put("excludedCommands", v, true)} placeholder="docker" />
        </Row>
      </Group>
      <Group title="文件系统" description="工作区和临时目录默认可写，下面的规则在此基础上增减。">
        <Row title="额外可写" k="sandbox.allowWrite" stack>
          <ListEditor items={sb.allowWrite} onChange={(v) => put("allowWrite", v, true)} placeholder="~/.cache" />
        </Row>
        <Row title="禁止写入" k="sandbox.denyWrite" stack>
          <ListEditor items={sb.denyWrite} onChange={(v) => put("denyWrite", v, true)} placeholder=".git/hooks" />
        </Row>
        <Row title="禁止读取" k="sandbox.denyRead" stack>
          <ListEditor items={sb.denyRead} onChange={(v) => put("denyRead", v, true)} placeholder="~/.ssh" />
        </Row>
        <Row title="禁止读取里的例外" hint="在禁止读取的目录里放开个别路径" k="sandbox.allowRead" stack>
          <ListEditor items={sb.allowRead} onChange={(v) => put("allowRead", v, true)} placeholder="~/.ssh/known_hosts" empty="没有" />
        </Row>
      </Group>
      <Group title="网络" description="不在允许列表里的域名会被代理拒绝。">
        <Row title="允许的域名" hint="支持 *.example.com 通配" k="sandbox.allowedDomains" stack>
          <ListEditor items={sb.allowedDomains} onChange={(v) => put("allowedDomains", v, true)} placeholder="pypi.org" />
        </Row>
        <Row title="拒绝的域名" hint="优先于允许列表" k="sandbox.deniedDomains" stack>
          <ListEditor items={sb.deniedDomains} onChange={(v) => put("deniedDomains", v, true)} placeholder="metadata.google.internal" empty="没有" />
        </Row>
        <Row title="允许监听本地端口" hint="跑开发服务器、测试里起本地 HTTP 服务时需要" k="sandbox.allowLocalBinding">
          <Switch checked={sb.allowLocalBinding} onChange={(v) => put("allowLocalBinding", v)} />
        </Row>
        <Row title="允许的 Unix socket" hint="比如 Docker、ssh-agent 的 socket" k="sandbox.allowUnixSockets" stack>
          <ListEditor items={sb.allowUnixSockets} onChange={(v) => put("allowUnixSockets", v, true)} placeholder="/var/run/docker.sock" empty="没有" />
        </Row>
        <Row title="允许所有 Unix socket" k="sandbox.allowAllUnixSockets">
          <Switch checked={sb.allowAllUnixSockets} onChange={(v) => put("allowAllUnixSockets", v)} />
        </Row>
      </Group>
    </>
  );
}

/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */

export function EnvPage() {
  const agent = useAgent();
  const writeScope = useSettings((s) => s.writeScope);
  const set = useSetting();
  const workspaces = useWorkspaces((s) => s.workspaces);
  const runtime = useWorkspaces((s) => s.runtime);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  return (
    <>
      <PageTitle title="环境与凭据" description="传给 Agent 进程和它启动的命令的环境变量。父进程里已有的凭据优先，项目配置改不了它们。" />
      <Group title="环境变量" description="对应 settings.json 的 env。值里可以用 ${VAR} 引用其他变量；配置文件里的密钥在这里显示为 [redacted]。">
        <div className="py-2">
          {agent.env.map((e) => (
            <div key={`${e.scope}-${e.key}`} className="group flex h-10 items-center gap-3 border-b border-line last:border-b-0">
              <span className="w-[260px] truncate font-mono text-[12.5px] text-fg">{e.key}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg-2">{e.value}</span>
              <ScopeTag scope={e.scope} />
              <IconButton
                size="sm"
                className="opacity-0 group-hover:opacity-100"
                onClick={() => set(["env"], (a) => ({ ...a, env: a.env.filter((x) => x !== e) }))}
                aria-label="删除"
              >
                <X />
              </IconButton>
            </div>
          ))}
          <form
            className="mt-2 flex items-center gap-2"
            onSubmit={(ev) => {
              ev.preventDefault();
              const name = key.trim();
              if (!name) return;
              set(["env"], (a) => ({
                ...a,
                env: [...a.env.filter((x) => !(x.key === name && x.scope === writeScope)), { key: name, value, scope: writeScope }],
              }));
              setKey("");
              setValue("");
            }}
          >
            <TextInput value={key} onChange={(v) => setKey(v.toUpperCase())} placeholder="NAME" mono width={260} />
            <TextInput value={value} onChange={setValue} placeholder="值" mono />
            <Button type="submit" size="sm" variant="secondary">
              添加
            </Button>
          </form>
        </div>
      </Group>
      <Group title="API Key 辅助命令" description="每次请求 Anthropic 前运行这个命令，用它的输出作为密钥。适合公司的短期令牌。">
        <Row title="命令" k="apiKeyHelper" stack>
          <Draft
            value={agent.apiKeyHelper}
            onCommit={(apiKeyHelper) => set(["apiKeyHelper"], (a) => ({ ...a, apiKeyHelper }))}
            placeholder="~/bin/get-anthropic-token"
            mono
          />
        </Row>
      </Group>
      <Group
        title="受信任的工作区"
        description="受信任后，项目里的设置、.env、Hook、MCP 服务器和插件命令才会生效。记录在 ~/.easy-agent 下，修改后会重启这个工作区的 Agent 进程。"
      >
        <div className="py-2">
          {workspaces.map((w) => {
            const status = runtime[w.id]?.status;
            const trusted = status?.state === "ready" ? status.init.workspace.projectTrusted : undefined;
            const sessionOnly = status?.state === "ready" && status.trust === "session";
            return (
              <div key={w.id} className="flex h-10 items-center gap-3 border-b border-line last:border-b-0">
                {trusted ? <ShieldCheck className="size-4 text-success" /> : <ShieldAlert className="size-4 text-warning" />}
                <span className="flex-1 truncate font-mono text-[12.5px] text-fg">{w.path}</span>
                <span className="text-[12px] text-fg-3">
                  {trusted === undefined ? "Agent 未启动" : sessionOnly ? "本次信任" : trusted ? "已信任" : "未信任"}
                </span>
                {trusted && !sessionOnly ? (
                  <Button size="sm" variant="danger" onClick={() => void setWorkspaceTrust(w.id, false)}>
                    撤销
                  </Button>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => void setWorkspaceTrust(w.id, true)}>
                    始终信任
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </Group>
    </>
  );
}

/* ------------------------------------------------------------------ */

export function DataPage() {
  const agent = useAgent();
  const set = useSetting();
  return (
    <>
      <PageTitle title="会话与存储" description="会话记录、文件检查点和计划都存在本机的 ~/.easy-agent 里，不会上传。" />
      <div className="mb-7 grid grid-cols-3 gap-2.5">
        {[
          { label: "会话记录", path: "~/.easy-agent/projects/" },
          { label: "文件检查点", path: "~/.easy-agent/file-history/" },
          { label: "插件缓存", path: "~/.easy-agent/plugins/" },
        ].map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => void desktop.app.openPath(s.path)}
            className="rounded-xl border border-line bg-canvas p-3.5 text-left transition-colors hover:border-line-strong"
          >
            <div className="flex items-center gap-1.5 text-[11.5px] text-fg-3">
              <HardDrive className="size-3" />
              {s.label}
            </div>
            {/* TODO: sizes and counts need the Agent to report storage use. */}
            <div className="mt-1 text-[13px] font-medium text-fg">在访达中打开</div>
            <div className="mt-0.5 truncate font-mono text-[10.5px] text-fg-4">{s.path}</div>
          </button>
        ))}
      </div>
      <Group>
        <Row title="文件检查点" hint="Agent 改文件前先备份，之后可以用回退撤销改动" k="checkpointingEnabled">
          <Switch
            checked={agent.checkpointingEnabled}
            onChange={(checkpointingEnabled) => set(["checkpointingEnabled"], (a) => ({ ...a, checkpointingEnabled }))}
          />
        </Row>
        <Row title="自动清理" hint="超过这个天数的会话记录会被删除；设成 0 就不保存会话" k="cleanupPeriodDays">
          <Segmented
            value={agent.cleanupPeriodDays}
            onChange={(cleanupPeriodDays) => set(["cleanupPeriodDays"], (a) => ({ ...a, cleanupPeriodDays }))}
            options={[
              { value: 7, label: "7 天" },
              { value: 30, label: "30 天" },
              { value: 90, label: "90 天" },
              { value: 365, label: "1 年" },
            ]}
          />
        </Row>
      </Group>
      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => void desktop.app.openPath("~/.easy-agent")}>
          <FolderOpen />
          打开数据目录
        </Button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */

const SHORTCUTS: [string, string[][]][] = [
  [
    "全局",
    [
      ["命令面板", [MOD, "K"]],
      ["新建会话", [MOD, "N"]],
      ["自定义", [MOD, ";"]],
      ["设置", [MOD, ","]],
      ["收起侧边栏", [MOD, "B"]],
      ["详情面板", [MOD, "J"]],
      ["切换权限模式", [MOD, "."]],
    ].map(([a, b]) => [a as string, ...(b as string[])]),
  ],
  [
    "输入框",
    [
      ["发送", ["↵"]],
      ["换行", ["⇧", "↵"]],
      ["切换权限模式", ["⇧", "Tab"]],
      ["命令和技能", ["/"]],
      ["引用文件", ["@"]],
      ["中断", ["Esc"]],
    ].map(([a, b]) => [a as string, ...(b as string[])]),
  ],
  [
    "确认请求",
    [
      ["允许一次", ["1"]],
      ["总是允许", ["2"]],
      ["拒绝", ["3"]],
      ["批准计划", ["↵"]],
    ].map(([a, b]) => [a as string, ...(b as string[])]),
  ],
];

export function ShortcutsPage() {
  return (
    <>
      <PageTitle title="快捷键" />
      {SHORTCUTS.map(([group, items]) => (
        <Group key={group} title={group}>
          {items.map(([label, ...keys]) => (
            <div key={label} className="flex h-10 items-center justify-between border-b border-line last:border-b-0">
              <span className="text-[13px] text-fg-2">{label}</span>
              <span className="flex gap-1">
                {keys.map((k) => (
                  <Kbd key={k} className="h-[22px] min-w-[22px] text-[11.5px]">
                    {k}
                  </Kbd>
                ))}
              </span>
            </div>
          ))}
        </Group>
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ */

export function AboutPage() {
  const info = useUi((s) => s.appInfo);
  const workspaceId = useWorkspaces((s) => s.activeId) ?? undefined;
  const status = useRuntime(workspaceId).status;
  const agentVersion = status.state === "ready" ? status.init.serverInfo.version : "未启动";
  return (
    <div className="flex flex-col items-center py-10 text-center">
      <div className="mb-4 flex size-16 items-center justify-center rounded-[19px] bg-[linear-gradient(145deg,var(--accent),color-mix(in_oklab,var(--accent)_55%,black))] shadow-[inset_0_1px_0_rgb(255_255_255/0.3)]">
        <svg viewBox="0 0 32 32" className="size-9" fill="none" aria-hidden>
          <path d="M9.5 22 16 8.5 22.5 22M12.3 17.2h7.4" stroke="white" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <div className="text-[19px] font-semibold tracking-[-0.02em] text-fg">Easy Agent</div>
      <div className="mt-1 text-[12.5px] text-fg-3">
        桌面端 {info?.version ?? "–"} · Agent 核心 eagent {agentVersion} · RPC 协议 v1
      </div>
      <div className="mt-5 flex gap-2">
        {/* TODO(M7): updates; TODO: diagnostics need a doctor call that does not depend on a session. */}
        <Button variant="secondary" size="sm" disabled>
          检查更新
        </Button>
        <Button variant="secondary" size="sm" disabled>
          运行诊断
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void desktop.app.openExternal("https://github.com/ConardLi/easy-agent")}>
          <Globe />
          GitHub
        </Button>
      </div>
      <div className="mt-8 grid w-full max-w-[420px] grid-cols-2 gap-2 text-left">
        {[
          ["运行时", info ? `Electron ${info.versions.electron} · Node ${info.versions.node}` : "–"],
          ["沙箱", isMac ? "sandbox-exec" : "bubblewrap"],
          ["配置目录", "~/.easy-agent"],
          ["更新通道", "稳定版"],
        ].map(([k, v]) => (
          <div key={k} className="rounded-xl border border-line bg-canvas px-3 py-2.5">
            <div className="text-[11.5px] text-fg-3">{k}</div>
            <div className="mt-0.5 text-[12.5px] text-fg">{v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
