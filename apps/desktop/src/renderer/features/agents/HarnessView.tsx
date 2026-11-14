import {
  AlertTriangle,
  Bot,
  Copy,
  FileText,
  Info,
  Lock,
  MoreHorizontal,
  PenLine,
  Plus,
  RefreshCw,
  RotateCcw,
  SquarePen,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import type { HarnessSummary, ResolvedHarnessValue } from "../../../shared/agent";
import { Button, cn, IconButton, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Segmented, Switch, Tooltip } from "../../design/primitives";
import { newSession } from "../../state/actions";
import { type AgentData, exportAgent, restartStaleAgents, setProjectDefault, useAgents, writeSpec } from "../../state/agents";
import { useSessions } from "../../state/sessions";
import { useActiveWorkspace } from "../../state/workspaces";
import { BUILTIN_TOOLS, reasonText, type ToolGroup, unavailableReason } from "../customize/model";
import { NumberInput } from "../settings/controls";
import type { AgentDialog } from "./AgentDialogs";
import {
  CONTEXT_LABEL,
  formatValue,
  HARNESS_TABS,
  lockedBy,
  OTHER_KEYS,
  PROMPTS_DIR,
  SECTION_HINT,
  SECTION_LABEL,
  type SelectionKind,
  selectionState,
  SETTINGS_FILE,
  setKey,
  sourceText,
  sourceTitle,
  specSections,
  toggleSection,
  toggleSelection,
} from "./model";

/** Where a value comes from: built in, this Agent, an Agent it extends, or a layer above it. */
function SourceTag({ v, agent, path }: { v: Pick<ResolvedHarnessValue, "source" | "detail">; agent: string; path: string }) {
  const locked = lockedBy(v);
  return (
    <Tooltip content={sourceTitle(v, path)}>
      <span
        data-source={v.source}
        className={cn(
          "inline-flex h-[18px] shrink-0 items-center gap-1 rounded-[5px] px-1.5 text-[10.5px] font-medium",
          v.source === "built-in" && "text-fg-4",
          v.source === "harness" && v.detail === agent && "bg-accent-soft text-accent",
          v.source === "harness" && v.detail !== agent && "bg-info/10 text-info",
          v.source === "user" && "bg-info/10 text-info",
          locked && v.source === "policy" && "bg-danger/10 text-danger",
          locked && v.source !== "policy" && "bg-warning/12 text-warning",
        )}
      >
        {locked && <Lock className="size-2.5" />}
        {sourceText(v, agent)}
      </span>
    </Tooltip>
  );
}

function Row({
  title,
  name,
  hint,
  tag,
  reason,
  locked,
  children,
  dimmed,
  testId,
}: {
  title: ReactNode;
  name?: string;
  hint?: ReactNode;
  tag?: ReactNode;
  reason?: string;
  locked?: string;
  children?: ReactNode;
  dimmed?: boolean;
  testId?: string;
}) {
  return (
    <div data-row={testId} className="group/row flex items-center justify-between gap-6 border-b border-line py-3 last:border-b-0">
      <div className={cn("min-w-0", dimmed && "opacity-60")}>
        <div className="flex items-center gap-2">
          <span className="text-[13.5px] font-medium text-fg">{title}</span>
          {name && <span className="font-mono text-[11px] text-fg-3">{name}</span>}
          {tag}
        </div>
        {hint && <div className="mt-0.5 text-[12.5px] leading-[1.55] text-fg-3">{hint}</div>}
        {reason && <div className="mt-0.5 text-[12px] text-fg-3">{reason}</div>}
        {locked && (
          <div className="mt-1 flex items-center gap-1 text-[12px] text-warning">
            <Lock className="size-3" />
            {locked}
          </div>
        )}
      </div>
      {children && (
        <div className={cn("shrink-0", locked && "pointer-events-none opacity-45")} aria-disabled={locked ? true : undefined}>
          {children}
        </div>
      )}
    </div>
  );
}

function Group({ title, description, action, children }: { title: string; description?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-7">
      <div className="mb-2 flex items-end gap-2 px-1">
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
          {description && <p className="mt-0.5 text-[12px] leading-[1.55] text-fg-3">{description}</p>}
        </div>
        {action}
      </div>
      <div className="rounded-xl border border-line bg-canvas px-4">{children}</div>
    </section>
  );
}

/** A number written when the field loses focus, not on every keystroke. */
function DraftNumber({ value, onCommit, suffix, scale = 1 }: { value: number; onCommit: (v: number) => void; suffix: string; scale?: number }) {
  const shown = Math.round(value * scale);
  const [draft, setDraft] = useState(shown);
  const [seen, setSeen] = useState(shown);
  if (seen !== shown) {
    setSeen(shown);
    setDraft(shown);
  }
  return <NumberInput value={draft} min={1} suffix={suffix} onChange={setDraft} onBlur={() => draft !== shown && onCommit(draft / scale)} />;
}

const NO_AGENTS: string[] = [];

const TOOL_GROUPS: ToolGroup[] = ["文件", "执行", "网络", "协作", "规划", "团队", "扩展", "任务"];

export function HarnessView({ summary, data, onDialog }: { summary: HarnessSummary; data: AgentData; onDialog: (d: AgentDialog) => void }) {
  const tab = useAgents((s) => s.tab);
  const openAgents = useAgents((s) => s.openAgents);
  const workspace = useActiveWorkspace();
  const stale = useAgents((s) => (workspace ? s.staleMcp[workspace.id] : undefined)) ?? NO_AGENTS;
  const setDraft = useSessions((s) => s.setDraft);
  const { resolved, inventory } = data;
  const name = summary.name;
  const broken = summary.errors.length > 0 || !inventory;
  const v = (path: string): ResolvedHarnessValue => resolved.values[path] ?? { source: "built-in", applied: true, contributions: [], ignored: [] };

  const write = (path: string, value: unknown) => void writeSpec(name, (spec) => setKey(spec, path, value), { message: `已写入 harnesses.${name}.${path}` });
  const select = (kind: SelectionKind, item: string, on: boolean) =>
    void writeSpec(name, (spec, current) => toggleSelection(spec, current.resolved, kind, item, on), {
      mcp: kind === "mcpServers",
      message: `已写入 harnesses.${name}.${kind}`,
    });

  const chain = [...resolved.chain].reverse();
  if (name !== "default" && !chain.includes("default")) chain.push("default");
  if (!chain.includes(name)) chain.unshift(name);

  const tools = (inventory?.tools ?? []).filter((t) => !t.mcpServer);
  const skills = [...new Map((inventory?.skills ?? []).map((s) => [s.name, s])).values()];
  const subAgents = inventory?.agents ?? [];
  const servers = inventory?.mcpServers ?? [];
  const count = (kind: SelectionKind, names: string[]) => `${names.filter((n) => selectionState(resolved, kind, n).on).length}/${names.length}`;
  const counts: Partial<Record<string, string>> = inventory
    ? {
        tools: count(
          "tools",
          tools.map((t) => t.name),
        ),
        skills: count(
          "skills",
          skills.map((s) => s.name),
        ),
        agents: count(
          "agents",
          subAgents.map((a) => a.name),
        ),
        mcp: count(
          "mcpServers",
          servers.map((m) => m.name),
        ),
      }
    : {};

  const selectionRow = (
    kind: SelectionKind,
    item: { name: string; description: string; enabled: boolean; reason?: string },
    extra?: ReactNode,
    unavailable?: string,
  ) => {
    const st = selectionState(resolved, kind, item.name);
    const off = unavailable ?? (st.on && !item.enabled ? reasonText(item.reason) : undefined);
    return (
      <Row
        key={`${kind}:${item.name}`}
        testId={`${kind}:${item.name}`}
        title={<span className="font-mono text-[13px]">{item.name}</span>}
        hint={item.description}
        tag={st.from ? <SourceTag v={st.from} agent={name} path={`${kind}.${st.reason?.includes("include") ? "include" : "exclude"}`} /> : extra}
        reason={st.on ? off : st.reason}
        dimmed={!st.on || !!unavailable}
      >
        {unavailable && st.on ? (
          <span className="text-[12px] text-fg-4">不可用</span>
        ) : (
          <Switch checked={st.on} onChange={(on) => select(kind, item.name, on)} />
        )}
      </Row>
    );
  };

  const boolRow = (path: string, title: string, hint: string) => {
    const value = v(path);
    return (
      <Row key={path} testId={path} title={title} name={path} hint={hint} tag={<SourceTag v={value} agent={name} path={path} />} locked={lockedBy(value)}>
        <Switch checked={value.value !== false} onChange={(on) => write(path, on)} />
      </Row>
    );
  };
  const numberRow = (path: string, title: string, hint: string, suffix: string, scale = 1) => {
    const value = v(path);
    return (
      <Row key={path} testId={path} title={title} name={path} hint={hint} tag={<SourceTag v={value} agent={name} path={path} />} locked={lockedBy(value)}>
        {typeof value.value === "number" || value.value === undefined ? (
          <DraftNumber
            value={(value.value as number | undefined) ?? 0}
            scale={scale}
            suffix={suffix}
            onCommit={(n) => write(path, scale === 1 ? Math.round(n) : n)}
          />
        ) : null}
      </Row>
    );
  };
  const choiceRow = <T extends string>(path: string, title: string, hint: string, options: { value: T; label: string }[]) => {
    const value = v(path);
    return (
      <Row key={path} testId={path} title={title} name={path} hint={hint} tag={<SourceTag v={value} agent={name} path={path} />} locked={lockedBy(value)}>
        <Segmented value={value.value as T} options={options} onChange={(x) => write(path, x)} />
      </Row>
    );
  };

  const identity = inventory?.promptSections.find((s) => s.name === "identity");
  const identityValue = v("prompt.identity");
  const sections = specSections(resolved);
  const dynamic = (inventory?.promptSections ?? []).filter((s) => s.block === "dynamic");

  return (
    <div className="scroll-thin h-full overflow-y-auto" data-harness={name}>
      <div className="mx-auto max-w-[880px] px-8 pb-16 pt-7">
        <div className="mb-5 flex items-start gap-4">
          <span
            className={cn(
              "flex size-11 shrink-0 items-center justify-center rounded-[13px] border border-line bg-surface [&_svg]:size-5",
              broken ? "text-danger" : "text-accent",
            )}
          >
            <Bot />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-2 text-[20px] font-semibold tracking-[-0.02em] text-fg">
              {name}
              {summary.projectDefault && (
                <span className="inline-flex items-center gap-1 rounded-md bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium tracking-normal text-accent">
                  <Star className="size-3 fill-current" />
                  项目默认
                </span>
              )}
            </h2>
            <p className="mt-1 max-w-[620px] text-[13px] leading-[1.6] text-fg-2">
              {summary.builtIn ? "内置 Agent：Easy Agent 现在的全部行为" : (summary.description ?? "没有描述")}
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-fg-3">
              <span>继承链</span>
              {[...chain, "内置预设"].map((n, i) => (
                <span key={n} className="flex items-center gap-1.5">
                  {i > 0 && <span className="text-fg-4">→</span>}
                  <button
                    type="button"
                    disabled={n === "内置预设" || n === name}
                    onClick={() => openAgents(n)}
                    className={cn("font-mono", n !== name && n !== "内置预设" && "hover:text-fg hover:underline")}
                  >
                    {n}
                  </button>
                </span>
              ))}
              {summary.dependents.length > 0 && <span className="ml-2">被 {summary.dependents.join("、")} 继承</span>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 pt-1">
            <Button
              variant="primary"
              disabled={broken}
              onClick={() => {
                useAgents.getState().closeAgents();
                newSession();
                setDraft({ agent: summary.projectDefault ? undefined : name });
              }}
            >
              <SquarePen />
              用它新建会话
            </Button>
            {!summary.projectDefault && (
              <Button variant="outline" disabled={broken} onClick={() => void setProjectDefault(name)}>
                <Star />
                设为项目默认
              </Button>
            )}
            <Menu>
              <MenuTrigger asChild>
                <IconButton size="lg" aria-label="更多操作">
                  <MoreHorizontal />
                </IconButton>
              </MenuTrigger>
              <MenuContent align="end" className="w-[220px]">
                <MenuItem icon={<Copy />} onSelect={() => onDialog({ kind: "copy", from: name })}>
                  复制
                </MenuItem>
                {!summary.builtIn && (
                  <MenuItem icon={<PenLine />} onSelect={() => onDialog({ kind: "rename", name })}>
                    改名
                  </MenuItem>
                )}
                <MenuItem icon={<Upload />} onSelect={() => void exportAgent(name)}>
                  导出
                </MenuItem>
                <MenuSeparator />
                {summary.builtIn ? (
                  <MenuItem icon={<RotateCcw />} danger onSelect={() => onDialog({ kind: "reset" })}>
                    恢复默认
                  </MenuItem>
                ) : (
                  <MenuItem icon={<Trash2 />} danger onSelect={() => onDialog({ kind: "delete", name })}>
                    删除
                  </MenuItem>
                )}
              </MenuContent>
            </Menu>
          </div>
        </div>

        {broken && (
          <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-danger/30 bg-danger/[0.06] px-3.5 py-3 text-[12.5px] text-fg-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
            <div>
              <div className="font-medium text-fg">这个 Agent 解析不了，不能用来新建会话</div>
              <div className="mt-0.5">
                {summary.errors.join("；")}。改它的 extends，或者在 {SETTINGS_FILE} 里修好。
              </div>
            </div>
          </div>
        )}
        {summary.builtIn && (
          <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-line bg-surface/60 px-3.5 py-3 text-[12.5px] leading-[1.6] text-fg-2">
            <Info className="mt-0.5 size-4 shrink-0 text-fg-3" />
            <div>改 default 只记下和内置预设不一样的地方，存在 harnesses.default 里。内置预设升级后，没改过的项会自动跟着变；「恢复默认」会删掉这些改动。</div>
          </div>
        )}

        <div className="mb-6 flex gap-1 border-b border-line" role="tablist">
          {HARNESS_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => openAgents(name, t.id)}
              className={cn(
                "relative -mb-px flex h-9 items-center gap-1.5 border-b-2 px-2.5 text-[13px] font-medium transition-colors",
                tab === t.id ? "border-accent text-fg" : "border-transparent text-fg-3 hover:text-fg-2",
              )}
            >
              {t.label}
              {counts[t.id] && <span className="tabular text-[11px] font-normal text-fg-3">{counts[t.id]}</span>}
            </button>
          ))}
        </div>

        {broken ? null : tab === "prompt" ? (
          <>
            <Group title="身份" description="系统提示词最前面的一段，说明 Agent 是谁。改过的文字写进 prompts/ 目录下的文件。">
              <div className="py-3.5" data-row="prompt.identity">
                <div className="mb-2 flex items-center gap-2">
                  <SourceTag v={identityValue} agent={name} path="prompt.identity" />
                  {identity?.file && (
                    <span className="truncate font-mono text-[11px] text-fg-3">{identity.file.replace(/^.*\/\.easy-agent\//, "~/.easy-agent/")}</span>
                  )}
                  <span className="flex-1" />
                  {identityValue.source === "harness" && identityValue.detail === name && (
                    <Button size="sm" variant="ghost" onClick={() => write("prompt.identity", undefined)}>
                      <RotateCcw />
                      {name === "default" ? "用内置的" : "用继承的"}
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => onDialog({ kind: "prompt", agent: name, section: "identity" })}>
                    <PenLine />
                    编辑
                  </Button>
                </div>
                <p className="line-clamp-3 whitespace-pre-wrap rounded-lg bg-surface px-3 py-2.5 text-[12.5px] leading-[1.6] text-fg-2">
                  {identity?.text || <span className="text-fg-4">（空：不发送身份段）</span>}
                </p>
              </div>
            </Group>
            <Group
              title="提示词段"
              description="身份之后的各段，按顺序拼进系统提示词。关掉的段不发送。"
              action={
                <Button size="sm" variant="ghost" onClick={() => onDialog({ kind: "prompt", agent: name, section: null })}>
                  <Plus />
                  添加提示词段
                </Button>
              }
            >
              <Row
                title="编码指令"
                name="instructions"
                hint={SECTION_HINT.instructions}
                tag={<SourceTag v={{ source: "built-in" }} agent={name} path="instructions" />}
              />
              {dynamic.map((section) => {
                const added = section.source !== "built-in";
                const setting = sections[section.name];
                const replaced = !added && section.text !== undefined;
                const value = v("prompt.sections");
                if (added) {
                  return (
                    <Row
                      key={section.name}
                      testId={`prompt_section:${section.name}`}
                      title={<span className="font-mono text-[13px]">{section.name}</span>}
                      hint={<span className="line-clamp-1">{section.text}</span>}
                      tag={
                        <span className="rounded-[5px] bg-accent-soft px-1.5 text-[10.5px] font-medium leading-[18px] text-accent">
                          新加的段{section.after ? ` · 在 ${section.after} 后面` : ""}
                        </span>
                      }
                    >
                      <div className="flex items-center gap-1">
                        <IconButton
                          size="sm"
                          onClick={() => onDialog({ kind: "prompt", agent: name, section: section.name })}
                          aria-label={`编辑 ${section.name}`}
                        >
                          <FileText />
                        </IconButton>
                        <IconButton
                          size="sm"
                          onClick={() => {
                            const { [section.name]: _, ...rest } = sections;
                            write("prompt.sections", rest);
                          }}
                          aria-label={`删除 ${section.name}`}
                        >
                          <X />
                        </IconButton>
                      </div>
                    </Row>
                  );
                }
                return (
                  <Row
                    key={section.name}
                    testId={`prompt_section:${section.name}`}
                    title={SECTION_LABEL[section.name] ?? section.name}
                    name={section.name}
                    hint={replaced ? <span className="line-clamp-1">改成：{section.text}</span> : (SECTION_HINT[section.name] ?? section.description)}
                    tag={setting !== undefined ? <SourceTag v={value} agent={name} path="prompt.sections" /> : undefined}
                    reason={section.enabled ? undefined : setting === false ? undefined : reasonText(section.reason)}
                    dimmed={!section.enabled}
                  >
                    <div className="flex items-center gap-2">
                      <Tooltip content="改这一段的文字">
                        <IconButton
                          size="sm"
                          onClick={() => onDialog({ kind: "prompt", agent: name, section: section.name })}
                          aria-label={`编辑 ${section.name}`}
                        >
                          <PenLine />
                        </IconButton>
                      </Tooltip>
                      <Switch checked={setting !== false} onChange={(on) => write("prompt.sections", toggleSection(resolved, section.name, on))} />
                    </div>
                  </Row>
                );
              })}
            </Group>
            <p className="px-1 text-[11.5px] text-fg-3">提示词文件放在 {PROMPTS_DIR}，也可以直接用编辑器改 Markdown，下一次请求就会用上。</p>
          </>
        ) : tab === "context" ? (
          <Group title="上下文来源" description="系统提示词里动态加进来的内容。关掉以后对应的内容不再发送。">
            {(inventory?.contextSources ?? []).map((c) =>
              boolRow(c.specKey, CONTEXT_LABEL[c.name]?.label ?? c.name, CONTEXT_LABEL[c.name]?.hint ?? c.description),
            )}
          </Group>
        ) : tab === "tools" ? (
          <>
            {TOOL_GROUPS.map((group) => {
              const items = tools.filter((t) => (BUILTIN_TOOLS[t.name]?.group ?? "扩展") === group);
              if (items.length === 0) return null;
              return (
                <Group key={group} title={group}>
                  {items.map((t) => {
                    const st = selectionState(resolved, "tools", t.name);
                    return selectionRow(
                      "tools",
                      { ...t, description: BUILTIN_TOOLS[t.name]?.description ?? t.description },
                      undefined,
                      st.on && !t.enabled ? unavailableReason(t.name) : undefined,
                    );
                  })}
                </Group>
              );
            })}
            <p className="px-1 text-[11.5px] text-fg-3">MCP 服务器的工具在「MCP」里按服务器开关。关掉的工具模型看不到，也调用不了。</p>
          </>
        ) : tab === "skills" ? (
          <Group title="技能" description="关掉的技能不进技能清单，模型和 /名称 都调用不了。安装和删除在「自定义」里。">
            {skills.length === 0 ? <p className="py-4 text-[12.5px] text-fg-3">还没有技能</p> : skills.map((s) => selectionRow("skills", s))}
          </Group>
        ) : tab === "agents" ? (
          <Group title="子 Agent" description="Agent 工具能派出的子 Agent。子 Agent 能用的工具不会超过这个 Agent。">
            {subAgents.map((a) => selectionRow("agents", a))}
          </Group>
        ) : tab === "mcp" ? (
          <>
            {stale.length > 0 && (
              <div className="mb-4 flex items-center gap-2.5 rounded-xl border border-warning/30 bg-warning/[0.07] px-3.5 py-2.5 text-[12.5px] text-fg-2">
                <AlertTriangle className="size-4 shrink-0 text-warning" />
                <span className="flex-1">{stale.join("、")} 的进程还在用改之前的 MCP 设置，重启后生效。重启会打断正在进行的回合。</span>
                <Button size="sm" variant="outline" onClick={() => void restartStaleAgents()}>
                  <RefreshCw />
                  重启这些进程
                </Button>
              </div>
            )}
            <Group title="MCP 服务器" description="关掉的服务器不会启动，它的工具也不会出现。改动在这个 Agent 的进程重启后生效。">
              {servers.length === 0 ? (
                <p className="py-4 text-[12.5px] text-fg-3">还没有配置 MCP 服务器</p>
              ) : (
                servers.map((m) =>
                  selectionRow(
                    "mcpServers",
                    { ...m, description: m.command ?? m.url ?? m.transport },
                    <span className="text-[11px] text-fg-3">{m.tools.length} 个工具</span>,
                  ),
                )
              )}
            </Group>
          </>
        ) : tab === "compaction" ? (
          <Group title="上下文压缩" description="对话快占满上下文窗口时，把较早的内容整理成摘要。">
            {boolRow("compaction.auto", "自动压缩", "超过阈值时自动压缩，不用手动 /compact")}
            {numberRow("compaction.autoThreshold", "压缩阈值", "占到上下文窗口的这个比例时开始压缩", "%", 100)}
            {boolRow("compaction.microcompact", "清理旧的工具结果", "每轮开始前清掉较早的工具输出和图片")}
            {numberRow("compaction.keepRecentMessages", "保留最近的消息", "压缩时原样保留的最近消息数", "条")}
          </Group>
        ) : tab === "features" ? (
          <>
            <Group title="执行">
              {choiceRow("features.tasks", "任务系统", "任务图可以跨会话保存、带依赖；待办清单只在当前会话里有效", [
                { value: "task", label: "任务图" },
                { value: "todo", label: "待办清单" },
              ])}
              {boolRow("features.agentTeams", "Agent Teams", "允许组建团队、派出有名字的队友并互相发消息")}
              {boolRow("features.autoModeClassifier", "Auto 模式分类器", "规则判定不了的操作交给分类器；关掉就问你")}
              {numberRow("features.maxTurns", "工具轮数上限", "单次请求最多连续调用多少轮工具；没设时用前端的默认值", "轮")}
            </Group>
            <Group title="工具加载">
              {choiceRow("features.toolSearch", "ToolSearch", "工具多的时候先只给模型看名字，用到再加载定义", [
                { value: "off", label: "关闭" },
                { value: "auto", label: "自动" },
                { value: "on", label: "总是" },
              ])}
              {numberRow("features.toolSearchAutoThreshold", "自动启用的阈值", "工具定义超过上下文窗口的这个比例时启用", "%")}
            </Group>
            <Group title="推理">
              {boolRow("features.thinking", "扩展思考", "回答前先思考")}
              {numberRow("features.thinkingBudget", "思考预算", "固定的思考 token 数；没设时由模型决定", "tokens")}
              {choiceRow("features.effort", "推理强度", "模型支持时生效", [
                { value: "low", label: "低" },
                { value: "medium", label: "中" },
                { value: "high", label: "高" },
                { value: "max", label: "最高" },
              ])}
            </Group>
            <Group title="请求">
              {numberRow("features.maxRetries", "失败重试次数", "遇到限流、过载和网络错误时自动重试", "次")}
              {boolRow("features.promptCaching", "提示词缓存", "兼容接口不认 cache_control 或 prompt_cache_key 时关掉")}
              {boolRow("features.experimentalBetas", "实验性 beta 头", "Anthropic 接口上带实验功能的 beta 头；网关不认的时候关掉")}
            </Group>
          </>
        ) : (
          <Group title="其他设置" description={`这几项在这里只能查看，要改就编辑 ${SETTINGS_FILE} 里的 harnesses.${name}。`}>
            {OTHER_KEYS.filter((path) => resolved.values[path]).map((path) => {
              const value = v(path);
              return (
                <Row
                  key={path}
                  testId={path}
                  title={<span className="font-mono text-[13px]">{path}</span>}
                  tag={<SourceTag v={value} agent={name} path={path} />}
                  locked={lockedBy(value)}
                >
                  <span className="font-mono text-[12.5px] text-fg-2">{formatValue(value.value)}</span>
                </Row>
              );
            })}
          </Group>
        )}
      </div>
    </div>
  );
}
