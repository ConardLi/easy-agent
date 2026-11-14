import { Bot, ChevronDown } from "lucide-react";
import { useState } from "react";
import type { RuntimeInventory } from "../../../shared/agent";
import { Menu, MenuCheckboxItem, MenuContent, MenuLabel, MenuTrigger } from "../../design/primitives";
import { changeResource, keyOf, loadResourceAgents, useAgents } from "../../state/agents";
import { useWorkspaces } from "../../state/workspaces";
import { selectionState, type SelectionKind } from "../agents/model";

/** The selector a resource uses in an Agent's include/exclude list. */
export function resourceKey(kind: SelectionKind, item: RuntimeInventory[SelectionKind][number]): string {
  if (kind === "plugins") return item.pluginId ?? item.name;
  if ("selectionKey" in item && item.selectionKey) return item.selectionKey;
  if (kind === "rules") return "scope" in item && item.scope === "memory" ? "memory" : (item.path ?? item.id);
  return item.name;
}

/** Each row shows actual usage and lets the user choose the Agent to edit. */
export function ResourceUsage({ kind, name }: { kind: SelectionKind; name: string }) {
  const workspaceId = useWorkspaces((s) => s.activeId);
  const definitions = useWorkspaces((s) => (workspaceId ? s.runtime[workspaceId]?.agents : undefined));
  const data = useAgents((s) => s.data);
  const errors = useAgents((s) => s.errors);
  const [busy, setBusy] = useState(false);
  const rows = (definitions ?? []).map(({ name: agent }) => {
    const key = keyOf(workspaceId ?? "", agent);
    const loaded = data[key];
    const item = loaded?.inventory?.[kind].find((item) => resourceKey(kind, item) === name);
    const selected = loaded ? selectionState(loaded.resolved, kind, name) : undefined;
    const wildcard =
      !selected?.on &&
      selected?.reason?.includes("exclude") &&
      selected?.from &&
      Array.isArray(selected.from.value) &&
      selected.from.value.some((v: unknown) => typeof v === "string" && v.includes("*"));
    const error = errors[key] ?? loaded?.resolved.issues.find((issue) => issue.level === "error")?.message;
    const lock = item?.source === "policy" ? "托管策略的 Hook 不能由 Agent 移除" : wildcard ? "排除模式覆盖了多项资源，请到 Agent 页调整列表" : undefined;
    return { agent, item, selected, error, lock, loaded };
  });
  const users = rows.filter((row) => row.item?.enabled && !row.error).map((row) => row.agent);
  const incomplete = !definitions || rows.some((row) => !row.loaded || row.error);
  const label = `${users.length} 个 Agent${users.length ? ` · ${users.slice(0, 2).join("、")}${users.length > 2 ? "…" : ""}` : ""}`;
  return (
    <Menu
      onOpenChange={(open) => {
        if (open && workspaceId) void loadResourceAgents(workspaceId);
      }}
    >
      <MenuTrigger asChild>
        <button
          type="button"
          data-resource={`${kind}:${name}`}
          aria-label={`${name} 的 Agent 使用情况`}
          title={users.join("、")}
          className="inline-flex h-7 max-w-[210px] items-center gap-1.5 rounded-lg border border-line px-2 text-[11.5px] text-fg-2 hover:bg-surface-2"
        >
          <Bot className="size-3.5 shrink-0" />
          <span className="truncate">{incomplete ? `${label} · 待读取` : label}</span>
          <ChevronDown className="size-3 shrink-0" />
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="max-h-[360px] w-[320px] overflow-y-auto">
        <MenuLabel>选择使用这项资源的 Agent</MenuLabel>
        {rows.map((row) => (
          <MenuCheckboxItem
            key={row.agent}
            checked={row.selected?.on ?? false}
            disabled={busy || !row.item || !!row.error || !!row.lock}
            onChange={(on) => {
              setBusy(true);
              void changeResource(row.agent, kind, name, on).finally(() => setBusy(false));
            }}
          >
            <span className="block font-medium">{row.agent}</span>
            <span className="block text-[11px] text-fg-3">
              {row.error ??
                row.lock ??
                (!row.loaded
                  ? "读取中…"
                  : !row.item
                    ? "当前不可用"
                    : row.item.enabled
                      ? "已启用"
                      : row.selected?.on
                        ? `已选择 · ${row.item.reason ?? "资源已全局停用"}`
                        : "未选择")}
            </span>
          </MenuCheckboxItem>
        ))}
        <p className="px-2 py-2 text-[11px] leading-relaxed text-fg-3">
          选择写入该 Agent 的配置；继承它的 Agent 也会受影响。全局停用、工作区信任和托管策略继续生效。
        </p>
      </MenuContent>
    </Menu>
  );
}
