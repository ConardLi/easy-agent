import { CornerDownRight, Plus, Webhook } from "lucide-react";
import { useState } from "react";
import type { HookInventoryItem } from "../../../shared/agent";
import { Button, cn, Segmented, Switch } from "../../design/primitives";
import { SCOPE_FILE, type WriteScope } from "../../lib/scopes";
import { sourceValues, useCustomize, useWorkspaceData, writeSetting } from "../../state/customize";
import { useActiveWorkspace, useWorkspaces } from "../../state/workspaces";
import { CodeBlock } from "../session/Markdown";
import { addHook, type HookDraft, type HooksBlock, hookIndex, originOf, removeHook, reasonText } from "./model";
import { Chips, DetailDrawer, Field, inputClass, ItemRow, Modal, PageHeader, ScopeBadge, ScopeCards, ScopeChoice, Section, Stat } from "./shared";

const HOOK_EVENTS: { id: string; label: string; hint: string; matcher?: { label: string; placeholder: string }; context: boolean }[] = [
  {
    id: "PreToolUse",
    label: "工具调用前",
    hint: "退出码 2 拦截这次调用，也可以用 JSON 改写输入",
    matcher: { label: "匹配工具名", placeholder: "Bash|Edit" },
    context: false,
  },
  {
    id: "PostToolUse",
    label: "工具调用后",
    hint: "格式化代码、记日志；标准输出会作为上下文交给模型",
    matcher: { label: "匹配工具名", placeholder: "Edit|Write" },
    context: true,
  },
  { id: "UserPromptSubmit", label: "提交消息时", hint: "检查用户输入；标准输出会作为上下文交给模型", context: true },
  {
    id: "SessionStart",
    label: "会话开始",
    hint: "注入分支、待办这类环境信息；标准输出会作为上下文",
    matcher: { label: "匹配启动方式", placeholder: "startup|resume|clear|compact" },
    context: true,
  },
  { id: "Stop", label: "回合结束", hint: "检查结果，退出码 2 可以要求 Agent 继续", context: false },
  { id: "SubagentStop", label: "子 Agent 结束", hint: "检查子 Agent 的结果", matcher: { label: "匹配 Agent 类型", placeholder: "Explore" }, context: false },
];

const hookJson = (h: Pick<HookDraft, "event" | "matcher" | "command" | "timeout" | "shell">) =>
  JSON.stringify(
    {
      hooks: {
        [h.event]: [
          {
            ...(h.matcher ? { matcher: h.matcher } : {}),
            hooks: [
              { type: "command", command: h.command, ...(h.timeout && h.timeout !== 60 ? { timeout: h.timeout } : {}), ...(h.shell ? { shell: h.shell } : {}) },
            ],
          },
        ],
      },
    },
    null,
    2,
  );

const writable = (source: string): source is WriteScope => source === "user" || source === "project" || source === "local";

