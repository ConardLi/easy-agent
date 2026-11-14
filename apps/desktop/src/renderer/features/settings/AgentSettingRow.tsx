import { Bot, Lock } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { cn, Tooltip } from "../../design/primitives";
import { changeWorkspaceAgent, keyOf, loadAgent, useAgents } from "../../state/agents";
import { primaryAgentOf, useRuntime, useWorkspaces } from "../../state/workspaces";
import { lockedBy, setKey, sourceText } from "../agents/model";

/**
 * A settings row for a value that belongs to the Agent (`features.*`): it
 * shows and writes the setting of the Agent the workspace runs
 * (`harnesses.<name>.<path>`), not a settings file.
 */
export function AgentSettingRow<T>({
  title,
  hint,
  path,
  render,
}: {
  title: string;
  hint?: ReactNode;
  path: string;
  render: (value: T | undefined, set: (value: T) => void) => ReactNode;
}) {
  const workspaceId = useWorkspaces((s) => s.activeId);
  const runtime = useRuntime(workspaceId ?? undefined);
  const agent = primaryAgentOf(runtime);
  const ready = runtime.status.state === "ready";
  const data = useAgents((s) => (workspaceId ? s.data[keyOf(workspaceId, agent)] : undefined));
  useEffect(() => {
    if (workspaceId && ready && !data) void loadAgent(workspaceId, agent);
  }, [workspaceId, agent, ready, data]);

  const value = data?.resolved.values[path];
  const locked = lockedBy(value);
  const set = (next: T) => void changeWorkspaceAgent((spec) => setKey(spec, path, next), { message: (name) => `已写入 harnesses.${name}.${path}` });
  return (
    <div data-row={path} className="group/row flex items-center justify-between gap-6 border-b border-line py-3.5 last:border-b-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[13.5px] font-medium text-fg">{title}</span>
          <Tooltip content={`每个 Agent 单独设置；这里改的是这个工作区在用的 Agent，写进 harnesses.${agent}`}>
            <span className="inline-flex h-[18px] items-center gap-1 rounded-[5px] bg-accent-soft px-1.5 text-[10.5px] font-medium text-accent">
              <Bot className="size-2.5" />
              {agent}
            </span>
          </Tooltip>
          {value && value.source !== "built-in" && <span className="text-[10.5px] text-fg-3">{sourceText(value, agent)}</span>}
          <span className="font-mono text-[10.5px] text-fg-4 opacity-0 transition-opacity group-hover/row:opacity-100">{path}</span>
        </div>
        {hint && <div className="mt-0.5 text-[12.5px] leading-[1.55] text-fg-3">{hint}</div>}
        {locked && (
          <div className="mt-1 flex items-center gap-1 text-[12px] text-warning">
            <Lock className="size-3" />
            {locked}
          </div>
        )}
      </div>
      <div className={cn("shrink-0", (locked || !data) && "pointer-events-none opacity-45")} aria-disabled={locked || !data ? true : undefined}>
        {render(value?.value as T | undefined, set)}
      </div>
    </div>
  );
}
