import { CircleAlert, ShieldAlert } from "lucide-react";
import type { WorkspaceInfo } from "../../../shared/contract";
import { Button, cn, Spinner } from "../../design/primitives";
import { restartAgent, trustWorkspace } from "../../state/actions";
import { useRuntime } from "../../state/workspaces";

/** The workspace's Agent process when it needs attention: untrusted, or stopped. */
export function HostBanner({ workspace, className }: { workspace: WorkspaceInfo; className?: string }) {
  const { status } = useRuntime(workspace.id);

  if (status.state === "crashed")
    return (
      <div className={cn("flex items-center gap-3 rounded-xl border border-danger/30 bg-danger/8 px-4 py-3", className)}>
        <CircleAlert className="size-4 shrink-0 text-danger" />
        <div className="min-w-0 flex-1 text-[12.5px] leading-[1.55] text-fg-2">
          <span className="font-medium text-fg">{status.restarting ? "Agent 进程退出了，正在重新启动。" : "Agent 进程已停止。"}</span>
          <span className="break-words">{status.message}</span>
        </div>
        {status.restarting ? (
          <Spinner />
        ) : (
          <Button size="sm" variant="outline" onClick={() => void restartAgent(workspace.id)}>
            重新启动
          </Button>
        )}
      </div>
    );

  if (
    status.state === "ready" &&
    status.trust === "persisted" &&
    !status.init.workspace.projectTrusted &&
    status.init.workspace.ignoredProjectConfig.length > 0
  )
    return (
      <div className={cn("flex items-center gap-3 rounded-xl border border-warning/30 bg-warning/8 px-4 py-3", className)}>
        <ShieldAlert className="size-4 shrink-0 text-warning" />
        <div className="flex-1 text-[12.5px] leading-[1.55] text-fg-2" title={status.init.workspace.ignoredProjectConfig.join("\n")}>
          <span className="font-medium text-fg">这个工作区还没有被信任。</span>
          项目里的设置、hooks、MCP 服务器和 .env 凭据都不会生效。
        </div>
        {/* TODO(G10): "always trust" needs the Agent to save the decision; until then trust lasts until the app quits. */}
        <Button size="sm" variant="outline" onClick={() => void trustWorkspace(workspace.id)}>
          信任
        </Button>
      </div>
    );

  return null;
}
