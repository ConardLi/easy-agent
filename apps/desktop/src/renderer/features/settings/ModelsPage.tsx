import { Check, ChevronDown, ChevronRight, ExternalLink, Eye, EyeOff, Minus, Plus, Search, Settings2, Star, Trash2, TriangleAlert } from "lucide-react";
import { Popover } from "radix-ui";
import { useEffect, useMemo, useState } from "react";
import { type BrandId, BrandIcon, modelBrand } from "../../design/BrandIcon";
import { Modal } from "../../design/Overlays";
import { Button, cn, IconButton, Segmented, Spinner, Switch, Tooltip } from "../../design/primitives";
import { desktop } from "../../lib/desktop";
import { tokens } from "../../lib/format";
import { listModels, modelById } from "../../lib/modelIndex";
import {
  type ModelEntry,
  PROTOCOLS,
  type Protocol,
  type ProviderConfig,
  type ProviderTemplate,
  profileJson,
  requestPath,
  TEMPLATES,
  templateById,
} from "../../lib/models";
import { SCOPE_FILE, SCOPE_LABEL, WRITE_SCOPES, type WriteScope } from "../../lib/scopes";
import { checkProvider, fetchProviderModels, updateAgent, updateProviders, useSettings } from "../../state/settings";
import { useUi } from "../../state/ui";
import { CodeBlock } from "../session/Markdown";
import { type AgentSettings, type SettingKey, TODO_SETTINGS } from "./agentSettings";
import { keyName } from "./providers";
import { NumberInput, ScopeTag, Select } from "./controls";

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

const FAMILY: Partial<Record<BrandId, string>> = {
  claude: "Claude",
  openai: "GPT",
  codex: "GPT",
  gemini: "Gemini",
  gemma: "Gemma",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  kimi: "Kimi",
  chatglm: "GLM",
  minimax: "MiniMax",
  doubao: "Doubao",
  grok: "Grok",
  mistral: "Mistral",
  meta: "Llama",
};

const familyOf = (model: string) => FAMILY[modelBrand(model) as BrandId] ?? "其他";

function groupByFamily<T extends { model: string }>(list: T[]): [string, T[]][] {
  const map = new Map<string, T[]>();
  for (const m of list) map.set(familyOf(m.model), [...(map.get(familyOf(m.model)) ?? []), m]);
  return [...map.entries()];
}

function Tags({ m }: { m: Pick<ModelEntry, "capabilities"> }) {
  return (
    <span className="flex items-center gap-1">
      {m.capabilities.vision && <span className="rounded-[5px] bg-success/12 px-1.5 text-[10.5px] leading-[18px] text-success">视觉</span>}
      {m.capabilities.reasoning && <span className="rounded-[5px] bg-[#a78bfa]/15 px-1.5 text-[10.5px] leading-[18px] text-[#a78bfa]">推理</span>}
      {!m.capabilities.tools && <span className="rounded-[5px] bg-warning/12 px-1.5 text-[10.5px] leading-[18px] text-warning">不支持工具</span>}
    </span>
  );
}

const PROTOCOL_LABEL: Record<Protocol, string> = {
  anthropic: "Anthropic",
  "openai-chat": "OpenAI 兼容",
  "openai-responses": "OpenAI Responses",
  gemini: "Gemini",
};

const isEnvRef = (v: string) => /^\$\{[A-Z0-9_]+\}$/i.test(v.trim());

function keyText(p: ProviderConfig): string {
  if (p.key.kind === "env") return `\${${p.key.name}}`;
  if (p.key.kind === "keychain") return p.key.masked;
  if (p.key.kind === "inline") return "已写在配置文件里";
  return "";
}

const useAgent = (): AgentSettings => useSettings((s) => s.agent)!;
const update = (fn: (a: AgentSettings) => AgentSettings, keys: SettingKey[]) => void updateAgent(fn, keys);

/** A virtual provider for a template that has not been configured yet. */
function fromTemplate(t: ProviderTemplate): ProviderConfig {
  return {
    id: t.id,
    templateId: t.id,
    name: t.name,
    icon: t.icon,
    protocol: t.protocol,
    baseURL: t.baseURL,
    key: { kind: "none" },
    enabled: false,
    headers: [],
    models: t.catalog.slice(0, 2).map((m) => ({ ...m })),
    scope: "user",
  };
}

/* ------------------------------------------------------------------ */
/* Model picker for the default models                                 */
/* ------------------------------------------------------------------ */

