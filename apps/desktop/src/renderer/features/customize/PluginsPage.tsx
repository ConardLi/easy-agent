import { Bot, Download, Ellipsis, FileCode2, Package, Plug, Plus, ShieldAlert, Sparkles, SquareTerminal, Store, TriangleAlert, Webhook } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { PluginInstalledRow, PluginInstallPreview } from "../../../shared/agent";
import { Button, cn, Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Segmented, Spinner, Switch } from "../../design/primitives";
import { SCOPE_FILE, SCOPE_LABEL, WRITE_SCOPES, type WriteScope } from "../../lib/scopes";
import { changePlugins, loadPlugins, previewPlugin, useCustomize, useWorkspaceData } from "../../state/customize";
import { useWorkspaces } from "../../state/workspaces";
import { pluginTokens } from "./model";
import { Chips, DetailDrawer, Field, inputClass, ItemRow, Modal, PageHeader, SCOPE_ICON, Section, Stat, TokenTag, WriteScopePicker } from "./shared";

type Components = PluginInstalledRow["components"];

function ComponentCounts({ c }: { c: Components }) {
  const parts: [typeof Sparkles, number, string][] = [
    [Sparkles, c.skills, "技能"],
    [SquareTerminal, c.commands, "命令"],
    [Bot, c.agents, "子 Agent"],
    [Webhook, c.hooks, "Hook"],
    [Plug, c.mcpServers, "MCP"],
    [FileCode2, c.lspServers ?? 0, "LSP"],
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

function InstallMenu({ children, onPick }: { children: ReactNode; onPick: (scope: WriteScope) => void }) {
  return (
    <Menu>
      <MenuTrigger asChild>{children}</MenuTrigger>
      <MenuContent align="end" className="w-[280px]">
        <MenuLabel>安装并启用在</MenuLabel>
        {WRITE_SCOPES.map((s) => {
          const Icon = SCOPE_ICON[s];
          return (
            <MenuItem key={s} onSelect={() => onPick(s)} className="h-auto items-start py-2" icon={<Icon className="mt-0.5" />}>
              <span className="block font-medium">{SCOPE_LABEL[s]}</span>
              <span className="block font-mono text-[11px] text-fg-3">{SCOPE_FILE[s]} · enabledPlugins</span>
            </MenuItem>
          );
        })}
      </MenuContent>
    </Menu>
  );
}

interface Pending {
  pluginId: string;
  mode: "install" | "update";
  scope: WriteScope;
  /** Installed version, for updates. */
  current?: string;
}

/** What a plugin brings and whether it runs local processes, read before anything is installed. */
function ConfirmDialog({ pending, onClose }: { pending: Pending; onClose: () => void }) {
  const [preview, setPreview] = useState<PluginInstallPreview | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void previewPlugin(pending.pluginId).then((p) => {
      if (!p) onClose();
      else setPreview(p);
    });
  }, [pending.pluginId, onClose]);

  const sameVersion = pending.mode === "update" && preview?.version === pending.current;
  const c = preview?.components;
  const executables = c ? [...c.hooks.map((h) => `Hook ${h}`), ...c.mcpServers.map((m) => `MCP ${m}`), ...(c.lspServers ?? []).map((l) => `LSP ${l}`)] : [];

  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    const ok = await changePlugins(
      pending.mode === "install" ? "plugins/install" : "plugins/update",
      { pluginId: pending.pluginId, scope: pending.scope, fingerprint: preview.fingerprint },
      pending.mode === "install" ? `已安装 ${preview.pluginId} ${preview.version}，在${SCOPE_LABEL[pending.scope]}启用` : `已更新到 ${preview.version}`,
    );
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      title={pending.mode === "install" ? `安装 ${pending.pluginId}` : `更新 ${pending.pluginId}`}
      description="先看清插件带来了什么。确认后安装的就是这里显示的内容，期间内容有变化会停下来让你重新确认。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={!preview || busy || preview.errors.length > 0 || sameVersion} onClick={() => void confirm()}>
            {pending.mode === "install" ? `安装到${SCOPE_LABEL[pending.scope]}` : "更新"}
          </Button>
        </>
      }
    >
      {!preview ? (
        <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-fg-3">
          <Spinner />
          正在获取并校验插件…
        </div>
      ) : (
        <>
          <div className="mb-4 rounded-xl border border-line bg-surface p-3.5">
            <div className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-[9px] bg-accent-soft text-accent">
                <Package className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-fg">
                  {preview.pluginId}
                  <span className="ml-2 font-mono text-[11.5px] text-fg-3">
                    {pending.current && pending.current !== preview.version ? `${pending.current} → ` : ""}
                    {preview.version}
                  </span>
                </div>
                {preview.description && <div className="truncate text-[12px] text-fg-3">{preview.description}</div>}
              </div>
            </div>
          </div>
          {sameVersion && <p className="mb-4 text-[12.5px] text-fg-2">已经是最新版本 {preview.version}。</p>}
          {executables.length > 0 && (
            <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-warning/35 bg-warning/[0.06] px-3.5 py-3 text-[12.5px] leading-[1.55] text-fg-2">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
              <div>
                <div className="font-medium text-fg">这个插件会在你的电脑上运行程序</div>
                <div className="mt-0.5">它带的 Hook、MCP 或 LSP 服务器会以你的身份运行命令。装在项目或本机时，只在受信任的工作区里运行。</div>
                <div className="mt-2">
                  <Chips items={executables} />
                </div>
              </div>
            </div>
          )}
          {c && c.skills.length > 0 && (
            <Field label="技能">
              <Chips items={c.skills.map((s) => `/${s}`)} />
            </Field>
          )}
          {c && c.commands.length > 0 && (
            <Field label="命令">
              <Chips items={c.commands.map((s) => `/${s}`)} />
            </Field>
          )}
          {c && c.agents.length > 0 && (
            <Field label="子 Agent">
              <Chips items={c.agents} />
            </Field>
          )}
          {c && c.outputStyles.length > 0 && (
            <Field label="输出风格">
              <Chips items={c.outputStyles} />
            </Field>
          )}
          {[...preview.errors, ...preview.warnings].length > 0 && (
            <Field label={preview.errors.length > 0 ? "校验没通过，不能安装" : "提醒"}>
              <div
                className={cn(
                  "rounded-lg border px-3 py-2.5 text-[12px] leading-[1.6]",
                  preview.errors.length > 0 ? "border-danger/30 bg-danger/[0.06]" : "border-line bg-surface",
                )}
              >
                {[...preview.errors, ...preview.warnings].map((m) => (
                  <div key={m}>{m}</div>
                ))}
              </div>
            </Field>
          )}
        </>
      )}
    </Modal>
  );
}

