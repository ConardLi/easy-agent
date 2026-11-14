import { Bot, ClipboardList, FileText, Globe, ListTodo, Puzzle, RotateCcw, SquareTerminal, Users, Wrench } from "lucide-react";
import { useState } from "react";
import type { ToolInventoryItem } from "../../../shared/agent";
import { Button, cn, Tooltip } from "../../design/primitives";
import { changeWorkspaceAgent } from "../../state/agents";
import { tokens } from "../../lib/format";
import { useWorkspaceData } from "../../state/customize";
import { applySelection, offByAgent, setKey } from "../agents/model";
import { BUILTIN_TOOLS, type ToolGroup, unavailableReason } from "./model";
import { AgentSwitch, AgentTarget, Chips, DetailDrawer, Field, ItemRow, PageHeader, Section, Stat, TokenTag } from "./shared";

const GROUP_ICON: Record<ToolGroup, typeof FileText> = {
  文件: FileText,
  执行: SquareTerminal,
  网络: Globe,
  协作: Bot,
  规划: ClipboardList,
  任务: ListTodo,
  团队: Users,
  扩展: Puzzle,
};

const OFF_EFFECT: Partial<Record<string, string>> = {
  Bash: "关闭后 Agent 不能执行任何命令，跑测试、装依赖、用 git 都要你自己来。",
  Edit: "关闭后 Agent 只能用 Write 整个覆盖文件，改动会变得很粗。",
  Agent: "关闭后不能派出子 Agent，探索和并行任务都在主会话里完成，上下文涨得更快。",
  Skill: "关闭后技能清单也不再发送，技能只能由你用 /名称 手动触发。",
  ToolSearch: "关闭后延迟加载的 MCP 工具就调用不了，需要把 MCP 改成全部加载。",
  TodoWrite: "关闭后右侧的任务清单不会再更新。",
  AskUserQuestion: "关闭后 Agent 遇到取舍会自己决定，或者用普通文字问你。",
  ExitPlanMode: "关闭后计划模式无法提交计划，只能由你手动退出。",
};

const ORDER: ToolGroup[] = ["文件", "执行", "网络", "协作", "规划", "团队", "扩展", "任务"];

interface ToolRow {
  item: ToolInventoryItem;
  group: ToolGroup;
  description: string;
  /** Sent in full with every request. */
  perTurn: number;
  /** The Agent leaves it out (`tools.include` / `tools.exclude`); the switch turns it back on. */
  off: boolean;
  unavailable?: string;
}

function toRow(item: ToolInventoryItem): ToolRow {
  const known = BUILTIN_TOOLS[item.name];
  return {
    item,
    group: known?.group ?? "扩展",
    description: known?.description ?? item.description,
    perTurn: item.enabled && !item.deferred ? item.schema.value : 0,
    off: offByAgent("tools", item.reason),
    ...(item.enabled || offByAgent("tools", item.reason) ? {} : { unavailable: unavailableReason(item.name) }),
  };
}

/** Write the tool lists of the workspace's Agent; `changes` turns tools on or off. */
const setTools = (changes: [string, boolean][], message: (agent: string) => string) =>
  void changeWorkspaceAgent((spec, resolved) => applySelection(spec, resolved, "tools", changes), { message });

