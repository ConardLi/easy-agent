import { Bot, FileCode2, Package, Plug, Sparkles, SquareTerminal, Store, TriangleAlert, Webhook } from "lucide-react";
import { useState } from "react";
import type { PluginInventoryItem } from "../../../shared/agent";
import { Button, cn, Segmented, Tooltip } from "../../design/primitives";
import { SCOPE_FILE, SCOPE_LABEL, WRITE_SCOPES } from "../../lib/scopes";
import { useWorkspaceData } from "../../state/customize";
import { pluginTokens, reasonText } from "./model";
import { Chips, DetailDrawer, Field, ItemRow, PageHeader, PendingSwitch, SCOPE_ICON, Section, Stat, TokenTag, WriteScopePicker } from "./shared";

// TODO(G8): enabling, installing, updating, and uninstalling plugins need the Agent's plugin management interface.
const G8_PENDING = "要等 Agent 提供插件管理接口（G8）";

function Components({ p }: { p: PluginInventoryItem }) {
  const parts: [typeof Sparkles, number, string][] = [
    [Sparkles, p.components.skills.length, "技能"],
    [SquareTerminal, p.components.commands.length, "命令"],
    [Bot, p.components.agents.length, "子 Agent"],
    [Webhook, p.components.hooks.length, "Hook"],
    [Plug, p.components.mcpServers.length, "MCP"],
    [FileCode2, p.components.lspServers.length, "LSP"],
  ];
  return (
    <span className="flex items-center gap-2.5">
      {parts
        .filter(([, n]) => n > 0)
        .map(([Icon, n, label]) => (
          <span key={label} className="inline-flex items-center gap-1 text-[11.5px] text-fg-3" title={label}>
            <Icon className="size-3" />
            {n} {label}
          </span>
        ))}
    </span>
  );
}