function HookDialog({ initial, onClose }: { initial: HookInventoryItem | { event: string }; onClose: () => void }) {
  const { config } = useWorkspaceData();
  const editing = "id" in initial ? initial : null;
  const [h, setH] = useState<HookDraft>(
    editing
      ? { event: editing.event, matcher: editing.matcher, command: editing.command, timeout: editing.timeout, shell: editing.shell }
      : { event: initial.event, matcher: initial.event === "PostToolUse" ? "Edit|Write" : undefined, command: "", timeout: 60 },
  );
  const [scope, setScope] = useState<WriteScope>(editing && writable(editing.source) ? editing.source : "project");
  const [busy, setBusy] = useState(false);
  const meta = HOOK_EVENTS.find((e) => e.id === h.event);

  const save = async () => {
    setBusy(true);
    const draft: HookDraft = { ...h, command: h.command.trim(), matcher: meta?.matcher ? h.matcher?.trim() || undefined : undefined };
    // Editing within one file is one write; moving a hook to another file removes it from the old one first.
    if (editing && writable(editing.source) && editing.source !== scope) {
      const old = removeHook((sourceValues(config, editing.source).hooks ?? {}) as HooksBlock, editing.event, hookIndex(editing));
      if (!(await writeSetting(editing.source, "hooks", Object.keys(old).length ? old : null, `已从 ${SCOPE_FILE[editing.source]} 移走这个 Hook`)))
        return setBusy(false);
    }
    // The first write above read the settings again; edit what the file holds now.
    const current = useCustomize.getState().configs[useWorkspaces.getState().activeId ?? ""];
    let block = (sourceValues(current, scope).hooks ?? {}) as HooksBlock;
    if (editing && editing.source === scope) block = removeHook(block, editing.event, hookIndex(editing));
    const ok = await writeSetting(scope, "hooks", addHook(block, draft), `已写入 ${SCOPE_FILE[scope]} 的 hooks.${draft.event}`);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      width={640}
      title={editing ? "编辑 Hook" : "添加 Hook"}
      description="Hook 是在 Agent 生命周期的固定时刻运行的命令。它从标准输入拿到事件 JSON，在项目目录下运行，环境里有 EASY_AGENT_PROJECT_DIR。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={!h.command.trim() || busy} onClick={() => void save()}>
            保存
          </Button>
        </>
      }
    >
      <Field label="时机">
        <div className="grid grid-cols-3 gap-1.5">
          {HOOK_EVENTS.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => setH((x) => ({ ...x, event: e.id, matcher: e.matcher ? x.matcher : undefined }))}
              className={cn(
                "rounded-lg border px-2.5 py-2 text-left transition-colors",
                h.event === e.id ? "border-accent bg-accent-softer" : "border-line bg-surface hover:border-line-strong",
              )}
            >
              <div className="text-[12.5px] font-medium text-fg">{e.label}</div>
              <div className="font-mono text-[10.5px] text-fg-3">{e.id}</div>
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[11.5px] text-fg-3">{meta?.hint}</p>
      </Field>
      {meta?.matcher && (
        <Field label={meta.matcher.label} hint="留空或 * 匹配全部；普通名字精确匹配；带正则语法时按正则匹配">
          <input
            value={h.matcher ?? ""}
            onChange={(e) => setH((x) => ({ ...x, matcher: e.target.value || undefined }))}
            placeholder={meta.matcher.placeholder}
            className={cn(inputClass, "font-mono text-[12.5px]")}
          />
        </Field>
      )}
      <Field label="命令">
        <textarea
          value={h.command}
          onChange={(e) => setH((x) => ({ ...x, command: e.target.value }))}
          rows={2}
          placeholder="npx prettier --write $(jq -r .tool_input.file_path)"
          className={cn(inputClass, "h-auto resize-none py-2 font-mono text-[12.5px]")}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="超时（秒）" hint="默认 60 秒">
          <input
            type="number"
            min={1}
            value={h.timeout}
            onChange={(e) => setH((x) => ({ ...x, timeout: Number(e.target.value) || 60 }))}
            className={cn(inputClass, "tabular")}
          />
        </Field>
        <Field label="Shell" hint="macOS、Linux 默认 bash，Windows 默认 PowerShell">
          <Segmented
            value={h.shell ?? "default"}
            onChange={(v) => setH((x) => ({ ...x, shell: v === "default" ? undefined : v }))}
            options={[
              { value: "default", label: "默认" },
              { value: "bash", label: "bash" },
              { value: "sh", label: "sh" },
              { value: "pwsh", label: "pwsh" },
            ]}
          />
        </Field>
      </div>
      <Field label="保存到">
        <ScopeChoice<WriteScope>
          value={scope}
          onChange={setScope}
          options={[
            { id: "project", scope: "project", title: "项目", path: ".easy-agent/settings.json", hint: "团队共享；工作区受信任后才运行" },
            { id: "local", scope: "local", title: "仅本机", path: "settings.local.json", hint: "不提交到仓库" },
            { id: "user", scope: "user", title: "全局", path: "~/.easy-agent/settings.json", hint: "所有项目都运行" },
          ]}
        />
      </Field>
      <Field label={`写入 ${SCOPE_FILE[scope]} 的内容`}>
        <CodeBlock code={hookJson(h)} lang="json" live />
      </Field>
    </Modal>
  );
}