export function ToolsPage({ query }: { query: string }) {
  const { inventory, config } = useWorkspaceData();
  const [selected, setSelected] = useState<string | null>(null);

  const all = (inventory?.tools ?? []).filter((t) => !t.mcpServer).map(toRow);
  const rows = all.filter((t) => !query || `${t.item.name} ${t.description}`.toLowerCase().includes(query.toLowerCase()));
  const available = all.filter((t) => !t.unavailable && !t.off);
  const usable = all.filter((t) => !t.unavailable);
  const perTurn = available.reduce((n, t) => n + t.perTurn, 0);
  const tool = all.find((t) => t.item.name === selected);
  const rules = (["allow", "ask", "deny"] as const).flatMap((effect) =>
    ((config?.effective[effect]?.value ?? []) as string[]).map((rule) => ({ effect, rule })),
  );
  const rulesFor = (name: string) => rules.filter((r) => r.rule === name || r.rule.startsWith(`${name}(`)).map((r) => `${r.effect} ${r.rule}`);

  return (
    <>
      <PageHeader
        icon={<Wrench />}
        title="工具"
        en="Tools"
        description="Agent 内置的工具。每个启用的工具每轮都要发送完整定义；用不到的关掉，既省上下文，模型也少一个选项。关掉的工具模型看不到，也调用不了。"
        actions={
          <>
            <AgentTarget tab="tools" />
            <Tooltip content="删掉这个 Agent 自己的 tools.include 和 tools.exclude，回到继承的工具开关">
              <span>
                <Button
                  variant="secondary"
                  onClick={() =>
                    void changeWorkspaceAgent((spec) => setKey(setKey(spec, "tools.include", undefined), "tools.exclude", undefined), {
                      message: (agent) => `已恢复 Agent「${agent}」的工具开关`,
                    })
                  }
                >
                  <RotateCcw />
                  恢复默认
                </Button>
              </span>
            </Tooltip>
          </>
        }
      />

      <div className="mb-5 grid grid-cols-3 gap-2.5">
        <Stat label="已启用" value={`${available.length} / ${all.length}`} sub={`${all.length - usable.length} 个当前不可用`} />
        <Stat label="每轮占用" value={`${tokens(perTurn)} tokens`} sub="工具定义随每个请求发送" />
        <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
          <div className="text-[11px] text-fg-3">快速设置</div>
          <div className="mt-1.5 flex gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setTools(
                  usable.map((t) => [t.item.name, t.item.readOnly]),
                  (agent) => `Agent「${agent}」只保留只读工具`,
                )
              }
            >
              只读
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setTools(
                  usable.filter((t) => t.off).map((t) => [t.item.name, true]),
                  (agent) => `Agent「${agent}」的工具已全部打开`,
                )
              }
            >
              全部启用
            </Button>
          </div>
        </div>
      </div>

      {ORDER.map((group) => {
        const items = rows.filter((t) => t.group === group);
        if (items.length === 0) return null;
        const Icon = GROUP_ICON[group];
        const on = items.filter((t) => !t.unavailable && !t.off);
        return (
          <Section key={group} title={group} meta={`${on.length}/${items.length} · ${tokens(on.reduce((n, t) => n + t.perTurn, 0))} tokens`}>
            {items.map((t) => (
              <ItemRow
                key={t.item.name}
                selected={selected === t.item.name}
                onClick={() => setSelected(t.item.name)}
                dimmed={!!t.unavailable || t.off}
                icon={<Icon />}
                title={<span className="font-mono">{t.item.name}</span>}
                badges={
                  <>
                    <span
                      className={cn(
                        "rounded-[5px] px-1.5 text-[10.5px] leading-[18px]",
                        t.item.readOnly ? "bg-surface-3 text-fg-3" : "bg-warning/12 text-warning",
                      )}
                    >
                      {t.item.readOnly ? "只读" : "会修改"}
                    </span>
                    {t.item.deferred && !t.unavailable && <span className="text-[10.5px] text-fg-3">按需加载</span>}
                  </>
                }
                description={t.description}
                right={
                  <>
                    <TokenTag value={t.perTurn} per="/轮" />
                    {t.unavailable ? (
                      <span className="w-[86px] text-right text-[11px] text-fg-3">{t.unavailable}</span>
                    ) : (
                      <AgentSwitch kind="tools" name={t.item.name} checked={!t.off} />
                    )}
                  </>
                }
              />
            ))}
          </Section>
        );
      })}
      {rows.length === 0 && <div className="py-16 text-center text-[13px] text-fg-3">没有匹配的工具</div>}

      <DetailDrawer
        open={!!tool}
        onClose={() => setSelected(null)}
        title={tool && <span className="font-mono">{tool.item.name}</span>}
        subtitle={tool && `${tool.group} · ${tool.item.readOnly ? "只读" : "会修改文件或环境"}`}
      >
        {tool && (
          <>
            <p className="mb-4 text-[13px] leading-[1.6] text-fg-2">{tool.description}</p>
            <div className="mb-4 grid grid-cols-2 gap-2">
              <Stat
                label="定义大小"
                value={`${tool.item.schema.value.toLocaleString()} tokens`}
                sub={tool.item.deferred ? "按需加载，用到时才发送" : "每轮随请求发送"}
              />
              <Stat label="默认权限" value={tool.item.readOnly ? "免确认" : "需要确认"} sub={tool.item.readOnly ? "只读操作直接执行" : "默认模式下先问你"} />
            </div>
            {tool.unavailable && (
              <Field label="当前不可用">
                <div className="text-[13px] text-fg-2">{tool.unavailable}</div>
              </Field>
            )}
            {OFF_EFFECT[tool.item.name] && (
              <Field label="关闭后会怎样">
                <div className="rounded-lg border border-line bg-surface px-3 py-2.5 text-[12.5px] leading-[1.6] text-fg-2">{OFF_EFFECT[tool.item.name]}</div>
              </Field>
            )}
            <Field label="相关的权限规则" hint="关掉工具和写 deny 规则不一样：deny 规则拦住调用，工具定义仍然会发送；关掉工具则两者都没有。">
              {rulesFor(tool.item.name).length > 0 ? (
                <Chips items={rulesFor(tool.item.name)} />
              ) : (
                <div className="text-[12.5px] text-fg-3">没有针对这个工具的规则</div>
              )}
            </Field>
            <Field label="开关">
              <div className="flex items-center justify-between rounded-lg border border-line bg-surface px-3 py-2">
                <span className="text-[12.5px] text-fg-2">{tool.unavailable ?? (tool.off ? "这个 Agent 关掉了它" : "打开")}</span>
                {!tool.unavailable && <AgentSwitch kind="tools" name={tool.item.name} checked={!tool.off} />}
              </div>
            </Field>
          </>
        )}
      </DetailDrawer>
    </>
  );
}