function ModelSelect({ value, onChange, inherit }: { value?: string; onChange: (v: string | undefined) => void; inherit?: string }) {
  const providers = useSettings((s) => s.providers);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const models = listModels(providers).filter((m) => !q || `${m.label} ${m.id} ${m.provider}`.toLowerCase().includes(q.toLowerCase()));
  const current = value ? modelById(value) : null;
  const groups = [...new Set(models.map((m) => m.providerId))];

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="flex h-9 w-[300px] items-center gap-2.5 rounded-[10px] border border-line bg-surface px-2.5 text-left text-[13px] text-fg transition-colors hover:border-line-strong data-[state=open]:border-accent-line"
        >
          {current ? (
            <>
              <BrandIcon id={current.icon} size={18} />
              <span className="min-w-0 flex-1 truncate">{current.label}</span>
              <span className="truncate text-[11.5px] text-fg-3">{current.provider}</span>
            </>
          ) : (
            <span className="flex-1 text-fg-3">{inherit}</span>
          )}
          <ChevronDown className="size-3.5 shrink-0 text-fg-3" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={12}
          className="pop-in z-[95] w-[320px] overflow-hidden rounded-xl border border-line bg-elevated shadow-pop outline-none"
        >
          <div className="flex h-10 items-center gap-2 border-b border-line px-3">
            <Search className="size-3.5 text-fg-3" />
            <input
              // biome-ignore lint/a11y/noAutofocus: the picker opens to search
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索模型"
              className="h-full flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-3"
            />
          </div>
          <div className="scroll-thin max-h-[320px] overflow-y-auto p-1">
            {inherit && (
              <button
                type="button"
                onClick={() => {
                  onChange(undefined);
                  setOpen(false);
                }}
                className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[13px] text-fg-2 hover:bg-surface-2"
              >
                <span className="size-[18px] rounded-md border border-dashed border-fg-4" />
                {inherit}
                {!value && <Check className="ml-auto size-3.5 text-accent" />}
              </button>
            )}
            {groups.map((pid) => {
              const p = providers.find((x) => x.id === pid);
              return (
                <div key={pid}>
                  <div className="flex items-center gap-1.5 px-2 pb-1 pt-2 text-[11px] font-medium text-fg-3">
                    <BrandIcon id={p?.icon} size={11} />
                    {p?.name}
                  </div>
                  {models
                    .filter((m) => m.providerId === pid)
                    .map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => {
                          onChange(m.id);
                          setOpen(false);
                        }}
                        className={cn(
                          "flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[13px] text-fg hover:bg-surface-2",
                          m.id === value && "bg-surface-2",
                        )}
                      >
                        <BrandIcon id={m.icon} size={18} />
                        <span className="min-w-0 flex-1 truncate">{m.label}</span>
                        {m.id === value && <Check className="size-3.5 text-accent" />}
                      </button>
                    ))}
                </div>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/* ------------------------------------------------------------------ */
/* Default models                                                      */
/* ------------------------------------------------------------------ */

function DefaultsPane() {
  const agent = useAgent();
  const sources = useSettings((s) => s.sources);
  const updateAgent = update;

  const rows = [
    { key: "defaultModel", title: "默认模型", hint: "新会话用这个模型，/model 可以在会话里临时换", value: agent.defaultModel, role: null },
    {
      key: "modelRoles.background",
      title: "后台任务",
      hint: "后台子 Agent 和团队队友。选一个便宜快速的模型能省不少钱",
      value: agent.modelRoles.background,
      role: "background",
    },
    { key: "modelRoles.think", title: "深度思考", hint: "开启扩展思考的请求改用这个模型", value: agent.modelRoles.think, role: "think" },
    {
      key: "modelRoles.longContext",
      title: "长上下文",
      hint: "对话快要超出默认模型的上下文时切换过去",
      value: agent.modelRoles.longContext,
      role: "longContext",
    },
    { key: "autoModeModel", title: "自动模式审核", hint: "自动模式下判断每个工具调用是否安全，选一个快的小模型", value: undefined, role: "autoMode" },
  ] as const;
  const todo = (k: string) =>
    k in TODO_SETTINGS ? (
      <Tooltip content={`settings.json 里还没有这一项，现在通过 ${TODO_SETTINGS[k]} 设置`}>
        <span className="rounded-[5px] bg-warning/12 px-1.5 text-[10px] font-semibold leading-[18px] text-warning">TODO</span>
      </Tooltip>
    ) : null;

  return (
    <div className="max-w-[760px] px-10 py-8">
      <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-fg">默认模型</h2>
      <p className="mt-1 text-[13px] text-fg-3">不同的任务可以交给不同的模型。没有单独指定的，都用默认模型。</p>

      <div className="mt-6 divide-y divide-line rounded-xl border border-line bg-canvas">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center justify-between gap-6 px-4 py-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[13.5px] font-medium text-fg">
                {r.title}
                {todo(r.key) ?? <ScopeTag scope={sources[r.key as SettingKey]} />}
              </div>
              <div className="mt-0.5 text-[12.5px] text-fg-3">{r.hint}</div>
            </div>
            <span className={cn(r.role === "autoMode" && "pointer-events-none opacity-45")}>
              <ModelSelect
                value={r.value}
                inherit={r.role ? "跟随默认模型" : undefined}
                onChange={(v) => {
                  if (r.role === null) {
                    if (v) updateAgent((a) => ({ ...a, defaultModel: v }), ["defaultModel"]);
                  } else if (r.role !== "autoMode") updateAgent((a) => ({ ...a, modelRoles: { ...a.modelRoles, [r.role]: v } }), [r.key as SettingKey]);
                }}
              />
            </span>
          </div>
        ))}
      </div>

      <h3 className="mt-8 text-[14px] font-semibold text-fg">思考</h3>
      <div className="mt-3 divide-y divide-line rounded-xl border border-line bg-canvas">
        <div className="flex items-center justify-between gap-6 px-4 py-4">
          <div>
            <div className="flex items-center gap-2 text-[13.5px] font-medium text-fg">
              默认开启扩展思考
              <ScopeTag scope={sources.alwaysThinkingEnabled} />
            </div>
            <div className="mt-0.5 text-[12.5px] text-fg-3">会话里可以用 /think 临时开关</div>
          </div>
          <Switch checked={agent.alwaysThinkingEnabled} onChange={(v) => updateAgent((a) => ({ ...a, alwaysThinkingEnabled: v }), ["alwaysThinkingEnabled"])} />
        </div>
        <div className="flex items-center justify-between gap-6 px-4 py-4">
          <div>
            <div className="flex items-center gap-2 text-[13.5px] font-medium text-fg">
              思考强度
              <ScopeTag scope={sources.effortLevel} />
            </div>
            <div className="mt-0.5 text-[12.5px] text-fg-3">目前只对 Anthropic 接口生效</div>
          </div>
          <Segmented
            value={agent.effortLevel}
            onChange={(effortLevel) => updateAgent((a) => ({ ...a, effortLevel }), ["effortLevel"])}
            options={[
              { value: "low", label: "低" },
              { value: "medium", label: "中" },
              { value: "high", label: "高" },
              { value: "max", label: "最大" },
            ]}
          />
        </div>
        <div className="flex items-center justify-between gap-6 px-4 py-4">
          <div>
            <div className="flex items-center gap-2 text-[13.5px] font-medium text-fg">
              思考预算
              {todo("thinkingBudget")}
            </div>
            <div className="mt-0.5 text-[12.5px] text-fg-3">不支持自适应思考的模型，每次最多用这么多 token 思考</div>
          </div>
          <span className="pointer-events-none opacity-45">
            <NumberInput value={10_000} min={1024} step={1024} suffix="tokens" width={160} onChange={() => {}} />
          </span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Dialogs                                                             */
/* ------------------------------------------------------------------ */

function ModelDialog({
  entry,
  existing,
  onSave,
  onClose,
}: {
  entry: ModelEntry | null;
  existing: string[];
  onSave: (m: ModelEntry) => void;
  onClose: () => void;
}) {
  const [m, setM] = useState<ModelEntry>(
    entry ?? {
      handle: "",
      model: "",
      name: "",
      contextWindow: 128_000,
      maxOutput: 8_192,
      capabilities: { tools: true, vision: false, reasoning: false, cache: false },
      enabled: true,
    },
  );
  const [advanced, setAdvanced] = useState(false);
  const handle = m.handle || m.model.split("/").pop()?.replace(/:/g, "-") || "";
  const taken = existing.includes(handle) && handle !== entry?.handle;
  const toggle = (k: "vision" | "reasoning" | "tools") => setM((x) => ({ ...x, capabilities: { ...x.capabilities, [k]: !x.capabilities[k] } }));

  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      width={480}
      title={entry ? "编辑模型" : "添加模型"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={!m.model.trim() || taken} onClick={() => onSave({ ...m, handle, name: m.name.trim() || m.model.trim() })}>
            保存
          </Button>
        </>
      }
    >
      <label className="mb-4 block">
        <span className="mb-1.5 block text-[12.5px] font-medium text-fg-2">模型 ID</span>
        <input
          // biome-ignore lint/a11y/noAutofocus: the dialog opens to type the id
          autoFocus
          value={m.model}
          onChange={(e) => setM((x) => ({ ...x, model: e.target.value }))}
          placeholder="例如 deepseek-chat"
          className="h-9 w-full rounded-[10px] border border-line bg-surface px-3 font-mono text-[13px] text-fg outline-none focus:border-accent-line"
        />
      </label>
      <label className="mb-4 block">
        <span className="mb-1.5 block text-[12.5px] font-medium text-fg-2">显示名称</span>
        <input
          value={m.name}
          onChange={(e) => setM((x) => ({ ...x, name: e.target.value }))}
          placeholder={m.model || "可选"}
          className="h-9 w-full rounded-[10px] border border-line bg-surface px-3 text-[13px] text-fg outline-none focus:border-accent-line"
        />
      </label>
      <div className="mb-4">
        <span className="mb-1.5 block text-[12.5px] font-medium text-fg-2">能力</span>
        <div className="flex gap-2">
          {(
            [
              ["vision", "视觉"],
              ["reasoning", "推理"],
              ["tools", "工具调用"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => toggle(k)}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12.5px] transition-colors",
                m.capabilities[k] ? "border-accent-line bg-accent-softer text-fg" : "border-line text-fg-3 hover:text-fg-2",
              )}
            >
              {m.capabilities[k] && <Check className="size-3.5 text-accent" />}
              {label}
            </button>
          ))}
        </div>
        {!m.capabilities.tools && <p className="mt-2 text-[12px] text-warning">不支持工具调用的模型不能读写文件和执行命令。</p>}
      </div>
      <button type="button" onClick={() => setAdvanced((v) => !v)} className="flex items-center gap-1 text-[12.5px] text-fg-3 hover:text-fg">
        <ChevronRight className={cn("size-3.5 transition-transform", advanced && "rotate-90")} />
        更多选项
      </button>
      {advanced && (
        <div className="mt-3 grid grid-cols-2 gap-3 rounded-xl bg-surface p-3">
          <label className="col-span-2 block">
            <span className="mb-1 block text-[11.5px] text-fg-3">句柄（/model 里用的名字）</span>
            <input
              value={m.handle}
              onChange={(e) => setM((x) => ({ ...x, handle: e.target.value.replace(/\s/g, "-") }))}
              placeholder={handle || "跟模型 ID 相同"}
              className="h-8 w-full rounded-lg border border-line bg-canvas px-2.5 font-mono text-[12.5px] text-fg outline-none focus:border-accent-line"
            />
            {taken && <span className="mt-1 block text-[11.5px] text-danger">这个句柄已被别的模型使用</span>}
          </label>
          <div className="block">
            <span className="mb-1 block text-[11.5px] text-fg-3">上下文窗口（TODO：settings.json 还不能保存）</span>
            <NumberInput value={m.contextWindow} onChange={(contextWindow) => setM((x) => ({ ...x, contextWindow }))} step={1000} width={200} />
          </div>
          <div className="block">
            <span className="mb-1 block text-[11.5px] text-fg-3">最大输出（maxTokens，0 表示默认）</span>
            <NumberInput value={m.maxOutput} onChange={(maxOutput) => setM((x) => ({ ...x, maxOutput }))} step={1024} width={200} />
          </div>
        </div>
      )}
    </Modal>
  );
}

