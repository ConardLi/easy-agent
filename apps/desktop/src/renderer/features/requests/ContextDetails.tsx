import { ArrowRight, ChevronRight, GitCompareArrows, Layers, RefreshCw } from "lucide-react";
import { useState } from "react";
import { ContextRing } from "../../design/ContextRing";
import { Button, cn } from "../../design/primitives";
import { componentName, componentSource, configureTarget, GROUPS, number, partName, type ConfigureTarget, type ContextData } from "./model";

export function ContextDetails({
  data,
  error,
  busy,
  onRetry,
  onConfigure,
  onCompare,
  onCompact,
}: {
  data?: ContextData;
  error?: string;
  busy?: boolean;
  onRetry: () => void;
  onConfigure: (target: ConfigureTarget) => void;
  onCompare: () => void;
  onCompact: () => void;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) =>
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const request = data?.request;
  const used = data?.used ?? 0;
  const windowSize = data?.contextWindow || 1;
  const hit = request && request.inputTokens > 0 ? Math.round(((request.cacheReadTokens ?? 0) / request.inputTokens) * 100) : 0;
  const groups = data
    ? [
        ...data.categories.map((category) => ({
          ...category,
          rows:
            data.basis === "request"
              ? data.components.filter((c) => c.category === category.id)
              : category.items.map((item) => ({
                  id: `estimate:${category.id}:${item.id}`,
                  part: category.id,
                  category: category.id,
                  item: item.id,
                  tokens: item.tokens,
                  bytes: 0,
                  count: 1,
                })),
        })),
        ...(data.components.some((c) => c.category === null)
          ? [
              {
                id: "request",
                tokens: 0,
                items: [],
                rows: data.components.filter((c) => c.category === null),
              },
            ]
          : []),
      ]
    : [];
  return (
    <div data-context-detail className="flex flex-col gap-3 p-3">
      {error && (
        <div role="alert" className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-[12px] text-danger">
          {error}
          <Button size="sm" variant="ghost" onClick={onRetry}>
            <RefreshCw />
            重试
          </Button>
        </div>
      )}
      <div className="rounded-xl border border-line bg-canvas p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="text-[12px] font-medium text-fg">{data?.basis === "request" ? "最近实际请求" : "下一次请求 · 估算"}</span>
          <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10.5px] text-fg-3">{busy ? "本轮进行中" : "上下文"}</span>
        </div>
        <div className="flex items-center gap-4">
          <div className="relative shrink-0">
            <ContextRing used={used} total={windowSize} size={56} stroke={5} />
            <span className="tabular absolute inset-0 flex items-center justify-center text-[12px] font-semibold">
              {data ? `${Math.round((used / windowSize) * 100)}%` : "–"}
            </span>
          </div>
          <div className="min-w-0">
            <div className="tabular text-[20px] font-semibold tracking-[-0.02em]">
              {data ? number(used) : "–"}
              <span className="ml-1 text-[12px] font-normal text-fg-3">/ {data ? number(windowSize) : "–"}</span>
            </div>
            <div className="mt-0.5 text-[11px] text-fg-3">
              {!data ? "正在读取上下文…" : data.estimated ? "Token 估算 · 组件按大小计算" : "提供方计数 · 组件按比例分摊"}
            </div>
          </div>
        </div>
        {data && (
          <div className="mt-3 flex h-1.5 gap-px overflow-hidden rounded-full">
            {data.categories
              .filter((g) => g.tokens > 0)
              .map((g) => (
                <span key={g.id} title={`${GROUPS[g.id]?.label ?? g.id} ${number(g.tokens)}`} style={{ flexGrow: g.tokens, background: GROUPS[g.id]?.color }} />
              ))}
            <span className="bg-surface-3" style={{ flexGrow: Math.max(0, windowSize - used) }} />
          </div>
        )}
        {request ? (
          <>
            <div className="mt-3 break-all font-mono text-[10.5px] leading-relaxed text-fg-3">
              {request.model} · {request.protocol}
              <br />
              {number(request.bytes)} B · {request.requestId}
            </div>
            {request.tokens.countError && (
              <p className="mt-1 text-[11px] text-fg-3">
                {request.tokens.countError === "unsupported" ? "提供方不支持 token 计数，已使用估算。" : "Token 计数失败，已使用估算。"}
              </p>
            )}
            {request.unsent.messages > 0 && (
              <p className="mt-2 border-t border-line pt-2 text-[11px] leading-relaxed text-fg-3">
                含 {request.unsent.messages} 条尚未发送的消息（估算 {number(request.unsent.tokens)} token），已合并在下方消息来源中。
              </p>
            )}
            {request.protocol !== "anthropic" && <p className="mt-1 text-[11px] text-fg-3">组件字节数按协议转换前统计，请求大小为转换后的实际大小。</p>}
          </>
        ) : (
          data && <p className="mt-2 text-[11px] leading-relaxed text-fg-3">还没有可用的请求记录。发送消息后可查看组件来源和缓存命中。</p>
        )}
      </div>
      {request && (
        <div className="grid grid-cols-3 gap-2">
          {[
            ["缓存命中", `${hit}%`],
            ["缓存读取", number(request.cacheReadTokens ?? 0)],
            ["缓存写入", number(request.cacheWriteTokens ?? 0)],
          ].map(([label, value]) => (
            <div key={label} data-metric={label} className="rounded-lg border border-line bg-canvas px-2.5 py-2">
              <div className="text-[10.5px] text-fg-3">{label}</div>
              <div className="tabular mt-0.5 text-[15px] font-semibold">{value}</div>
            </div>
          ))}
        </div>
      )}
      <div className="overflow-hidden rounded-xl border border-line bg-canvas">
        {groups.map((group) => (
          <div key={group.id} className="border-b border-line last:border-b-0">
            <button
              type="button"
              aria-expanded={open.has(group.id)}
              disabled={!group.rows.length}
              onClick={() => toggle(group.id)}
              className="flex w-full items-center gap-2.5 px-3 py-3 text-left enabled:hover:bg-surface-2/50"
            >
              <span className="h-5 w-1 rounded-full" style={{ background: GROUPS[group.id]?.color }} />
              <span className="flex-1 text-[12.5px] font-medium">
                {GROUPS[group.id]?.label ?? group.id} <span className="ml-1 text-[10.5px] font-normal text-fg-3">{group.rows.length}</span>
              </span>
              <span className="tabular text-[12px] text-fg-2">
                {group.id === "request" ? `${number(group.rows.reduce((n, r) => n + r.bytes, 0))} B` : `${data?.estimated ? "≈" : "∼"}${number(group.tokens)}`}
              </span>
              <ChevronRight className={cn("size-3.5 text-fg-4", open.has(group.id) && "rotate-90")} />
            </button>
            {open.has(group.id) && (
              <div className="px-2 pb-2">
                {group.rows.map((row) => {
                  const item = group.items.find((i) => i.id === row.item);
                  const estimated = row.id.startsWith("estimate:");
                  const label = estimated ? (item?.label ?? row.item) : componentName(row.id);
                  const target = estimated ? undefined : configureTarget(row.id, row.category, row.item);
                  return (
                    <div key={row.id} data-component={row.id} className="rounded-lg border border-transparent hover:border-line">
                      <button
                        type="button"
                        aria-expanded={open.has(row.id)}
                        onClick={() => toggle(row.id)}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-surface-2/60"
                      >
                        <ChevronRight className={cn("size-3 shrink-0 text-fg-4", open.has(row.id) && "rotate-90")} />
                        <span className="min-w-0 flex-1 truncate text-[12px] text-fg">{label}</span>
                        <span className="tabular text-[11px] text-fg-3">
                          {row.part === "request" ? `${number(row.bytes)} B` : `${data?.estimated ? "≈" : "∼"}${number(row.tokens)}`}
                        </span>
                      </button>
                      {open.has(row.id) && (
                        <div className="px-3 pb-3 text-[11px] leading-relaxed text-fg-3">
                          <p className="break-all">来源：{estimated ? (item?.source ?? "估算") : componentSource(row.id, item)}</p>
                          {!estimated && (
                            <>
                              <p className="mt-1 break-all font-mono">{row.id}</p>
                              <p className="mt-1">
                                {partName(row.part)} · {number(row.bytes)} B · {row.count} 项
                                {row.part === "request" ? "" : data?.estimated ? " · token 估算" : " · token 按比例分摊"}
                              </p>
                            </>
                          )}
                          {target && (
                            <button
                              type="button"
                              onClick={() => onConfigure(target)}
                              className="mt-2 flex items-center gap-1 text-[11.5px] font-medium text-accent hover:underline"
                            >
                              在 Harness 中配置
                              <ArrowRight className="size-3" />
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
      <Button variant="secondary" size="sm" onClick={onCompare}>
        <GitCompareArrows />
        请求对比
      </Button>
      <Button variant="ghost" size="sm" disabled={busy || !data?.categories.some((g) => g.id === "messages" && g.tokens > 0)} onClick={onCompact}>
        <Layers />
        压缩对话消息
      </Button>
    </div>
  );
}