export function PluginsPage({ query }: { query: string }) {
  const { inventory } = useWorkspaceData();
  const [tab, setTab] = useState<"installed" | "market">("installed");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const q = query.toLowerCase();
  const plugins = inventory?.plugins ?? [];
  const installed = plugins.filter((p) => !q || `${p.name} ${p.description ?? ""}`.toLowerCase().includes(q));
  const selected = plugins.find((p) => p.id === selectedId);
  const tokensOf = (p: PluginInventoryItem) => (inventory && p.enabled ? pluginTokens(inventory, p.pluginId ?? "") : 0);

  return (
    <>
      <PageHeader
        icon={<Package />}
        title="插件"
        en="Plugins"
        description="插件把技能、命令、子 Agent、Hook、MCP 和 LSP 打包在一起，从插件市场安装。安装的文件统一放在 ~/.easy-agent/plugins/，在哪一层启用由 settings 里的 enabledPlugins 决定。"
        actions={
          <>
            <WriteScopePicker what="开关" />
            <Segmented
              value={tab}
              onChange={setTab}
              options={[
                { value: "installed", label: `已安装 ${plugins.length}` },
                { value: "market", label: "插件市场" },
              ]}
            />
          </>
        }
      />

      {tab === "installed" ? (
        installed.length > 0 ? (
          <Section title="已安装" meta="~/.easy-agent/plugins/installed_plugins.json">
            {installed.map((p) => (
              <ItemRow
                key={p.id}
                selected={selectedId === p.id}
                onClick={() => setSelectedId(p.id)}
                dimmed={!p.enabled}
                icon={<Package />}
                title={p.name}
                badges={
                  <>
                    <span className="font-mono text-[11px] text-fg-3">
                      {p.version} · {p.marketplace}
                    </span>
                    {p.errors.length > 0 && <TriangleAlert className="size-3 text-danger" />}
                  </>
                }
                description={
                  <span className="flex items-center gap-3">
                    <span className="truncate">{reasonText(p.reason) ?? p.description}</span>
                  </span>
                }
                right={
                  <>
                    <span className="hidden lg:block">
                      <Components p={p} />
                    </span>
                    <span className="text-right">
                      <TokenTag value={tokensOf(p)} per="/轮" />
                      <span className="block text-[10.5px] text-fg-3">{p.scope ? `由${SCOPE_LABEL[p.scope]}设置` : "未启用"}</span>
                    </span>
                    <PendingSwitch checked={p.enabled} reason={`插件的开关${G8_PENDING}`} />
                  </>
                }
              />
            ))}
          </Section>
        ) : (
          <div className="py-16 text-center text-[13px] text-fg-3">{plugins.length === 0 ? "还没有安装插件" : "没有匹配的插件"}</div>
        )
      ) : (
        <div className="flex flex-col items-center rounded-xl border border-dashed border-line px-6 py-14 text-center">
          <span className="mb-3 flex size-10 items-center justify-center rounded-xl border border-line bg-surface text-fg-3">
            <Store className="size-[18px]" />
          </span>
          <div className="text-[13px] font-medium text-fg-2">插件市场还没接入</div>
          <div className="mt-1 max-w-[420px] text-[12px] leading-[1.6] text-fg-3">
            浏览市场、安装和添加市场{G8_PENDING}。现在可以在终端里用 /plugin 管理插件，装好后这里会列出来。
          </div>
        </div>
      )}

      <DetailDrawer
        open={!!selected}
        onClose={() => setSelectedId(null)}
        title={selected?.name}
        subtitle={selected && [selected.version, selected.marketplace, selected.author].filter(Boolean).join(" · ")}
        footer={
          selected && (
            <>
              <Tooltip content={`检查更新${G8_PENDING}`}>
                <span>
                  <Button variant="secondary" size="sm" disabled>
                    检查更新
                  </Button>
                </span>
              </Tooltip>
              <Tooltip content={`卸载${G8_PENDING}`}>
                <span className="ml-auto">
                  <Button variant="danger" size="sm" disabled>
                    卸载
                  </Button>
                </span>
              </Tooltip>
            </>
          )
        }
      >
        {selected && (
          <>
            {selected.description && <p className="mb-4 text-[13px] leading-[1.6] text-fg-2">{selected.description}</p>}
            {selected.reason && (
              <div className="mb-4 rounded-lg border border-warning/35 bg-warning/[0.06] px-3 py-2.5 text-[12.5px] text-fg-2">
                {reasonText(selected.reason)}
              </div>
            )}
            {selected.errors.length > 0 && (
              <div className="mb-4 rounded-lg border border-danger/30 bg-danger/[0.06] px-3 py-2.5 text-[12.5px] text-fg-2">
                {selected.errors.map((e) => (
                  <div key={e}>{e}</div>
                ))}
              </div>
            )}
            <div className="mb-4 grid grid-cols-2 gap-2">
              <Stat label="每轮占用" value={`${tokensOf(selected)} tokens`} sub="技能清单、MCP、子 Agent 描述" />
              <Stat label="Hook" value={selected.components.hooks.length} sub="不占上下文" />
            </div>
            <Field label="在各层的启用状态" hint="按 全局 → 项目 → 本机 合并，最后一个设置了的生效。">
              <div className="overflow-hidden rounded-lg border border-line">
                {WRITE_SCOPES.map((s) => {
                  const Icon = SCOPE_ICON[s];
                  const decides = selected.scope === s;
                  return (
                    <div
                      key={s}
                      className={cn("flex h-10 items-center gap-2.5 border-b border-line px-3 last:border-b-0", decides ? "bg-accent-softer" : "bg-surface")}
                    >
                      <Icon className="size-3.5 text-fg-3" />
                      <span className="text-[12.5px] text-fg">{SCOPE_LABEL[s]}</span>
                      <span className="font-mono text-[11px] text-fg-3">{SCOPE_FILE[s]}</span>
                      <span className="flex-1" />
                      <span className={cn("text-[12px]", decides ? "font-medium text-fg" : "text-fg-4")}>
                        {decides ? (selected.enabled ? "启用 · 生效" : "停用 · 生效") : "未设置"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </Field>
            {selected.components.skills.length > 0 && (
              <Field label="技能">
                <Chips items={selected.components.skills.map((s) => `/${s}`)} />
              </Field>
            )}
            {selected.components.commands.length > 0 && (
              <Field label="命令">
                <Chips items={selected.components.commands.map((s) => `/${s}`)} />
              </Field>
            )}
            {selected.components.agents.length > 0 && (
              <Field label="子 Agent" hint="子 Agent 的名称和描述会写进 Agent 工具的说明里。">
                <Chips items={selected.components.agents} />
              </Field>
            )}
            {selected.components.hooks.length > 0 && (
              <Field label="Hook" hint="Hook 只在工作区受信任时运行。">
                <Chips items={selected.components.hooks} mono={false} />
              </Field>
            )}
            {selected.components.mcpServers.length > 0 && (
              <Field label="MCP 服务器">
                <Chips items={selected.components.mcpServers} />
              </Field>
            )}
            {selected.components.lspServers.length > 0 && (
              <Field label="LSP 服务器" hint="给内置的 LSP 工具提供语言服务，本身不占上下文。">
                <Chips items={selected.components.lspServers} />
              </Field>
            )}
          </>
        )}
      </DetailDrawer>
    </>
  );
}