function ManageDialog({
  p,
  onToggle,
  onAddAll,
  onClose,
}: {
  p: ProviderConfig;
  onToggle: (m: ModelEntry, add: boolean) => void;
  onAddAll: (models: ModelEntry[]) => void;
  onClose: () => void;
}) {
  const t = templateById(p.templateId);
  const [fetched, setFetched] = useState<string[] | null | undefined>(undefined);
  const [q, setQ] = useState("");
  useEffect(() => {
    let current = true;
    void fetchProviderModels(p).then((ids) => current && setFetched(ids));
    return () => {
      current = false;
    };
  }, [p]);
  const loading = fetched === undefined;
  const have = new Set(p.models.map((m) => m.model));
  // The provider's own list when it answers, with catalog details where the model is known.
  const known = new Map(t.catalog.map((m) => [m.model, m]));
  const source: ModelEntry[] = fetched
    ? fetched.map(
        (id) =>
          known.get(id) ?? {
            handle: id.split("/").pop()!.replace(/:/g, "-"),
            model: id,
            name: id,
            contextWindow: 128_000,
            maxOutput: 0,
            capabilities: { tools: true, vision: false, reasoning: false, cache: false },
            enabled: true,
          },
      )
    : t.catalog;
  const list = source.filter((m) => !q || `${m.model} ${m.name}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      width={560}
      title={`${p.name} 的模型`}
      footer={
        <>
          <Button variant="ghost" onClick={() => onAddAll(list.filter((m) => !have.has(m.model)))}>
            全部添加
          </Button>
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        </>
      }
    >
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-fg-3" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索模型"
          className="h-9 w-full rounded-[10px] border border-line bg-surface pl-9 pr-3 text-[13px] text-fg outline-none focus:border-accent-line"
        />
      </div>
      {loading ? (
        <div className="flex h-40 items-center justify-center gap-2 text-[12.5px] text-fg-3">
          <Spinner />
          正在获取模型列表
        </div>
      ) : list.length === 0 ? (
        <div className="py-12 text-center text-[12.5px] text-fg-3">
          {fetched === null && p.models.length === 0 ? "先添加一个模型，才能从服务商获取列表。" : "这个服务商没有返回模型列表，请用「添加」手动填写模型 ID。"}
        </div>
      ) : (
        groupByFamily(list).map(([family, items]) => (
          <div key={family} className="mb-3">
            <div className="mb-1 px-1 text-[11.5px] font-medium text-fg-3">{family}</div>
            <div className="overflow-hidden rounded-xl border border-line">
              {items.map((m) => {
                const added = have.has(m.model);
                return (
                  <div key={m.model} className="flex items-center gap-3 border-b border-line px-3 py-2.5 last:border-b-0">
                    <BrandIcon id={modelBrand(m.model) ?? p.icon} size={20} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] text-fg">{m.name}</span>
                        <Tags m={m} />
                      </div>
                      <div className="font-mono text-[11px] text-fg-3">{m.model}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onToggle(m, !added)}
                      className={cn(
                        "flex size-7 items-center justify-center rounded-full transition-colors",
                        added ? "bg-surface-2 text-fg-2 hover:bg-danger/12 hover:text-danger" : "bg-accent text-accent-fg hover:bg-accent-hover",
                      )}
                      aria-label={added ? "移除" : "添加"}
                    >
                      {added ? <Minus className="size-3.5" /> : <Plus className="size-3.5" />}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}
    </Modal>
  );
}

function AddProviderDialog({ onAdd, onClose }: { onAdd: (name: string, protocol: Protocol, baseURL: string) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<Protocol>("openai-chat");
  const [url, setUrl] = useState("");
  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      width={440}
      title="添加服务商"
      description="公司网关、自建推理服务，或者任何兼容这几种接口的服务。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={!name.trim()} onClick={() => onAdd(name.trim(), protocol, url.trim())}>
            添加
          </Button>
        </>
      }
    >
      <label className="mb-4 block">
        <span className="mb-1.5 block text-[12.5px] font-medium text-fg-2">名称</span>
        <input
          // biome-ignore lint/a11y/noAutofocus: the dialog opens to type
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如 公司网关"
          className="h-9 w-full rounded-[10px] border border-line bg-surface px-3 text-[13px] text-fg outline-none focus:border-accent-line"
        />
      </label>
      <div className="mb-4">
        <span className="mb-1.5 block text-[12.5px] font-medium text-fg-2">接口类型</span>
        <Select value={protocol} onChange={setProtocol} options={PROTOCOLS.map((x) => ({ value: x.id, label: PROTOCOL_LABEL[x.id] }))} width={392} />
      </div>
      <label className="block">
        <span className="mb-1.5 block text-[12.5px] font-medium text-fg-2">API 地址</span>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://llm.example.com/v1"
          className="h-9 w-full rounded-[10px] border border-line bg-surface px-3 font-mono text-[12.5px] text-fg outline-none focus:border-accent-line"
        />
      </label>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Provider                                                            */
/* ------------------------------------------------------------------ */

/** Request headers, edited locally and saved when a field loses focus. */
function HeadersEditor({ headers, onCommit }: { headers: ProviderConfig["headers"]; onCommit: (headers: ProviderConfig["headers"]) => void }) {
  const [rows, setRows] = useState(headers);
  const commit = (next = rows) => JSON.stringify(next) !== JSON.stringify(headers) && onCommit(next.filter((h) => h.name.trim()));
  const edit = (i: number, patch: Partial<ProviderConfig["headers"][number]>) => setRows((r) => r.map((y, j) => (j === i ? { ...y, ...patch } : y)));
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((h, i) => (
        <div key={i} className="flex gap-1.5">
          <input
            value={h.name}
            onChange={(e) => edit(i, { name: e.target.value })}
            onBlur={() => commit()}
            placeholder="名称"
            className="h-8 w-[180px] rounded-lg border border-line bg-surface px-2.5 font-mono text-[12.5px] text-fg outline-none focus:border-accent-line"
          />
          <input
            value={h.value}
            onChange={(e) => edit(i, { value: e.target.value })}
            onBlur={() => commit()}
            placeholder="值，可以用 ${ENV}"
            className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 font-mono text-[12.5px] text-fg outline-none focus:border-accent-line"
          />
          <IconButton
            aria-label="删除请求头"
            onClick={() => {
              const next = rows.filter((_, j) => j !== i);
              setRows(next);
              commit(next);
            }}
          >
            <Minus />
          </IconButton>
        </div>
      ))}
      <button
        type="button"
        onClick={() => setRows((r) => [...r, { name: "", value: "" }])}
        className="flex items-center gap-1 self-start text-[12.5px] text-fg-3 hover:text-fg"
      >
        <Plus className="size-3.5" />
        添加请求头
      </button>
    </div>
  );
}

function ProviderPane({ p, save }: { p: ProviderConfig; save: (fn: (x: ProviderConfig) => ProviderConfig) => Promise<void> }) {
  const agent = useAgent();
  const updateAgent = update;
  const providers = useSettings((s) => s.providers);
  const result = useSettings((s) => s.checks[p.id]);
  const allHandles = useMemo(() => providers.flatMap((x) => x.models.map((m) => m.handle)), [providers]);
  const toast = useUi((s) => s.toast);
  const t = templateById(p.templateId);
  const [key, setKey] = useState(keyText(p));
  const [baseURL, setBaseURL] = useState(p.baseURL);
  const [showKey, setShowKey] = useState(false);
  const [editing, setEditing] = useState<ModelEntry | "new" | null>(null);
  const [managing, setManaging] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [json, setJson] = useState(false);
  const custom = p.templateId === "custom";
  const checking = result?.checking === true;
  const openLink = (path: string) => void desktop.app.openExternal(`https://${path}`);

  /** Keys typed here go to the keychain; `${NAME}` stays a reference to an environment variable. */
  const commitKey = async () => {
    const v = key.trim();
    if (v === keyText(p)) return;
    await save((x) => ({
      ...x,
      enabled: x.enabled || v.length > 0,
      key: !v ? { kind: "none" } : isEnvRef(v) ? { kind: "env", name: v.slice(2, -1) } : { kind: "keychain", name: keyName(x.id), masked: "", value: v },
    }));
    if (v && !isEnvRef(v)) setKey(`${v.slice(0, 3)}••••••••${v.slice(-4)}`);
  };

  const check = async () => {
    await commitKey();
    const current = useSettings.getState().providers.find((x) => x.id === p.id) ?? p;
    await checkProvider(current);
  };

  const header = (
    <div className="flex items-center gap-3">
      <BrandIcon id={p.icon} size={32} tile />
      <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-fg">{p.name}</h2>
      {t.keyUrl && (
        <Tooltip content="打开服务商控制台">
          <button type="button" onClick={() => openLink(t.keyUrl!)} className="text-fg-3 hover:text-fg" aria-label="打开服务商控制台">
            <ExternalLink className="size-3.5" />
          </button>
        </Tooltip>
      )}
      <span className="flex-1" />
      {custom && (
        <Tooltip content="删除服务商">
          <IconButton
            onClick={() => {
              void updateProviders((list) => list.filter((x) => x.id !== p.id));
              toast(`已删除 ${p.name}`);
            }}
          >
            <Trash2 />
          </IconButton>
        </Tooltip>
      )}
      {!t.unsupported && <Switch checked={p.enabled} onChange={(enabled) => void save((x) => ({ ...x, enabled }))} />}
    </div>
  );

  if (t.unsupported) {
    return (
      <div className="max-w-[720px] px-10 py-8">
        {header}
        <div className="mt-6 flex items-start gap-2.5 rounded-xl border border-warning/30 bg-warning/[0.06] px-4 py-3 text-[13px] leading-[1.6] text-fg-2">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <div>
            {t.unsupported}
            <span className="ml-1.5 rounded bg-warning/15 px-1 text-[10px] font-semibold text-warning">TODO</span>
            <div className="text-[12.5px] text-fg-3">现在可以经过 OpenRouter 或公司网关这类 OpenAI 兼容的代理使用。</div>
          </div>
        </div>
      </div>
    );
  }

  const status = checking ? (
    <span className="flex items-center gap-1.5 text-fg-3">
      <Spinner className="size-3" />
      正在检测
    </span>
  ) : result?.ok ? (
    <span className="flex items-center gap-1.5 text-success">
      <Check className="size-3.5" />
      连接正常 · {result.latencyMs}ms
    </span>
  ) : result ? (
    <span className="flex min-w-0 items-center gap-1.5 text-danger">
      <TriangleAlert className="size-3.5 shrink-0" />
      <span className="truncate">{result.error}</span>
    </span>
  ) : null;

  const enabledModels = p.models;

  return (
    <div className="max-w-[720px] px-10 py-8">
      {header}

      <section className="mt-7">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[13px] font-medium text-fg">API 密钥</span>
          {t.keyUrl && (
            <button type="button" onClick={() => openLink(t.keyUrl!)} className="text-[12px] text-accent hover:underline">
              获取密钥
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type={showKey || isEnvRef(key) ? "text" : "password"}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onBlur={() => void commitKey()}
              placeholder={t.local ? "本地服务一般不需要" : "sk-..."}
              className="h-10 w-full rounded-[10px] border border-line bg-surface pl-3 pr-10 font-mono text-[13px] text-fg outline-none transition-colors focus:border-accent-line focus:bg-canvas"
            />
            {!isEnvRef(key) && (
              <IconButton size="sm" className="absolute right-2 top-1/2 -translate-y-1/2" onClick={() => setShowKey((v) => !v)} aria-label="显示密钥">
                {showKey ? <EyeOff /> : <Eye />}
              </IconButton>
            )}
          </div>
          <Button variant="secondary" className="h-10 px-4" onClick={() => void check()} disabled={checking}>
            检测
          </Button>
        </div>
        <div className="mt-1.5 flex min-h-[18px] items-center text-[12px]">
          {status ?? (
            <span className="text-fg-3">
              {isEnvRef(key) ? "从环境变量读取，配置文件里只写这个引用" : "密钥存在系统钥匙串里。也可以填 ${环境变量名}，从环境变量读取"}
            </span>
          )}
        </div>
      </section>

      <section className="mt-5">
        <div className="mb-2 text-[13px] font-medium text-fg">API 地址</div>
        <div className="flex gap-2">
          <input
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
            onBlur={() => baseURL !== p.baseURL && void save((x) => ({ ...x, baseURL: baseURL.trim() }))}
            placeholder="https://api.example.com/v1"
            className="h-10 min-w-0 flex-1 rounded-[10px] border border-line bg-surface px-3 font-mono text-[13px] text-fg outline-none transition-colors focus:border-accent-line focus:bg-canvas"
          />
          <select
            value={p.protocol}
            onChange={(e) => void save((x) => ({ ...x, protocol: e.target.value as Protocol }))}
            className="h-10 w-[160px] rounded-[10px] border border-line bg-surface px-2.5 text-[12.5px] text-fg outline-none focus:border-accent-line"
            title="接口类型"
          >
            {PROTOCOLS.map((x) => (
              <option key={x.id} value={x.id}>
                {PROTOCOL_LABEL[x.id]}
              </option>
            ))}
          </select>
        </div>
        <div className="mt-1.5 flex items-center gap-2 text-[12px] text-fg-3">
          <span className="truncate font-mono text-[11.5px]">
            {p.baseURL.replace(/\/+$/, "")}
            {requestPath(p.protocol, p.models[0]?.model ?? "{model}")}
          </span>
          {t.endpoints?.map((e) =>
            e.baseURL === p.baseURL ? null : (
              <button
                key={e.label}
                type="button"
                onClick={() => {
                  setBaseURL(e.baseURL);
                  void save((x) => ({ ...x, protocol: e.protocol, baseURL: e.baseURL }));
                }}
                className="shrink-0 text-accent hover:underline"
              >
                改用{e.label}接口
              </button>
            ),
          )}
        </div>
      </section>

      <section className="mt-7">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[13px] font-medium text-fg">模型</span>
          <span className="tabular rounded-md bg-surface-2 px-1.5 text-[11px] leading-[18px] text-fg-3">{enabledModels.length}</span>
        </div>
        {enabledModels.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-[12.5px] text-fg-3">
            还没有模型，点「管理」从服务商获取，或者「添加」手动填写
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-line">
            {groupByFamily(enabledModels).map(([family, items]) => (
              <div key={family}>
                <div className="border-b border-line bg-surface/60 px-3.5 py-1.5 text-[11.5px] font-medium text-fg-3">{family}</div>
                {items.map((m) => {
                  const isDefault = agent.defaultModel === m.handle;
                  return (
                    <div key={m.handle} className="group flex h-12 items-center gap-3 border-b border-line px-3.5 last:border-b-0">
                      <BrandIcon id={modelBrand(m.model) ?? p.icon} size={22} />
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="truncate text-[13px] text-fg">{m.name}</span>
                        <Tags m={m} />
                        {isDefault && <span className="rounded-[5px] bg-accent-soft px-1.5 text-[10.5px] leading-[18px] text-accent">默认</span>}
                      </div>
                      <span className="tabular text-[11.5px] text-fg-4 group-hover:hidden">{tokens(m.contextWindow)}</span>
                      <div className="hidden items-center gap-0.5 group-hover:flex">
                        {!isDefault && (
                          <Tooltip content="设为默认模型">
                            <IconButton size="sm" onClick={() => updateAgent((a) => ({ ...a, defaultModel: m.handle }), ["defaultModel"])}>
                              <Star />
                            </IconButton>
                          </Tooltip>
                        )}
                        <Tooltip content="编辑">
                          <IconButton size="sm" onClick={() => setEditing(m)}>
                            <Settings2 />
                          </IconButton>
                        </Tooltip>
                        <Tooltip content="移除">
                          <IconButton size="sm" onClick={() => void save((x) => ({ ...x, models: x.models.filter((y) => y.handle !== m.handle) }))}>
                            <Minus />
                          </IconButton>
                        </Tooltip>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 flex gap-2">
          <Button variant="secondary" onClick={() => setManaging(true)}>
            管理
          </Button>
          <Button variant="ghost" onClick={() => setEditing("new")}>
            <Plus />
            添加
          </Button>
        </div>
      </section>

      <section className="mt-8 border-t border-line pt-5">
        <button type="button" onClick={() => setAdvanced((v) => !v)} className="flex items-center gap-1 text-[13px] text-fg-2 hover:text-fg">
          <ChevronRight className={cn("size-3.5 transition-transform", advanced && "rotate-90")} />
          高级设置
        </button>
        {advanced && (
          <div className="mt-4 flex flex-col gap-5">
            <div className="flex items-center justify-between gap-6">
              <div>
                <div className="text-[13px] text-fg">保存位置</div>
                <div className="mt-0.5 text-[12px] text-fg-3">这个服务商的配置写进哪份 settings.json</div>
              </div>
              <Select
                value={p.scope}
                onChange={(scope: WriteScope) => void save((x) => ({ ...x, scope }))}
                options={WRITE_SCOPES.map((s) => ({ value: s, label: `${SCOPE_LABEL[s]} · ${SCOPE_FILE[s]}` }))}
                width={300}
              />
            </div>
            <div>
              <div className="mb-1.5 text-[13px] text-fg">自定义请求头</div>
              <HeadersEditor headers={p.headers} onCommit={(headers) => void save((x) => ({ ...x, headers }))} />
            </div>
            {p.protocol.startsWith("openai") && (
              <div className="flex items-center justify-between gap-6">
                <div>
                  <div className="text-[13px] text-fg">发送 prompt_cache_key</div>
                  <div className="mt-0.5 text-[12px] text-fg-3">让同一会话的请求命中同一份缓存，接口支持才打开</div>
                </div>
                <Switch
                  checked={p.promptCacheKey ?? p.baseURL.includes("api.openai.com")}
                  onChange={(promptCacheKey) => void save((x) => ({ ...x, promptCacheKey }))}
                />
              </div>
            )}
            <div>
              <button type="button" onClick={() => setJson((v) => !v)} className="text-[12.5px] text-accent hover:underline">
                {json ? "收起" : "查看"}写入的配置
              </button>
              {json && (
                <div className="mt-2">
                  <CodeBlock code={profileJson(p, SCOPE_FILE[p.scope])} lang="json" />
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {editing && (
        <ModelDialog
          entry={editing === "new" ? null : editing}
          existing={allHandles}
          onClose={() => setEditing(null)}
          onSave={(m) => {
            void save((x) => ({
              ...x,
              enabled: true,
              models: editing === "new" ? [...x.models, m] : x.models.map((y) => (y.handle === editing.handle ? m : y)),
            }));
            setEditing(null);
          }}
        />
      )}
      {managing && (
        <ManageDialog
          p={p}
          onClose={() => setManaging(false)}
          onToggle={(m, add) =>
            void save((x) => ({ ...x, enabled: true, models: add ? [...x.models, { ...m }] : x.models.filter((y) => y.model !== m.model) }))
          }
          onAddAll={(ms) => void save((x) => ({ ...x, enabled: true, models: [...x.models, ...ms.map((m) => ({ ...m }))] }))}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export function ModelsPage() {
  const providers = useSettings((s) => s.providers);
  const checks = useSettings((s) => s.checks);
  const defaultModel = useAgent().defaultModel;
  const [selected, setSelected] = useState("defaults");
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);

  /** Configured providers first (enabled on top), then the remaining templates. */
  const list = useMemo(() => {
    const configured = [...providers].sort((a, b) => Number(b.enabled) - Number(a.enabled));
    const rest = TEMPLATES.filter((t) => t.id !== "custom" && !providers.some((p) => p.templateId === t.id)).map(fromTemplate);
    return [...configured, ...rest.filter((t) => !templateById(t.templateId).unsupported), ...rest.filter((t) => templateById(t.templateId).unsupported)];
  }, [providers]);
  const shown = list.filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()));
  const current = list.find((p) => p.id === selected);

  /** Save a change; a template that was only listed becomes a configured provider. */
  const save = (id: string) => (fn: (x: ProviderConfig) => ProviderConfig) =>
    updateProviders((ps) => {
      const existing = ps.find((x) => x.id === id);
      if (existing) return ps.map((x) => (x.id === id ? fn(x) : x));
      const virtual = list.find((x) => x.id === id);
      return virtual ? [...ps, fn(virtual)] : ps;
    });

  return (
    <div className="flex h-full">
      <aside className="flex w-[248px] shrink-0 flex-col border-r border-line">
        <div className="p-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-3" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索服务商"
              className="h-8 w-full rounded-[9px] border border-line bg-surface pl-8 pr-2 text-[12.5px] text-fg outline-none focus:border-accent-line"
            />
          </div>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {!q && (
            <button
              type="button"
              onClick={() => setSelected("defaults")}
              className={cn(
                "mb-2 flex h-11 w-full items-center gap-2.5 rounded-[10px] px-2 text-left transition-colors",
                selected === "defaults" ? "bg-fg/[0.07]" : "hover:bg-fg/[0.04]",
              )}
            >
              <span className="flex size-7 items-center justify-center rounded-lg bg-accent-soft text-accent">
                <Star className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-fg">默认模型</span>
                <span className="block truncate text-[11px] text-fg-3">{modelById(defaultModel).label}</span>
              </span>
            </button>
          )}
          {shown.map((p) => {
            const unsupported = !!templateById(p.templateId).unsupported;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelected(p.id)}
                className={cn(
                  "flex h-10 w-full items-center gap-2.5 rounded-[10px] px-2 text-left transition-colors",
                  selected === p.id ? "bg-fg/[0.07]" : "hover:bg-fg/[0.04]",
                )}
              >
                <BrandIcon id={p.icon} size={24} tile className={cn(!p.enabled && "opacity-70")} />
                <span className={cn("min-w-0 flex-1 truncate text-[13px]", p.enabled ? "text-fg" : "text-fg-2")}>{p.name}</span>
                {p.enabled &&
                  (checks[p.id] && !checks[p.id]!.ok && !checks[p.id]!.checking ? (
                    <span className="size-1.5 rounded-full bg-danger" />
                  ) : (
                    <span className="rounded-[5px] bg-success/12 px-1.5 text-[10px] font-semibold leading-[16px] text-success">ON</span>
                  ))}
                {unsupported && <span className="text-[10.5px] text-fg-4">不支持</span>}
              </button>
            );
          })}
        </div>
        <div className="border-t border-line p-2.5">
          <Button variant="ghost" className="w-full" onClick={() => setAdding(true)}>
            <Plus />
            添加服务商
          </Button>
        </div>
      </aside>

      <div className="scroll-thin min-w-0 flex-1 overflow-y-auto">
        {current ? <ProviderPane key={current.id} p={current} save={save(current.id)} /> : <DefaultsPane />}
      </div>

      {adding && (
        <AddProviderDialog
          onClose={() => setAdding(false)}
          onAdd={(name, protocol, baseURL) => {
            // Saved once it has a model; until then it lives only in this window.
            const id = `custom-${keyName(name)}`;
            useSettings.setState((s) => ({
              providers: [
                ...s.providers,
                { id, templateId: "custom", name, icon: null, protocol, baseURL, key: { kind: "none" }, enabled: true, headers: [], models: [], scope: "user" },
              ],
            }));
            setSelected(id);
            setAdding(false);
          }}
        />
      )}
    </div>
  );
}
