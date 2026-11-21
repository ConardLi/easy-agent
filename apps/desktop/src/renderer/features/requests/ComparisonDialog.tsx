import { agent, describeError } from "../../agent/client";
import { Modal } from "../../design/Overlays";
import { Button } from "../../design/primitives";
import { useRequests } from "../../state/requests";
import { useRuntime } from "../../state/workspaces";
import { RequestComparison } from "./RequestComparison";

export function ComparisonDialog() {
  const comparison = useRequests((s) => s.comparison);
  const close = useRequests((s) => s.closeComparison);
  const runtime = useRuntime(comparison?.workspaceId);
  if (!comparison) return null;
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="请求对比"
      description="在同一工作区比较两个 Agent 的请求组成。"
      width={960}
      footer={
        <Button size="sm" variant="secondary" onClick={close}>
          完成
        </Button>
      }
    >
      <RequestComparison
        key={`${comparison.workspaceId}:${comparison.agent}`}
        agents={(runtime.agents ?? []).map((a) => a.name)}
        initialA={comparison.agent}
        compare={async (a, b, prompt) => {
          try {
            const result = await agent.call(comparison.workspaceId, "runtime/diffHarness", { a: { name: a }, b: { name: b }, prompt });
            if (!result.request) throw new Error("Agent 没有返回请求对比结果");
            return result.request;
          } catch (error) {
            throw new Error(describeError(error));
          }
        }}
      />
    </Modal>
  );
}
