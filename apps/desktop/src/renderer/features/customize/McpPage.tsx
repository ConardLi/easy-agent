import { Plug, Plus, RefreshCw, ShieldQuestion, TriangleAlert, Zap } from "lucide-react";
import { useState } from "react";
import type { McpServerInventoryItem, McpServerStatus } from "../../../shared/agent";
import { describeError } from "../../agent/client";
import { Button, cn, Segmented, Spinner } from "../../design/primitives";
import { desktop } from "../../lib/desktop";
import { tokens } from "../../lib/format";
import { SCOPE_FILE, type WriteScope } from "../../lib/scopes";
import {
  approveMcpServer,
  loadInventory,
  reconnectMcpServer,
  restartForMcp,
  sourceValues,
  useCustomize,
  useWorkspaceData,
  writeSetting,
} from "../../state/customize";
import { useUi } from "../../state/ui";
import { useActiveWorkspace } from "../../state/workspaces";
import { CodeBlock } from "../session/Markdown";
import { displayPath, mcpTokens, originOf, reasonText } from "./model";
import {
  DetailDrawer,
  Field,
  inputClass,
  ItemRow,
  Modal,
  PageHeader,
  PendingSwitch,
  ScopeBadge,
  ScopeCards,
  ScopeChoice,
  Section,
  Stat,
  TokenTag,
  WriteScopePicker,
} from "./shared";

// TODO(config): turning one server on or off, and `alwaysLoad`, need settings keys in the Agent.
const SWITCH_PENDING = "单个服务器的开关要等 Agent 提供对应的配置项";

const STATUS: Record<McpServerStatus, [string, string]> = {
  connected: ["bg-success", "已连接"],
  failed: ["bg-danger", "连接失败"],
  pending: ["bg-info animate-pulse", "连接中"],
  awaiting_approval: ["bg-warning", "等待批准"],
  rejected: ["bg-fg-4", "已拒绝"],
  ignored: ["bg-fg-4", "工作区未信任"],
  disabled: ["bg-fg-4", "已关闭"],
};

function StatusDot({ server }: { server: McpServerInventoryItem }) {
  const [dot, label] = STATUS[server.status];
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-fg-3">
      <span className={cn("size-1.5 rounded-full", dot)} />
      {label}
    </span>
  );
}

type Transport = McpServerInventoryItem["transport"];

/** The settings entry for a server as it is written, without environment values. */
function serverEntry(transport: Transport, command: string, url: string, env: Record<string, string>): Record<string, unknown> {
  if (transport !== "stdio") return { type: transport, url };
  const [bin, ...args] = command.trim().split(/\s+/);
  return { command: bin, ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}) };
}

function configJson(name: string, entry: Record<string, unknown>): string {
  return JSON.stringify({ mcpServers: { [name]: entry } }, null, 2);
}

const fileOf = (scope: WriteScope) =>
  scope === "user" ? "~/.easy-agent/settings.json" : scope === "project" ? ".mcp.json" : ".easy-agent/settings.local.json";

function parseEnv(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()] as [string, string])
      .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)),
  );
}

function AddServerDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (v: boolean) => void; onAdded: (id: string) => void }) {
  const workspace = useActiveWorkspace();
  const { config, inventory } = useWorkspaceData();
  const toast = useUi((s) => s.toast);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<Transport>("stdio");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [env, setEnv] = useState("");
  const [scope, setScope] = useState<WriteScope>("user");
  const [busy, setBusy] = useState(false);

  const entry = serverEntry(transport, command || "npx -y my-mcp-server", url || "https://example.com/mcp", parseEnv(env));
  const taken = inventory?.mcpServers.some((m) => m.name === name.trim());
  const valid = /^[\w.-]+$/.test(name.trim()) && !taken && (transport === "stdio" ? command.trim() : /^https?:\/\//.test(url.trim()));

  const add = async () => {
    if (!workspace) return;
    const id = name.trim();
    const real = serverEntry(transport, command, url.trim(), parseEnv(env));
    setBusy(true);
    try {
      if (scope === "project") {
        await desktop.customize.setMcpJsonServer(workspace.id, id, real);
        toast(`已写入 .mcp.json，批准后 ${id} 才会启动`);
        await loadInventory(workspace.id);
      } else {
        const current = (sourceValues(config, scope).mcpServers ?? {}) as Record<string, unknown>;
        if (!(await writeSetting(scope, "mcpServers", { ...current, [id]: real }, `已写入 ${fileOf(scope)}，正在连接 ${id}`))) return;
        await restartForMcp(workspace.id);
      }
      onOpenChange(false);
      setName("");
      setCommand("");
      setUrl("");
      setEnv("");
      onAdded(`mcp_server:${id}`);
    } catch (error) {
      toast(describeError(error), "danger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      width={640}
      title="添加 MCP 服务器"
      description="服务器提供的工具默认延迟加载：平时只占一个名字，模型用到时再取完整定义。"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="primary" disabled={!valid || busy} onClick={() => void add()}>
            添加并连接
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-[1fr_auto] gap-3">
        <Field label="名称" hint={taken ? "已经有同名的服务器" : undefined}>
          <input value={name} onChange={(e) => setName(e.target.value.replace(/\s/g, "-"))} placeholder="例如 github" className={cn(inputClass, "font-mono")} />
        </Field>
        <Field label="传输方式">
          <Segmented
            value={transport}
            onChange={setTransport}
            options={[
              { value: "stdio", label: "stdio" },
              { value: "http", label: "HTTP" },
              { value: "sse", label: "SSE" },
            ]}
          />
        </Field>
      </div>
      {transport === "stdio" ? (
        <Field label="启动命令" hint="Easy Agent 会以子进程启动它，通过标准输入输出通信。">
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="npx -y @modelcontextprotocol/server-github"
            className={cn(inputClass, "font-mono text-[12.5px]")}
          />
        </Field>
      ) : (
        <Field label="地址" hint="需要登录的服务器会在第一次连接时打开浏览器完成 OAuth。">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://mcp.linear.app/mcp"
            className={cn(inputClass, "font-mono text-[12.5px]")}
          />
        </Field>
      )}
      {transport === "stdio" && (
        <Field
          label="环境变量"
          hint={
            <>
              每行一个 <code className="font-mono">KEY=$&#123;VAR&#125;</code>，引用你环境里的变量，密钥不要直接写在配置里。
            </>
          }
        >
          <textarea
            value={env}
            onChange={(e) => setEnv(e.target.value)}
            rows={2}
            placeholder={"GITHUB_TOKEN=${GITHUB_TOKEN}"}
            className={cn(inputClass, "h-auto resize-none py-2 font-mono text-[12.5px]")}
          />
        </Field>
      )}
      <Field label="保存到">
        <ScopeChoice
          value={scope}
          onChange={setScope}
          options={[
            { id: "user", scope: "user", title: "全局", path: "~/.easy-agent/settings.json", hint: "所有项目都会连接" },
            { id: "project", scope: "project", title: "项目共享", path: ".mcp.json", hint: "提交到仓库；队友第一次打开时需要批准" },
            { id: "local", scope: "local", title: "仅本机", path: ".easy-agent/settings.local.json", hint: "只在这个项目、这台机器上" },
          ]}
        />
      </Field>
      <Field label={`写入 ${fileOf(scope)} 的内容`}>
        <CodeBlock code={configJson(name || "my-server", entry)} lang="json" live />
      </Field>
    </Modal>
  );
}

export function McpPage({ query }: { query: string }) {
  const { inventory, config } = useWorkspaceData();
  const writeScope = useCustomize((s) => s.writeScope);
  const workspace = useActiveWorkspace();
  const toast = useUi((s) => s.toast);
  const [filter, setFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  const servers = inventory?.mcpServers ?? [];
  const kindOf = (m: McpServerInventoryItem) =>
    m.source === "plugin" ? "plugin" : m.source === "local" ? "local" : m.source === "project" ? "project" : "user";
  const pending = servers.filter((m) => m.status === "awaiting_approval");
  const visible = servers.filter(
    (m) => m.status !== "awaiting_approval" && (filter === "all" || kindOf(m) === filter) && (!query || m.name.toLowerCase().includes(query.toLowerCase())),
  );
  const count = (kind: string) => servers.filter((m) => kindOf(m) === kind).length;
  const perTurn = servers.reduce((n, m) => n + mcpTokens(m).now, 0);
  const allLoaded = servers.filter((m) => m.status === "connected").reduce((n, m) => n + mcpTokens(m).all, 0);
  const selected = servers.find((m) => m.id === selectedId);
  const toolSearch = (config?.effective.toolSearch?.value as "on" | "auto" | "off" | undefined) ?? "on";

  const remove = async (server: McpServerInventoryItem) => {
    if (!workspace) return;
    try {
      if (server.path?.endsWith(".mcp.json")) {
        await desktop.customize.setMcpJsonServer(workspace.id, server.name, null);
        toast(`已从 .mcp.json 删除 ${server.name}`);
      } else {
        const scope = server.source as WriteScope;
        const { [server.name]: _, ...rest } = (sourceValues(config, scope).mcpServers ?? {}) as Record<string, unknown>;
        if (!(await writeSetting(scope, "mcpServers", Object.keys(rest).length ? rest : null, `已从 ${SCOPE_FILE[scope]} 删除 ${server.name}`))) return;
      }
      setSelectedId(null);
      await restartForMcp(workspace.id);
    } catch (error) {
      toast(describeError(error), "danger");
    }
  };

  const row = (server: McpServerInventoryItem) => {
    const { now, deferred } = mcpTokens(server);
    return (
      <ItemRow
        key={server.id}
        selected={selectedId === server.id}
        onClick={() => setSelectedId(server.id)}
        dimmed={!server.enabled}
        icon={<Plug />}
        title={<span className="font-mono">{server.name}</span>}
        badges={
          <>
            <span className="rounded-[5px] bg-surface-3 px-1.5 font-mono text-[10.5px] leading-[18px] text-fg-2">{server.transport}</span>
            <StatusDot server={server} />
          </>
        }
        description={
          server.status === "failed" ? (
            <span className="text-danger">{server.error}</span>
          ) : server.reason && !server.enabled ? (
            <span>{reasonText(server.reason)}</span>
          ) : (
            <span className="font-mono">{server.command ?? server.url}</span>
          )
        }
        right={
          <>
            <span className="text-right">
              <TokenTag value={now} per="/轮" />
              <span className="block text-[10.5px] text-fg-3">
                {server.tools.length} 个工具{deferred && server.status === "connected" ? " · 延迟" : ""}
              </span>
            </span>
            {server.source === "plugin" ? (
              <span className="w-[34px] text-center text-[11px] text-fg-3">插件</span>
            ) : (
              <PendingSwitch checked={server.enabled} reason={SWITCH_PENDING} />
            )}
          </>
        }
      />
    );
  };

  const groups = [
    { kind: "project", title: `项目 · ${workspace?.name ?? ""}`, meta: ".mcp.json · .easy-agent/settings.json" },
    { kind: "local", title: "仅本机", meta: ".easy-agent/settings.local.json" },
    { kind: "user", title: "全局", meta: "~/.easy-agent/settings.json" },
    { kind: "plugin", title: "来自插件", meta: "随插件启用和停用" },
  ];

  return (
    <>
      <PageHeader
        icon={<Plug />}
        title="MCP 服务器"
        en="MCP"
        description="通过 Model Context Protocol 接入外部工具和数据。全局服务器写在 settings.json 的 mcpServers 里；项目的 .mcp.json 跟着仓库走，第一次需要你批准才会启动。"
        actions={
          <>
            <WriteScopePicker what="开关" />
            <Button variant="primary" onClick={() => setAdding(true)}>
              <Plus />
              添加服务器
            </Button>
          </>
        }
      />

      {pending.length > 0 && (
        <div className="mb-5 overflow-hidden rounded-xl border border-warning/35 bg-warning/[0.06]">
          <div className="flex items-start gap-2.5 px-4 pt-3.5">
            <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="text-[12.5px] leading-[1.55] text-fg-2">
              <span className="font-medium text-fg">项目的 .mcp.json 声明了 {pending.length} 个服务器，还没有启动。</span>
              它们会以你的身份运行命令和访问网络，确认来源可信后再批准。
            </div>
          </div>
          {pending.map((m) => (
            <div key={m.id} className="mx-4 my-3 flex items-center gap-3 rounded-lg border border-line bg-canvas px-3 py-2.5">
              <Plug className="size-4 text-fg-3" />
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[13px] font-medium text-fg">{m.name}</div>
                <div className="truncate font-mono text-[11.5px] text-fg-3">{m.command ?? m.url}</div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => void approveMcpServer(m.name, false)}>
                拒绝
              </Button>
              <Button size="sm" variant="primary" onClick={() => void approveMcpServer(m.name, true)}>
                批准
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="mb-5 flex items-center gap-4 rounded-xl border border-line bg-canvas px-4 py-3.5">
        <span className="flex size-8 items-center justify-center rounded-[9px] bg-accent-soft text-accent">
          <Zap className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-fg">工具加载方式</div>
          <div className="mt-0.5 text-[12px] text-fg-3">
            现在每轮 <span className="tabular text-fg-2">{tokens(perTurn)}</span> tokens；全部加载需要{" "}
            <span className="tabular text-fg-2">{tokens(allLoaded)}</span>
          </div>
        </div>
        <Segmented
          value={toolSearch}
          onChange={(v) => void writeSetting(writeScope, "toolSearch", v, `已在 ${SCOPE_FILE[writeScope]} 中设置 toolSearch: "${v}"`)}
          options={[
            { value: "on", label: "延迟加载" },
            { value: "auto", label: "自动" },
            { value: "off", label: "全部加载" },
          ]}
        />
      </div>

      <ScopeCards
        active={filter}
        onSelect={setFilter}
        cards={[
          {
            id: "project",
            scope: "project",
            title: "项目",
            path: ".mcp.json",
            ...(workspace ? { open: workspace.path } : {}),
            count: count("project"),
            hint: "团队共享，需要批准",
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
            hint: "所有项目都连接",
          },
          {
            id: "plugin",
            scope: "plugin",
            title: "插件",
            path: "plugins/*/.mcp.json",
            open: "~/.easy-agent/plugins",
            count: count("plugin"),
            hint: "在插件页管理",
          },
        ]}
      />

      {groups.map((g) => {
        const items = visible.filter((m) => kindOf(m) === g.kind);
        if (items.length === 0) return null;
        return (
          <Section key={g.kind} title={g.title} meta={g.meta}>
            {items.map(row)}
          </Section>
        );
      })}
      {visible.length === 0 && pending.length === 0 && (
        <div className="py-16 text-center text-[13px] text-fg-3">
          {servers.length === 0 ? "还没有 MCP 服务器，点「添加服务器」接入一个" : "没有匹配的服务器"}
        </div>
      )}

      <DetailDrawer
        open={!!selected}
        onClose={() => setSelectedId(null)}
        title={selected && <span className="font-mono">{selected.name}</span>}
        subtitle={
          selected &&
          (selected.path && workspace
            ? displayPath(selected.path, workspace.path)
            : selected.source === "plugin"
              ? "插件"
              : SCOPE_FILE[selected.source as WriteScope])
        }
        footer={
          selected && (
            <>
              <Button
                variant="secondary"
                size="sm"
                disabled={selected.source === "plugin"}
                onClick={() =>
                  void desktop.app.openPath(selected.path ?? (selected.source === "user" ? "~/.easy-agent/settings.json" : `${workspace?.path}/.easy-agent`))
                }
              >
                编辑配置
              </Button>
              {!["awaiting_approval", "rejected", "ignored"].includes(selected.status) && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={reconnecting}
                  onClick={() => {
                    setReconnecting(true);
                    void reconnectMcpServer(selected.name).finally(() => setReconnecting(false));
                  }}
                >
                  <RefreshCw />
                  重新连接
                </Button>
              )}
              {selected.source !== "plugin" && (
                <Button variant="danger" size="sm" className="ml-auto" onClick={() => void remove(selected)}>
                  删除
                </Button>
              )}
            </>
          )
        }
      >
        {selected && (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <ScopeBadge origin={originOf(selected, inventory)} />
              <StatusDot server={selected} />
              {(selected.status === "pending" || reconnecting) && <Spinner />}
            </div>
            {selected.status === "failed" && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/[0.06] px-3 py-2.5 text-[12.5px] text-fg-2">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" />
                {selected.error}
              </div>
            )}
            {selected.reason && !selected.enabled && selected.status !== "failed" && (
              <div className="mb-4 rounded-lg border border-line bg-surface px-3 py-2.5 text-[12.5px] text-fg-2">{reasonText(selected.reason)}</div>
            )}
            <div className="mb-4 grid grid-cols-2 gap-2">
              <Stat label="现在每轮" value={`${tokens(mcpTokens(selected).now)} tokens`} sub={mcpTokens(selected).deferred ? "只发工具名" : "完整定义"} />
              <Stat label="全部加载" value={`${tokens(mcpTokens(selected).all)} tokens`} sub={`${selected.tools.length} 个工具`} />
            </div>
            <Field label="始终加载" hint="打开后这个服务器的工具不再延迟，每轮都发送完整定义。只给最常用的服务器打开。">
              <div className="flex items-center justify-between rounded-lg border border-line bg-surface px-3 py-2">
                <span className="text-[12.5px] text-fg-2">alwaysLoad</span>
                <PendingSwitch checked={false} reason="alwaysLoad 要等 Agent 提供对应的配置项" />
              </div>
            </Field>
            <Field label={`工具（${selected.tools.length}）`}>
              <div className="scroll-thin max-h-[240px] overflow-y-auto rounded-lg border border-line">
                {selected.tools.map((t) => (
                  <div key={t.name} className="flex h-8 items-center gap-2 border-b border-line bg-surface px-3 last:border-b-0">
                    <span className="flex-1 truncate font-mono text-[12px] text-fg-2">{t.name}</span>
                    <TokenTag value={t.schema.value} />
                  </div>
                ))}
              </div>
            </Field>
            <Field
              label={`配置 · ${selected.path && workspace ? displayPath(selected.path, workspace.path) : selected.source === "plugin" ? "插件" : SCOPE_FILE[selected.source as WriteScope]}`}
            >
              <CodeBlock code={configJson(selected.name, serverEntry(selected.transport, selected.command ?? "", selected.url ?? "", {}))} lang="json" />
            </Field>
          </>
        )}
      </DetailDrawer>

      <AddServerDialog open={adding} onOpenChange={setAdding} onAdded={setSelectedId} />
    </>
  );
}