export function HooksPage({ query }: { query: string }) {
  const { inventory, config } = useWorkspaceData();
  const writeScope = useCustomize((s) => s.writeScope);
  const workspace = useActiveWorkspace();
  const [filter, setFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<HookInventoryItem | { event: string } | null>(null);

  const hooks = inventory?.hooks ?? [];
  const kindOf = (h: HookInventoryItem) => (h.source === "plugin" ? "plugin" : h.source);
  const visible = hooks.filter(
    (h) => (filter === "all" || kindOf(h) === filter) && (!query || `${h.command} ${h.matcher ?? ""} ${h.event}`.toLowerCase().includes(query.toLowerCase())),
  );
  const count = (k: string) => hooks.filter((h) => kindOf(h) === k).length;
  const selected = hooks.find((h) => h.id === selectedId);
  const disabled = config?.effective.disableAllHooks?.value === true;
  const running = hooks.filter((h) => h.enabled).length;

  const remove = async (hook: HookInventoryItem) => {
    if (!writable(hook.source)) return;
    const block = removeHook((sourceValues(config, hook.source).hooks ?? {}) as HooksBlock, hook.event, hookIndex(hook));
    if (await writeSetting(hook.source, "hooks", Object.keys(block).length ? block : null, "已删除 Hook")) setSelectedId(null);
  };

  return (
    <>
      <PageHeader
        icon={<Webhook />}
        title="Hooks"
        en="Lifecycle"
        description="在工具调用前后、提交消息、会话开始和回合结束时运行你的命令：格式化代码、拦截危险操作、注入环境信息。项目和插件里的 Hook 要等工作区受信任后才运行。"
        actions={
          <Button variant="primary" onClick={() => setEditing({ event: "PostToolUse" })}>
            <Plus />
            添加 Hook
          </Button>
        }
      />

      <ScopeCards
        active={filter}
        onSelect={setFilter}
        cards={[
          {
            id: "project",
            scope: "project",
            title: "项目",
            path: ".easy-agent/settings.json",
            ...(workspace ? { open: `${workspace.path}/.easy-agent` } : {}),
            count: count("project"),
            hint: "团队共享，需要信任",
          },
          {
            id: "local",
            scope: "local",
            title: "仅本机",
            path: "settings.local.json",
            ...(workspace ? { open: `${workspace.path}/.easy-agent` } : {}),
            count: count("local"),
            hint: "不提交到仓库",
          },
          {
            id: "user",
            scope: "user",
            title: "全局",
            path: "~/.easy-agent/settings.json",
            open: "~/.easy-agent",
            count: count("user"),
            hint: "所有项目都运行",
          },
          {
            id: "plugin",
            scope: "plugin",
            title: "插件",
            path: "plugins/*/hooks",
            open: "~/.easy-agent/plugins",
            count: count("plugin"),
            hint: "在插件页管理",
          },
        ]}
      />

      <div
        className={cn("mb-5 flex items-center gap-4 rounded-xl border px-4 py-3", disabled ? "border-warning/35 bg-warning/[0.06]" : "border-line bg-canvas")}
      >
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-fg">{disabled ? "所有 Hook 已停用" : `${running} 个 Hook 正在生效`}</div>
          <div className="mt-0.5 text-[12px] text-fg-3">
            Hook 本身不占上下文；PostToolUse、UserPromptSubmit、SessionStart 的标准输出会作为上下文交给模型，每路输出最多 64 KiB。
          </div>
        </div>
        <span className="text-[12px] text-fg-3">停用全部</span>
        <Switch
          checked={disabled}
          onChange={(v) =>
            void writeSetting(
              writeScope,
              "disableAllHooks",
              v ? true : null,
              v ? `已在 ${SCOPE_FILE[writeScope]} 中停用所有 Hook，包括插件带来的` : `已在 ${SCOPE_FILE[writeScope]} 中恢复 Hook`,
            )
          }
        />
      </div>

      {HOOK_EVENTS.map((e) => {
        const items = visible.filter((h) => h.event === e.id);
        if (items.length === 0 && (filter !== "all" || query)) return null;
        return (
          <Section
            key={e.id}
            title={e.label}
            meta={`${e.id} · ${e.hint}`}
            action={
              <button type="button" onClick={() => setEditing({ event: e.id })} className="text-[11.5px] text-fg-3 hover:text-fg">
                添加
              </button>
            }
          >
            {items.length === 0 ? (
              <div className={cn("px-4 py-3 text-[12.5px] text-fg-4", disabled && "opacity-50")}>没有</div>
            ) : (
              items.map((h) => (
                <ItemRow
                  key={h.id}
                  selected={selectedId === h.id}
                  onClick={() => setSelectedId(h.id)}
                  dimmed={!h.enabled}
                  icon={<Webhook />}
                  title={<span className="font-mono text-[12.5px]">{h.command}</span>}
                  badges={null}
                  description={
                    <span className="flex items-center gap-2">
                      {h.matcher && (
                        <span className="flex items-center gap-1 font-mono">
                          <CornerDownRight className="size-3" />
                          {h.matcher}
                        </span>
                      )}
                      <span>超时 {h.timeout}s</span>
                      {h.shell && <span className="font-mono">{h.shell}</span>}
                      {!h.enabled && h.reason && <span>{reasonText(h.reason)}</span>}
                    </span>
                  }
                  right={<ScopeBadge origin={originOf(h, inventory)} />}
                />
              ))
            )}
          </Section>
        );
      })}

      <DetailDrawer
        open={!!selected}
        onClose={() => setSelectedId(null)}
        title={selected && HOOK_EVENTS.find((e) => e.id === selected.event)?.label}
        subtitle={selected && (writable(selected.source) ? SCOPE_FILE[selected.source] : `插件 ${originOf(selected, inventory).plugin ?? ""}`)}
        footer={
          selected &&
          writable(selected.source) && (
            <>
              <Button variant="secondary" size="sm" onClick={() => setEditing(selected)}>
                编辑
              </Button>
              <Button variant="danger" size="sm" className="ml-auto" onClick={() => void remove(selected)}>
                删除
              </Button>
            </>
          )
        }
      >
        {selected && (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-1.5">
              <ScopeBadge origin={originOf(selected, inventory)} />
              <span className="rounded-[5px] bg-surface-3 px-1.5 font-mono text-[10.5px] leading-[18px] text-fg-2">{selected.event}</span>
            </div>
            {!selected.enabled && selected.reason && (
              <div className="mb-4 rounded-lg border border-line bg-surface px-3 py-2.5 text-[12.5px] text-fg-2">{reasonText(selected.reason)}</div>
            )}
            <div className="mb-4 grid grid-cols-2 gap-2">
              <Stat label="超时" value={`${selected.timeout} 秒`} sub="超时后整组进程被结束" />
              <Stat
                label="上下文"
                value={HOOK_EVENTS.find((e) => e.id === selected.event)?.context ? "输出进上下文" : "不进上下文"}
                sub="只有标准输出会被注入"
              />
            </div>
            {selected.matcher && (
              <Field label="匹配">
                <Chips items={selected.matcher.split("|")} />
              </Field>
            )}
            <Field label="命令">
              <textarea value={selected.command} readOnly className={cn(inputClass, "h-auto resize-none py-2 font-mono text-[12.5px]")} rows={3} />
            </Field>
            <Field label="怎么返回结果">
              <div className="overflow-hidden rounded-lg border border-line text-[12.5px]">
                {[
                  ["退出码 0", "成功，继续执行"],
                  ["退出码 2", "拦截；标准错误会告诉模型原因"],
                  ["其他非零", "报一个不拦截的错误"],
                  ["stdout 输出 JSON", "设置 decision、systemMessage、continue、hookSpecificOutput"],
                ].map(([k, v]) => (
                  <div key={k} className="flex border-b border-line bg-surface last:border-b-0">
                    <span className="w-[120px] shrink-0 border-r border-line px-3 py-2 font-mono text-[11.5px] text-fg">{k}</span>
                    <span className="px-3 py-2 text-fg-2">{v}</span>
                  </div>
                ))}
              </div>
            </Field>
            <Field label="配置">
              <CodeBlock code={hookJson(selected)} lang="json" />
            </Field>
          </>
        )}
      </DetailDrawer>

      {editing && <HookDialog initial={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