function AddMarketplaceDialog({ onClose }: { onClose: () => void }) {
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    const ok = await changePlugins("marketplace/add", { source: source.trim() }, (before, after) => {
      const added = after.marketplaces.find((m) => !before?.marketplaces.some((b) => b.name === m.name));
      return added ? `已添加市场 ${added.name}，${added.pluginCount ?? 0} 个插件` : "已添加市场";
    });
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      title="添加插件市场"
      description="市场是一份插件目录。添加以后，它列出的插件会出现在这里，可以逐个安装。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={!source.trim() || busy} onClick={() => void add()}>
            添加
          </Button>
        </>
      }
    >
      <Field label="来源" hint="GitHub 仓库（owner/repo）、Git 地址，或者本机的目录">
        <input
          value={source}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && source.trim() && void add()}
          placeholder="acme/agent-plugins"
          className={cn(inputClass, "font-mono text-[12.5px]")}
        />
      </Field>
    </Modal>
  );
}

export function PluginsPage({ query }: { query: string }) {
  const { inventory } = useWorkspaceData();
  const workspaceId = useWorkspaces((s) => s.activeId);
  const view = useCustomize((s) => (workspaceId ? s.plugins[workspaceId] : undefined));
  const writeScope = useCustomize((s) => s.writeScope);
  const [tab, setTab] = useState<"installed" | "market">("installed");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [addingMarket, setAddingMarket] = useState(false);
  const [uninstalling, setUninstalling] = useState<PluginInstalledRow | null>(null);

  useEffect(() => {
    void loadPlugins(workspaceId);
  }, [workspaceId]);

  const q = query.toLowerCase();
  const installed = (view?.installed ?? []).filter((p) => !q || `${p.name} ${p.description ?? ""}`.toLowerCase().includes(q));
  const available = (view?.available ?? []).filter((p) => !q || `${p.name} ${p.description ?? ""}`.toLowerCase().includes(q));
  const selected = view?.installed.find((p) => p.pluginId === selectedId);
  const tokensOf = (p: PluginInstalledRow) => (inventory && p.enabled ? pluginTokens(inventory, p.pluginId) : 0);

  // Turning on writes to the chosen file; turning off writes to the file that turned it on, which is the one that decides.
  const toggle = (p: PluginInstalledRow, enabled: boolean) => {
    const scope = enabled ? writeScope : (p.scope ?? writeScope);
    void changePlugins(
      enabled ? "plugins/enable" : "plugins/disable",
      { pluginId: p.pluginId, scope },
      `已在 ${SCOPE_FILE[scope]} 的 enabledPlugins 中${enabled ? "启用" : "停用"} ${p.name}`,
    );
  };
  const closePending = useCallback(() => setPending(null), []);

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
                { value: "installed", label: `已安装 ${view?.installed.length ?? 0}` },
                { value: "market", label: "插件市场" },
              ]}
            />
          </>
        }
      />

      {!view ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : tab === "installed" ? (
        installed.length > 0 ? (
          <Section title="已安装" meta="~/.easy-agent/plugins/installed_plugins.json">
            {installed.map((p) => (
              <ItemRow
                key={p.pluginId}
                selected={selectedId === p.pluginId}
                onClick={() => setSelectedId(p.pluginId)}
                dimmed={!p.enabled}
                icon={<Package />}
                title={p.name}
                badges={
                  <>
                    <span className="font-mono text-[11px] text-fg-3">
                      {p.version} · {p.marketplace}
                    </span>
                    {p.errorCount > 0 && <TriangleAlert className="size-3 text-danger" />}
                  </>
                }
                description={
                  <span className="flex items-center gap-3">
                    <span className="truncate">
                      {p.enabled && !p.executablesTrusted ? "工作区未受信任，它的 Hook、MCP 和 LSP 不会运行" : (p.description ?? "")}
                    </span>
                  </span>
                }
                right={
                  <>
                    <span className="hidden lg:block">
                      <ComponentCounts c={p.components} />
                    </span>
                    <span className="text-right">
                      <TokenTag value={tokensOf(p)} per="/轮" />
                      <span className="block text-[10.5px] text-fg-3">{p.scope ? `由${SCOPE_LABEL[p.scope]}设置` : "未启用"}</span>
                    </span>
                    <Switch checked={p.enabled} onChange={(v) => toggle(p, v)} />
                  </>
                }
              />
            ))}
          </Section>
        ) : (
          <div className="py-16 text-center text-[13px] text-fg-3">
            {view.installed.length === 0 ? "还没有安装插件，到「插件市场」里装一个" : "没有匹配的插件"}
          </div>
        )
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {view.marketplaces.map((m) => (
              <span key={m.name} className="inline-flex h-8 items-center gap-2 rounded-[9px] border border-line bg-canvas pl-2.5 pr-1 text-[12.5px]">
                <Store className="size-3.5 text-fg-3" />
                <span className="font-medium text-fg">{m.name}</span>
                <span className="max-w-[260px] truncate font-mono text-[11px] text-fg-3" title={m.location}>
                  {m.error ? <span className="text-danger">读取失败</span> : `${m.pluginCount ?? 0} 个插件`}
                </span>
                <Menu>
                  <MenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`${m.name} 的操作`}
                      className="flex size-6 items-center justify-center rounded-md text-fg-3 hover:bg-surface-2 hover:text-fg"
                    >
                      <Ellipsis className="size-3.5" />
                    </button>
                  </MenuTrigger>
                  <MenuContent align="end">
                    <MenuItem onSelect={() => void changePlugins("marketplace/update", { name: m.name }, `已更新市场 ${m.name}`)}>更新目录</MenuItem>
                    <MenuItem danger onSelect={() => void changePlugins("marketplace/remove", { name: m.name }, `已移除市场 ${m.name}`)}>
                      移除
                    </MenuItem>
                  </MenuContent>
                </Menu>
              </span>
            ))}
            <Button variant="ghost" size="sm" onClick={() => setAddingMarket(true)}>
              <Plus />
              添加市场
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {available.map((m) => (
              <div key={m.pluginId} className="flex flex-col rounded-xl border border-line bg-canvas p-4 transition-colors hover:border-line-strong">
                <div className="flex items-start gap-3">
                  <span className="flex size-9 items-center justify-center rounded-[10px] border border-line bg-surface text-fg-2">
                    <Package className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-medium text-fg">{m.name}</div>
                    <div className="font-mono text-[11px] text-fg-3">{[m.version, m.marketplace].filter(Boolean).join(" · ")}</div>
                  </div>
                </div>
                <p className="mt-2.5 flex-1 text-[12.5px] leading-[1.55] text-fg-2">{m.description}</p>
                <div className="mt-3 flex items-center gap-1.5">
                  <span className="flex-1" />
                  <InstallMenu onPick={(scope) => setPending({ pluginId: m.pluginId, mode: "install", scope })}>
                    <Button size="sm" variant="secondary">
                      <Download />
                      安装
                    </Button>
                  </InstallMenu>
                </div>
              </div>
            ))}
          </div>
          {available.length === 0 && (
            <div className="py-16 text-center text-[13px] text-fg-3">
              {view.marketplaces.length === 0 ? "还没有添加插件市场" : q ? "没有匹配的插件" : "市场里的插件都装好了"}
            </div>
          )}
        </>
      )}

      <DetailDrawer
        open={!!selected}
        onClose={() => setSelectedId(null)}
        title={selected?.name}
        subtitle={selected && [selected.version, selected.marketplace, selected.author].filter(Boolean).join(" · ")}
        footer={
          selected && (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPending({ pluginId: selected.pluginId, mode: "update", scope: selected.scope ?? writeScope, current: selected.version })}
              >
                检查更新
              </Button>
              <Button variant="danger" size="sm" className="ml-auto" onClick={() => setUninstalling(selected)}>
                卸载
              </Button>
            </>
          )
        }
      >
        {selected && (
          <>
            {selected.description && <p className="mb-4 text-[13px] leading-[1.6] text-fg-2">{selected.description}</p>}
            {selected.enabled && !selected.executablesTrusted && (
              <div className="mb-4 rounded-lg border border-warning/35 bg-warning/[0.06] px-3 py-2.5 text-[12.5px] text-fg-2">
                工作区未受信任，这个插件的 Hook、MCP 和 LSP 服务器不会运行
              </div>
            )}
            {selected.errorCount > 0 && (
              <div className="mb-4 rounded-lg border border-danger/30 bg-danger/[0.06] px-3 py-2.5 text-[12.5px] text-fg-2">
                {(view?.errors ?? [])
                  .filter((e) => e.pluginId === selected.pluginId)
                  .map((e) => (
                    <div key={`${e.scope}-${e.message}`}>{e.message}</div>
                  ))}
              </div>
            )}
            <div className="mb-4 grid grid-cols-2 gap-2">
              <Stat label="每轮占用" value={`${tokensOf(selected)} tokens`} sub="技能清单、MCP、子 Agent 描述" />
              <Stat label="Hook" value={selected.components.hooks} sub="不占上下文" />
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
            {selected.componentNames.skills.length > 0 && (
              <Field label="技能">
                <Chips items={selected.componentNames.skills.map((s) => `/${s}`)} />
              </Field>
            )}
            {selected.componentNames.commands.length > 0 && (
              <Field label="命令">
                <Chips items={selected.componentNames.commands.map((s) => `/${s}`)} />
              </Field>
            )}
            {selected.componentNames.agents.length > 0 && (
              <Field label="子 Agent" hint="子 Agent 的名称和描述会写进 Agent 工具的说明里。">
                <Chips items={selected.componentNames.agents} />
              </Field>
            )}
            {selected.componentNames.hooks.length > 0 && (
              <Field label="Hook" hint={selected.scope === "user" ? "在全局启用，Hook 在每个工作区都会运行。" : "Hook 只在工作区受信任时运行。"}>
                <Chips items={selected.componentNames.hooks} mono={false} />
              </Field>
            )}
            {selected.componentNames.mcpServers.length > 0 && (
              <Field label="MCP 服务器">
                <Chips items={selected.componentNames.mcpServers} />
              </Field>
            )}
            {(selected.componentNames.lspServers ?? []).length > 0 && (
              <Field label="LSP 服务器" hint="给内置的 LSP 工具提供语言服务，本身不占上下文。">
                <Chips items={selected.componentNames.lspServers ?? []} />
              </Field>
            )}
            {selected.warnings.length > 0 && (
              <Field label="提醒">
                <div className="rounded-lg border border-line bg-surface px-3 py-2.5 text-[12px] leading-[1.6] text-fg-2">
                  {selected.warnings.map((w) => (
                    <div key={w}>{w}</div>
                  ))}
                </div>
              </Field>
            )}
          </>
        )}
      </DetailDrawer>

      {pending && <ConfirmDialog pending={pending} onClose={closePending} />}
      {addingMarket && <AddMarketplaceDialog onClose={() => setAddingMarket(false)} />}
      {uninstalling && (
        <Modal
          open
          onOpenChange={(v) => !v && setUninstalling(null)}
          title={`卸载 ${uninstalling.name}？`}
          description={`从${SCOPE_LABEL[uninstalling.scope ?? "user"]}配置里移除它；没有别的配置再用它时，插件文件和它的数据目录一起删除。`}
          footer={
            <>
              <Button variant="ghost" onClick={() => setUninstalling(null)}>
                取消
              </Button>
              <Button
                variant="primary"
                className="bg-danger hover:bg-danger/90"
                onClick={() => {
                  const target = uninstalling;
                  setUninstalling(null);
                  void changePlugins("plugins/uninstall", { pluginId: target.pluginId, scope: target.scope ?? "user" }, `已卸载 ${target.name}`).then(
                    (ok) => ok && setSelectedId(null),
                  );
                }}
              >
                卸载
              </Button>
            </>
          }
        >
          <div className="text-[12.5px] leading-[1.6] text-fg-2">卸载以后，它带来的技能、命令和服务器从下一轮起不再可用。</div>
        </Modal>
      )}
    </>
  );
}
