import { FileCode2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { RewindResult } from "../../../shared/agent";
import { Modal } from "../../design/Overlays";
import { Button, Spinner } from "../../design/primitives";
import { basename, dirname } from "../../lib/format";
import { applyRewind, previewRewind } from "../../state/actions";
import { type RewindRequest, useUi } from "../../state/ui";
import { DiffStat } from "./DiffView";

function copy(request: RewindRequest): { title: string; description: string; confirm: string } {
  if (request.followUp?.kind === "regenerate") {
    return { title: "重新生成", description: "撤销上一轮的对话和文件改动，再把这条消息发一次。", confirm: "重新生成" };
  }
  if (request.scope === "files") {
    return request.to
      ? { title: "只回退代码", description: "文件恢复到这条消息之前，对话保留。Agent 下一轮会知道哪些文件被回退了。", confirm: "回退文件" }
      : { title: "全部回退", description: "这个会话里 Agent 改过的文件恢复到第一次改动之前，对话保留。", confirm: "回退文件" };
  }
  if (request.scope === "conversation") {
    return {
      title: "回退对话",
      description: "这条消息之前没有文件检查点，只回退对话，文件保持现状。这条消息和之后的对话会移除，消息放回输入框。",
      confirm: "回退对话",
    };
  }
  return { title: "回退对话和代码", description: "对话和文件都回到这条消息之前，消息放回输入框。移除的对话不能恢复。", confirm: "回退" };
}

/** Confirms a rewind after showing the files it restores. */
export function RewindDialog() {
  const request = useUi((s) => s.rewind);
  const setRewind = useUi((s) => s.setRewind);
  const [preview, setPreview] = useState<RewindResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPreview(null);
    if (!request) return;
    let current = true;
    void previewRewind(request).then((result) => {
      if (!current) return;
      if (result) setPreview(result);
      else setRewind(null);
    });
    return () => {
      current = false;
    };
  }, [request, setRewind]);

  if (!request) return null;
  const close = () => setRewind(null);
  const text = copy(request);
  const withFiles = request.scope !== "conversation";
  const confirm = async () => {
    setBusy(true);
    const ok = await applyRewind(request);
    setBusy(false);
    if (ok) close();
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && close()}
      title={text.title}
      description={text.description}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            取消
          </Button>
          <Button variant="primary" disabled={!preview || busy} onClick={() => void confirm()}>
            {text.confirm}
          </Button>
        </>
      }
    >
      {!preview ? (
        <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-fg-3">
          <Spinner />
          正在计算要恢复的文件…
        </div>
      ) : withFiles ? (
        <div className="flex flex-col gap-3 pb-1">
          {preview.files.paths.length > 0 ? (
            <div className="overflow-hidden rounded-xl border border-line bg-surface">
              <div className="flex items-center justify-between border-b border-line px-3 py-2 text-[12.5px] text-fg-2">
                <span>
                  恢复 <span className="font-medium text-fg">{preview.files.paths.length}</span> 个文件
                </span>
                <DiffStat added={preview.files.insertions} removed={preview.files.deletions} />
              </div>
              <ul className="scroll-thin max-h-[220px] overflow-y-auto py-1">
                {preview.files.paths.map((path) => (
                  <li key={path} className="flex h-8 items-center gap-2 px-3">
                    <FileCode2 className="size-3.5 shrink-0 text-fg-3" />
                    <span className="min-w-0 truncate">
                      <span className="font-mono text-[12.5px] text-fg">{basename(path)}</span>
                      <span className="ml-1.5 font-mono text-[11px] text-fg-3">{dirname(path)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="rounded-xl border border-line bg-surface px-3 py-2.5 text-[12.5px] text-fg-2">
              {request.to ? "文件和这条消息之前一样，不用恢复。" : "没有需要恢复的文件。"}
            </div>
          )}
          <p className="text-[12px] leading-[1.6] text-fg-3">
            只恢复 Agent 用 Write、Edit、MultiEdit 改过的文件。命令行、子 Agent 和你自己做的改动不会恢复；之后手动改过这些文件的话，那些改动会被覆盖。
          </p>
        </div>
      ) : (
        <p className="pb-1 text-[12.5px] leading-[1.6] text-fg-2">文件不会变化。</p>
      )}
    </Modal>
  );
}
