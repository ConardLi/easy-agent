import { Bot } from "lucide-react";
import { Button } from "../../design/primitives";
import { dismissAgentNotice } from "../../state/actions";
import { useSessions } from "../../state/sessions";

/** Opening a session whose Agent changed since it last ran, or was deleted, says so above the composer. */
export function AgentNotice({ sessionId }: { sessionId: string }) {
  const notice = useSessions((s) => s.agentNotices[sessionId]);
  if (!notice) return null;
  return (
    <div className="mb-3 flex items-center gap-3 rounded-xl border border-info/30 bg-info/8 px-4 py-3">
      <Bot className="size-4 shrink-0 text-info" />
      <div className="min-w-0 flex-1 text-[12.5px] leading-[1.55] text-fg-2">{notice}</div>
      <Button size="sm" variant="ghost" onClick={() => dismissAgentNotice(sessionId)}>
        知道了
      </Button>
    </div>
  );
}
