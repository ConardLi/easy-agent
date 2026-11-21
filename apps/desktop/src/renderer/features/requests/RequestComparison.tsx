import { ChevronRight, GitCompareArrows } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, cn, Spinner } from "../../design/primitives";
import { componentName, delta, number, type ComparisonData } from "./model";

const KINDS = { prompt_section: "提示词段", context_source: "上下文来源", tool: "工具", message: "消息" };
const CHANGES = { added: "新增", removed: "移除", changed: "修改" };

export function RequestComparison({
  agents,
  initialA,
  compare,
}: {
  agents: string[];
  initialA: string;
  compare: (a: string, b: string, prompt: string) => Promise<ComparisonData>;
}) {
  const [a, setA] = useState(initialA);
  const [b, setB] = useState(agents.find((name) => name !== initialA) ?? initialA);
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<ComparisonData>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const version = useRef(0);
  useEffect(
    () => () => {
      version.current++;
    },
    [],
  );
  const reset = () => {
    version.current++;
    setResult(undefined);
    setError("");
    setBusy(false);
    setExpanded(new Set());
  };
  const run = async () => {
    const current = ++version.current;
    setBusy(true);
    setResult(undefined);
    setError("");
    try {
      const value = await compare(a, b, prompt);
      if (version.current === current) setResult(value);
    } catch (cause) {
      if (version.current === current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (version.current === current) setBusy(false);
    }
  };
  const selectClass = "mt-1 h-9 w-full rounded-lg border border-line bg-canvas px-2.5 font-mono text-[12px] text-fg outline-none focus:border-accent";
  return (
    <div data-request-comparison className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        {[
          { label: "Agent A", value: a, set: setA },
          { label: "Agent B", value: b, set: setB },
        ].map((side) => (
          <label key={side.label} className="text-[11.5px] font-medium text-fg-3">
            {side.label}
            <select
              aria-label={side.label}
              value={side.value}
              className={selectClass}
              onChange={(e) => {
                reset();
                side.set(e.target.value);
              }}
            >
              {agents.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <label className="block text-[11.5px] font-medium text-fg-3">
        共同输入
        <textarea
          aria-label="共同输入"
          value={prompt}
          onChange={(e) => {
            reset();
            setPrompt(e.target.value);
          }}
          rows={2}
          placeholder="输入同一段任务，看看两个 Agent 会发送什么"
          className="mt-1 block w-full resize-y rounded-lg border border-line bg-canvas px-3 py-2 text-[12.5px] leading-relaxed text-fg outline-none placeholder:text-fg-4 focus:border-accent"
        />
      </label>
      <div className="flex items-center justify-between gap-4">
        <p className="text-[11.5px] text-fg-3">渲染新会话的第一次请求，不调用模型或执行工具。</p>
        <Button size="sm" disabled={busy || !prompt.trim() || !agents.includes(a) || !agents.includes(b)} onClick={() => void run()}>
          {busy ? <Spinner /> : <GitCompareArrows />}
          {busy ? "正在对比" : "生成对比"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger">
          {error}
        </p>
      )}
      {result && (
        <>
          <div className="grid grid-cols-2 gap-3">
            {[result.a, result.b].map((side, index) => (
              <div key={index === 0 ? "a" : "b"} className="rounded-xl border border-line bg-canvas px-4 py-3">
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="text-fg-4">{index === 0 ? "A" : "B"}</span>
                  <span className="font-mono font-medium">{side.harness.name}</span>
                  <span className="ml-auto truncate text-[10.5px] text-fg-3">{side.model}</span>
                </div>
                <div className="tabular mt-2 text-[21px] font-semibold">
                  {number(side.tokens.total)} <span className="text-[11px] font-normal text-fg-3">token · {side.components} 个组件</span>
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-fg-3">
            <span>
              {result.components.length} 项变化 · {result.unchanged} 项相同
            </span>
            <span className="tabular">B − A：{delta(result.b.tokens.total - result.a.tokens.total)} token</span>
            <span className="ml-auto">全部 token 均为估算</span>
          </div>
          {result.params.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-line">
              {result.params.map((p) => (
                <div key={p.key} className="grid grid-cols-[140px_1fr_1fr] gap-3 border-b border-line px-3 py-2 font-mono text-[11px] last:border-b-0">
                  <span className="text-fg-3">{p.key}</span>
                  <span className="break-all">{JSON.stringify(p.a) ?? "未设置"}</span>
                  <span className="break-all">{JSON.stringify(p.b) ?? "未设置"}</span>
                </div>
              ))}
            </div>
          )}
          {result.components.length === 0 && (
            <p className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-[13px] text-fg-3">两份请求的组件完全相同</p>
          )}
          {Object.entries(KINDS).map(([kind, title]) => {
            const rows = result.components.filter((c) => c.kind === kind);
            if (!rows.length) return null;
            return (
              <section key={kind}>
                <h3 className="mb-2 text-[12px] font-medium text-fg-2">
                  {title} <span className="ml-1 text-fg-4">{rows.length}</span>
                </h3>
                <div className="overflow-hidden rounded-xl border border-line bg-canvas">
                  {rows.map((row) => (
                    <div key={row.id} data-diff-component={row.id} className="border-b border-line last:border-b-0">
                      <button
                        type="button"
                        aria-expanded={expanded.has(row.id)}
                        onClick={() =>
                          setExpanded((old) => {
                            const next = new Set(old);
                            if (next.has(row.id)) next.delete(row.id);
                            else next.add(row.id);
                            return next;
                          })
                        }
                        className="grid w-full grid-cols-[minmax(0,1fr)_85px_85px_75px] items-center gap-2 px-3 py-2.5 text-left hover:bg-surface-2/50"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <ChevronRight className={cn("size-3.5 shrink-0 text-fg-4", expanded.has(row.id) && "rotate-90")} />
                          <span className="truncate text-[12px]">{componentName(row.id)}</span>
                          <span
                            className={cn(
                              "shrink-0 rounded px-1 py-0.5 text-[10px]",
                              row.change === "added"
                                ? "bg-success/10 text-success"
                                : row.change === "removed"
                                  ? "bg-danger/10 text-danger"
                                  : "bg-info/10 text-info",
                            )}
                          >
                            {CHANGES[row.change]}
                          </span>
                        </span>
                        <span className="tabular text-right text-[11px] text-fg-3">A {row.a ? number(row.a.tokens) : "—"}</span>
                        <span className="tabular text-right text-[11px] text-fg-3">B {row.b ? number(row.b.tokens) : "—"}</span>
                        <span className="tabular text-right text-[11px] text-fg-2">{delta(row.tokens)}</span>
                      </button>
                      {expanded.has(row.id) && (
                        <div className="border-t border-line">
                          <div className="break-all bg-surface/50 px-3 py-2 font-mono text-[10.5px] text-fg-3">{row.id}</div>
                          <div className="grid grid-cols-2 divide-x divide-line">
                            {(["a", "b"] as const).map((side) => (
                              <div key={side} className="min-w-0 px-3 py-2">
                                <div className="mb-2 text-[10.5px] text-fg-3">
                                  {side.toUpperCase()} · {row[side] ? `${number(row[side].bytes)} B · ≈${number(row[side].tokens)} token` : "不包含此组件"}
                                </div>
                                <pre
                                  className={cn(
                                    "whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed",
                                    side === "a" ? "text-danger" : "text-success",
                                  )}
                                >
                                  {row.lines
                                    ?.filter((line) => line.op === (side === "a" ? "-" : "+"))
                                    .map((line) => `${line.op} ${line.text}`)
                                    .join("\n")}
                                </pre>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
