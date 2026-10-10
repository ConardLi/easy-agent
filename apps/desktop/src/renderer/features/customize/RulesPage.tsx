import { Brain, FilePlus2, FileText, ScrollText, Wand2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { RuleInventoryItem } from "../../../shared/agent";
import { describeError } from "../../agent/client";
import { Button, cn, Menu, MenuContent, MenuItem, MenuTrigger, Switch, Tooltip } from "../../design/primitives";
import { desktop } from "../../lib/desktop";
import { tokens } from "../../lib/format";
import { SCOPE_FILE } from "../../lib/scopes";
import { newSession, sendMessage } from "../../state/actions";
import { loadInventory, sourceValues, useCustomize, useWorkspaceData, writeSetting } from "../../state/customize";
import { useUi } from "../../state/ui";
import { useActiveWorkspace } from "../../state/workspaces";
import { displayPath } from "./model";
import { DetailDrawer, Field, PageHeader, Stat, TokenTag, WriteScopePicker } from "./shared";

const KIND_LABEL: Record<RuleInventoryItem["scope"], string> = { global: "全局", ancestor: "上级目录", project: "项目", memory: "自动记忆" };
const GLOBAL_RULE = "~/.easy-agent/AGENT.md";

export function RulesPage({ query }: { query: string }) {
  const { inventory, config } = useWorkspaceData();
  const writeScope = useCustomize((s) => s.writeScope);
  const closeCustomize = useCustomize((s) => s.closeCustomize);
  const toast = useUi((s) => s.toast);
  const workspace = useActiveWorkspace();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState("");

  const all = inventory?.rules ?? [];
  const pathKey = all.map((r) => `${r.path}:${r.tokens.value}`).join("|");
  // Rule files are small and few; read them all for the first-line previews and the editor.
  useEffect(() => {
    if (!workspace) return;
    void Promise.all(all.map(async (r) => [r.id, r.path ? await desktop.customize.readText(workspace.id, r.path).catch(() => "") : ""] as const)).then(
      (entries) => setContents(Object.fromEntries(entries)),
    );
  }, [pathKey, workspace]);

  const rules = all.filter((r) => !query || `${r.path} ${contents[r.id] ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  const chain = rules.filter((r) => r.scope !== "memory");
  const memory = rules.filter((r) => r.scope === "memory");
  const loaded = rules.filter((r) => r.enabled);
  const hasProjectRule = all.some((r) => r.scope === "project" && r.enabled);
  const selected = all.find((r) => r.id === selectedId);

  useEffect(() => {
    if (selected) setDraft(contents[selected.id] ?? "");
  }, [selectedId, contents[selectedId ?? ""] === undefined]);

  const label = (r: RuleInventoryItem) => (r.path && workspace ? displayPath(r.path, workspace.path) : r.name);

  const runInit = async () => {
    closeCustomize();
    newSession();
    await sendMessage("/init");
  };

  /** Exclude a file by adding its path to `claudeMdExcludes`, or stop excluding it. */
  const setExcluded = async (rule: RuleInventoryItem, excluded: boolean) => {
    if (!rule.path) return;
    const current = (sourceValues(config, writeScope).claudeMdExcludes ?? []) as string[];
    const next = excluded ? [...new Set([...current, rule.path])] : current.filter((p) => p !== rule.path);
    if (next.length === current.length && !excluded) {
      toast(`${SCOPE_FILE[writeScope]} 里没有排除它，排除规则写在别的配置里`);
      return;
    }
    await writeSetting(
      writeScope,
      "claudeMdExcludes",
      next.length > 0 ? next : null,
      excluded ? `已在 ${SCOPE_FILE[writeScope]} 的 claudeMdExcludes 中加入 ${label(rule)}` : `已不再排除 ${label(rule)}`,
    );
  };

  /** Open a rule file, creating it with a heading when it does not exist yet. */
  const createFile = async (path: string, scope: "global" | "project") => {
    if (!workspace) return;
    const name = path.split("/").pop() ?? path;
    const find = (list: RuleInventoryItem[]) => list.find((r) => r.scope === scope && r.path?.endsWith(`/${name}`));
    const existing = find(all);
    if (existing) {
      setSelectedId(existing.id);
      return;
    }
    try {
      await desktop.customize.writeText(workspace.id, scope === "global" ? path : `${workspace.path}/${path}`, "# 规则\n\n");
      await loadInventory(workspace.id);
      const created = find(useCustomize.getState().inventories[workspace.id]?.rules ?? []);
      if (created) setSelectedId(created.id);
      toast(`已创建 ${path}`, "success");
    } catch (error) {
      toast(describeError(error), "danger");
    }
  };

  const save = async () => {
    if (!selected?.path || !workspace) return;
    try {
      await desktop.customize.writeText(workspace.id, selected.path, draft);
      setContents((c) => ({ ...c, [selected.id]: draft }));
      await loadInventory(workspace.id);
      toast(`已保存 ${label(selected)}，下一条消息起生效`, "success");
    } catch (error) {
      toast(describeError(error), "danger");
    }
  };

  const row = (rule: RuleInventoryItem, index: number, last: boolean) => (
    <div key={rule.id} className="relative flex gap-4">
      <div className="flex w-7 shrink-0 flex-col items-center">
        <span
          className={cn(
            "tabular z-10 mt-4 flex size-7 items-center justify-center rounded-full border text-[11.5px] font-semibold",
            rule.excluded ? "border-dashed border-line-strong bg-canvas text-fg-4" : "border-transparent bg-success/15 text-success",
          )}
        >
          {rule.scope === "memory" ? <Brain className="size-3.5" /> : index + 1}
        </span>
        {!last && <span className="-mb-4 w-px flex-1 bg-line" />}
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: the card holds a switch */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setSelectedId(rule.id)}
        onKeyDown={(e) => e.key === "Enter" && setSelectedId(rule.id)}
        className={cn(
          "mb-3 flex min-w-0 flex-1 cursor-default items-center gap-3 rounded-xl border px-4 py-3 transition-colors",
          selectedId === rule.id ? "border-accent-line bg-accent-softer" : "border-line bg-canvas hover:border-line-strong",
        )}
      >
        <FileText className={cn("size-4 shrink-0", rule.excluded ? "text-fg-4" : "text-fg-3")} />
        <div className={cn("min-w-0 flex-1", rule.excluded && "opacity-55")}>
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate font-mono text-[13px] font-medium text-fg" title={rule.path}>
              {label(rule)}
            </span>
            <span className="shrink-0 rounded-[5px] bg-surface-3 px-1.5 text-[10.5px] leading-[18px] text-fg-2">{KIND_LABEL[rule.scope]}</span>
            {rule.excluded && <span className="shrink-0 rounded-[5px] bg-surface-3 px-1.5 text-[10.5px] leading-[18px] text-fg-3">已排除</span>}
          </div>
          <div className="mt-0.5 truncate text-[12px] text-fg-3">
            {rule.lines} 行 · {(contents[rule.id] ?? "").split("\n").find((l) => l.trim() && !l.startsWith("#")) ?? KIND_LABEL[rule.scope]}
          </div>
        </div>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: keeps the switch from opening the editor */}
        <div className="flex items-center gap-3" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <TokenTag value={rule.excluded ? 0 : rule.tokens.value} per="/轮" />
          {rule.scope === "memory" ? <span className="w-[34px]" /> : <Switch checked={!rule.excluded} onChange={(v) => void setExcluded(rule, !v)} />}
        </div>
      </div>
    </div>
  );

  return (
    <>
      <PageHeader
        icon={<ScrollText />}
        title="规则"
        en="Rules"
        description="AGENTS.md 这类规则文件每轮全文发给模型。从全局开始，沿着目录一层层加载到工作区，越往后越具体；同一个目录里先读 AGENTS.md，再读 Easy Agent 专用的 AGENT.md。"
        actions={
          <>
            <WriteScopePicker what="排除" />
            <Tooltip content="新开一个会话运行 /init：Agent 读一遍仓库，生成或更新 AGENTS.md，改动等你确认">
              <Button variant="secondary" onClick={() => void runInit()}>
                <Wand2 />
                {hasProjectRule ? "让 Agent 更新" : "生成 AGENTS.md"}
              </Button>
            </Tooltip>
            <Menu>
              <MenuTrigger asChild>
                <Button variant="primary">
                  <FilePlus2 />
                  新建规则
                </Button>
              </MenuTrigger>
              <MenuContent align="end" className="w-[280px]">
                <MenuItem onSelect={() => void createFile(GLOBAL_RULE, "global")} className="h-auto items-start py-2">
                  <span className="block font-medium">全局规则</span>
                  <span className="block font-mono text-[11px] text-fg-3">~/.easy-agent/AGENT.md</span>
                </MenuItem>
                <MenuItem onSelect={() => void createFile("AGENTS.md", "project")} className="h-auto items-start py-2">
                  <span className="block font-medium">项目规则（通用）</span>
                  <span className="block font-mono text-[11px] text-fg-3">AGENTS.md · 其他 Agent 工具也认</span>
                </MenuItem>
                <MenuItem onSelect={() => void createFile("AGENT.md", "project")} className="h-auto items-start py-2">
                  <span className="block font-medium">项目规则（Easy Agent 专用）</span>
                  <span className="block font-mono text-[11px] text-fg-3">AGENT.md · 在 AGENTS.md 之后加载</span>
                </MenuItem>
              </MenuContent>
            </Menu>
          </>
        }
      />

      <div className="mb-5 grid grid-cols-3 gap-2.5">
        <Stat label="每轮占用" value={`${tokens(loaded.reduce((n, r) => n + r.tokens.value, 0))} tokens`} sub="全文加载，无法按需" />
        <Stat label="已加载" value={`${loaded.length} 个文件`} sub={`${rules.length - loaded.length} 个被排除`} />
        <Stat label="排除规则" value="claudeMdExcludes" sub="glob 匹配，所有配置合并生效" />
      </div>

      <h3 className="mb-2 px-1 text-[12.5px] font-semibold text-fg">加载顺序</h3>
      <div className="mb-6">
        {chain.length > 0 ? (
          chain.map((r, i) => row(r, i, i === chain.length - 1))
        ) : (
          <div className="rounded-xl border border-dashed border-line px-4 py-5 text-center text-[12.5px] text-fg-3">
            还没有规则文件。新建一个，或者让 Agent 读一遍仓库生成 AGENTS.md。
          </div>
        )}
      </div>

      {memory.length > 0 && (
        <>
          <h3 className="mb-1 px-1 text-[12.5px] font-semibold text-fg">自动记忆</h3>
          <p className="mb-2 px-1 text-[12px] text-fg-3">Agent 在工作中记下的项目知识，索引文件 MEMORY.md 每轮加载，具体条目按需读取。</p>
          {memory.map((r) => row(r, 0, true))}
        </>
      )}

      <DetailDrawer
        open={!!selected}
        onClose={() => setSelectedId(null)}
        title={selected && <span className="font-mono">{label(selected)}</span>}
        subtitle={selected && `${KIND_LABEL[selected.scope]} · ${selected.lines} 行 · ${selected.tokens.value} tokens`}
        footer={
          selected && (
            <>
              <Button variant="primary" size="sm" disabled={draft === (contents[selected.id] ?? "")} onClick={() => void save()}>
                保存
              </Button>
              <Button variant="ghost" size="sm" disabled={!selected.path} onClick={() => selected.path && void desktop.app.openPath(selected.path)}>
                在编辑器中打开
              </Button>
            </>
          )
        }
      >
        {selected && (
          <>
            <Field
              label="内容"
              hint={
                selected.scope === "memory"
                  ? "自动记忆主要由 Agent 维护，你也可以直接修改。"
                  : "会话中途修改不会改动系统提示词，改动作为一条上下文更新追加到对话末尾，提示词缓存不受影响。"
              }
            >
              <textarea
                aria-label="规则内容"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                className="scroll-thin h-[360px] w-full resize-none rounded-xl border border-line bg-surface px-3.5 py-3 font-mono text-[12.5px] leading-[1.7] text-fg outline-none focus:border-accent-line"
              />
            </Field>
            {selected.scope !== "memory" && (
              <Field
                label="排除这个文件"
                hint={
                  <>
                    关闭后会写入 claudeMdExcludes，比如 <code className="font-mono">"{selected.path}"</code>。排除只会少加载，任何一层配置里写了都生效。
                  </>
                }
              >
                <div className="flex items-center justify-between rounded-lg border border-line bg-surface px-3 py-2">
                  <span className="text-[12.5px] text-fg-2">{selected.excluded ? "已排除，不加载" : "正在加载"}</span>
                  <Switch checked={!selected.excluded} onChange={(v) => void setExcluded(selected, !v)} />
                </div>
              </Field>
            )}
          </>
        )}
      </DetailDrawer>
    </>
  );
}
