import { useState } from "react";
import type { ConfigMigrationPreview } from "eagent/sdk";
import { agent, describeError } from "../../agent/client";
import { Modal } from "../../design/Overlays";
import { Button } from "../../design/primitives";
import { loadConfig, restartIdleAgents, useSettings } from "../../state/settings";
import { SCOPE_FILE } from "../../lib/scopes";
import { useUi } from "../../state/ui";
import { CodeBlock } from "../session/Markdown";

/** File migration is always previewed, with conflicts and a revision bound to the displayed changes. */
export function ConfigMigrationNotice() {
  const { config, workspaceId, writeScope } = useSettings();
  const [preview, setPreview] = useState<ConfigMigrationPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const notices = [...(config?.models.warnings ?? []), ...(config?.sources.flatMap((source) => source.validationErrors ?? []) ?? [])];
  const migration = config?.sources.some((source) => source.migrationNotices?.length);
  if (!migration && notices.length === 0) return null;
  const show = async () => {
    if (!workspaceId) return;
    setBusy(true);
    setError("");
    try {
      setPreview(await agent.call(workspaceId, "config/migrationPreview", { scope: writeScope }));
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!workspaceId || !preview) return;
    setBusy(true);
    try {
      const result = await agent.call(workspaceId, "config/migrationApply", { scope: writeScope, revision: preview.revision });
      setPreview(null);
      useUi.getState().toast(result.backup ? `迁移完成，原文件备份：${result.backup}` : "配置已是规范格式", "success");
      await loadConfig();
      if (result.changed) await restartIdleAgents("配置迁移已完成");
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-10 mt-6 rounded-xl border border-warning/25 bg-warning/5 p-4 text-[12px] text-fg-2">
      <div className="flex items-center justify-between gap-4">
        <span className="font-medium text-fg">配置需要处理</span>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void show()}>
          预览迁移
        </Button>
      </div>
      <p className="mt-2 text-fg-3">当前文件：{SCOPE_FILE[writeScope]}。迁移先展示差异，应用前保留原文件备份。</p>
      {(migration || notices.some((notice) => notice.includes("Retired configuration"))) && (
        <p className="mt-2 text-fg-3">旧配置已停止生效，请手动迁移后再使用模型。Shell 或 .env 中的旧变量需要单独修改并重启。</p>
      )}
      {notices.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer">查看 {notices.length} 条诊断</summary>
          <ul className="mt-2 space-y-1">
            {[...new Set(notices)].map((notice) => (
              <li key={notice} className="break-words">
                {notice}
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && (
        <p role="alert" className="mt-2 text-danger">
          {error}
        </p>
      )}
      {preview && (
        <Modal
          open
          title="配置迁移预览"
          width={680}
          onOpenChange={(open) => !open && setPreview(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setPreview(null)}>
                关闭
              </Button>
              <Button
                variant="primary"
                disabled={busy || !preview.changed || preview.notices.some((notice) => notice.level === "error")}
                onClick={() => void apply()}
              >
                备份并应用
              </Button>
            </>
          }
        >
          <p className="mb-3 break-all text-[12px] text-fg-3">{preview.path}</p>
          {preview.notices.map((notice, index) => (
            <p key={`${notice.field}-${index}`} className={`mb-2 text-[12px] ${notice.level === "error" ? "text-danger" : "text-fg-2"}`}>
              {notice.field}：{notice.message}
            </p>
          ))}
          <CodeBlock code={JSON.stringify(preview.changes, null, 2)} lang="json" />
          {error && (
            <p role="alert" className="mt-3 text-[12px] text-danger">
              {error}
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}
