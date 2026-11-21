import { useEffect } from "react";
import type { SessionView } from "../../agent/projector/session";
import { runCommand } from "../../state/actions";
import { useAgents } from "../../state/agents";
import { loadContext, useCustomize } from "../../state/customize";
import { useRequests } from "../../state/requests";
import { useSessions } from "../../state/sessions";
import { primaryAgentOf, useRuntime } from "../../state/workspaces";
import { ContextDetails } from "./ContextDetails";

export function ContextTab({ view }: { view: SessionView }) {
  const data = useCustomize((s) => s.contexts[view.id]);
  const error = useCustomize((s) => s.contextErrors[view.id]);
  const runtime = useRuntime(view.workspaceId);
  const name = useSessions((s) => s.agentOf[view.id]) ?? primaryAgentOf(runtime);
  useEffect(() => {
    if (!view.busy) void loadContext(view.workspaceId, view.id);
  }, [view.workspaceId, view.id, view.busy, view.messages.length]);
  return (
    <ContextDetails
      key={view.id}
      data={data}
      error={error}
      busy={view.busy}
      onRetry={() => void loadContext(view.workspaceId, view.id)}
      onConfigure={({ tab, row }) => useAgents.getState().openAgents(name, tab, row)}
      onCompare={() => useRequests.getState().openComparison(view.workspaceId, name)}
      onCompact={() => void runCommand("compact")}
    />
  );
}
