import { Check, FileText, FolderUp, GitBranch, Hand, Route, Sparkles, TriangleAlert, Upload, Wand2 } from "lucide-react";
import { type DragEvent, useEffect, useRef, useState } from "react";
import type { SkillInventoryItem } from "../../../shared/agent";
import type { SkillPreview } from "../../../shared/contract";
import { describeError } from "../../agent/client";
import { Button, cn, Tooltip } from "../../design/primitives";
import { desktop } from "../../lib/desktop";
import { dirname } from "../../lib/format";
import { reloadExtensions, useWorkspaceData } from "../../state/customize";
import { useUi } from "../../state/ui";
import { useActiveWorkspace } from "../../state/workspaces";
import { CodeBlock } from "../session/Markdown";
import { displayPath, originOf } from "./model";
import {
  Chips,
  DetailDrawer,
  Field,
  inputClass,
  ItemRow,
  Modal,
  PageHeader,
  PendingSwitch,
  ScopeBadge,
  ScopeCards,
  ScopeChoice,
  Section,
  Stat,
  TokenTag,
  WriteScopePicker,
} from "./shared";

// TODO(config): turning one skill on or off needs a settings key for it in the Agent.
const SWITCH_PENDING = "单个技能的开关要等 Agent 提供对应的配置项";

function InvocationBadge({ skill }: { skill: SkillInventoryItem }) {
  if (skill.invocation === "manual")
    return (
      <span className="inline-flex h-[18px] items-center gap-1 rounded-[5px] bg-surface-3 px-1.5 text-[10.5px] text-fg-2">
        <Hand className="size-2.5" />
        仅手动
      </span>
    );
  if (skill.invocation === "paths")
    return (
      <span className="inline-flex h-[18px] items-center gap-1 rounded-[5px] bg-surface-3 px-1.5 font-mono text-[10.5px] text-fg-2">
        <Route className="size-2.5" />
        {skill.paths?.[0]}
      </span>
    );
  return null;
}

function UploadSkillDialog({ open, onOpenChange, onInstalled }: { open: boolean; onOpenChange: (v: boolean) => void; onInstalled: (id: string) => void }) {
  const workspace = useActiveWorkspace();
  const { inventory } = useWorkspaceData();
  const toast = useUi((s) => s.toast);
  const [picked, setPicked] = useState<SkillPreview | null>(null);
  const [scope, setScope] = useState<"user" | "project">("project");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const reset = () => setPicked(null);
  const preview = async (read: () => Promise<SkillPreview | null>) => {
    try {
      const result = await read();
      if (result) setPicked(result);
    } catch (error) {
      toast(describeError(error), "danger");
    }
  };
  const take = (file: File | undefined) => {
    const path = file ? desktop.pathOf(file) : "";
    if (!path) return;
    if (/\.(zip|skill)$/i.test(path)) {
      // TODO(desktop): unpack .zip / .skill archives before installing.
      toast("还不支持压缩包，请先解压，再选择里面的技能文件夹");
      return;
    }
    void preview(() => desktop.customize.previewSkill(path));
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    take(e.dataTransfer.files[0]);
  };

  const skills = inventory?.skills ?? [];
  const conflict = picked ? skills.find((s) => s.name === picked.name && s.source === scope) : undefined;
  const shadowing = picked && scope === "project" ? skills.find((s) => s.name === picked.name && s.source === "user") : undefined;

  const install = async () => {
    if (!picked || !workspace) return;
    setBusy(true);
    try {
      if (conflict?.path) await desktop.customize.trashSkill(workspace.id, dirname(conflict.path));
      const dest = await desktop.customize.installSkill(workspace.id, picked.source, scope);
      await reloadExtensions(workspace.id);
      toast(`已安装 /${picked.name} 到 ${displayPath(dest, workspace.path)}/`, "success");
      onOpenChange(false);
      reset();
      onInstalled(`skill:${scope}:${picked.name}`);
    } catch (error) {
      toast(describeError(error), "danger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
      title="上传技能"
      description="技能是一个带 SKILL.md 的文件夹。模型平时只看到名称和描述，用到时才读取正文和附带的文件。"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="primary" disabled={!picked || busy} onClick={() => void install()}>
            {conflict ? "覆盖并安装" : "安装"}
          </Button>
        </>
      }
    >
      {!picked ? (
        <>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: drop target */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
              "flex flex-col items-center rounded-2xl border border-dashed px-6 py-9 text-center transition-colors",
              dragging ? "border-accent bg-accent-softer" : "border-line-strong bg-surface",
            )}
          >
            <span className="mb-3 flex size-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
              <Upload className="size-5" />
            </span>
            <div className="text-[13.5px] font-medium text-fg">把技能文件夹、.zip 或 SKILL.md 拖到这里</div>
            <div className="mt-1 text-[12px] text-fg-3">文件夹里要有 SKILL.md，脚本和参考文档会一起复制</div>
            <div className="mt-4 flex gap-2">
              <Button variant="outline" size="sm" onClick={() => void preview(() => desktop.customize.pickSkill())}>
                <FolderUp />
                选择文件夹
              </Button>
              <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
                <FileText />
                选择文件
              </Button>
            </div>
            <input ref={fileInput} type="file" accept=".zip,.skill,.md" hidden onChange={(e) => take(e.target.files?.[0])} />
          </div>
          <div className="my-4 flex items-center gap-3 text-[11.5px] text-fg-4">
            <span className="h-px flex-1 bg-line" />
            或者从 Git 仓库安装
            <span className="h-px flex-1 bg-line" />
          </div>
          {/* TODO(desktop): install a skill from a Git URL. */}
          <Tooltip content="从 Git 仓库安装还没做，先把仓库克隆到本地，再选择里面的技能文件夹">
            <div className="relative opacity-55">
              <GitBranch className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-fg-3" />
              <input
                disabled
                placeholder="https://github.com/acme/skills/tree/main/pdf"
                className={cn(inputClass, "cursor-not-allowed pl-8 font-mono text-[12.5px]")}
              />
            </div>
          </Tooltip>
        </>
      ) : (
        <>
          <div className="mb-4 rounded-xl border border-line bg-surface p-3.5">
            <div className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-[9px] bg-accent-soft text-accent">
                <Sparkles className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[13px] font-medium text-fg">/{picked.name}</div>
                <div className="truncate text-[12px] text-fg-3">{picked.description || "（SKILL.md 里没有 description）"}</div>
              </div>
              <button type="button" onClick={reset} className="text-[12px] text-fg-3 hover:text-fg">
                重新选择
              </button>
            </div>
            <div className="mt-3 flex flex-col gap-1 border-t border-line pt-3 text-[12px]">
              <span className="flex items-center gap-1.5 text-fg-2">
                <Check className="size-3.5 text-success" />
                找到 SKILL.md，共 {picked.files.length} 个文件
              </span>
              {picked.description ? (
                <span className="flex items-center gap-1.5 text-fg-2">
                  <Check className="size-3.5 text-success" />
                  frontmatter 里有 name 和 description
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-warning">
                  <TriangleAlert className="size-3.5" />
                  frontmatter 里没有 description，模型会用正文的第一段
                </span>
              )}
              {conflict && (
                <span className="flex items-center gap-1.5 text-warning">
                  <TriangleAlert className="size-3.5" />
                  {scope === "user" ? "全局" : "项目"}里已经有 /{picked.name}，安装会把旧的移到废纸篓
                </span>
              )}
              {shadowing && !conflict && (
                <span className="flex items-center gap-1.5 text-fg-2">
                  <TriangleAlert className="size-3.5 text-fg-3" />
                  会在这个项目里覆盖同名的全局技能
                </span>
              )}
            </div>
          </div>
          <Field label="安装到">
            <ScopeChoice
              value={scope}
              onChange={setScope}
              options={[
                {
                  id: "project",
                  scope: "project",
                  title: `项目 · ${workspace?.name ?? ""}`,
                  path: `.easy-agent/skills/${picked.name}/`,
                  hint: "跟着仓库提交，团队成员拉代码后也能用",
                },
                { id: "user", scope: "user", title: "全局", path: `~/.easy-agent/skills/${picked.name}/`, hint: "你所有的项目都能用，不进仓库" },
              ]}
            />
          </Field>
        </>
      )}
    </Modal>
  );
}

function SkillDetails({ skill, onClose, onDeleted }: { skill: SkillInventoryItem | undefined; onClose: () => void; onDeleted: () => void }) {
  const workspace = useActiveWorkspace();
  const { inventory } = useWorkspaceData();
  const toast = useUi((s) => s.toast);
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<string[]>([]);

  useEffect(() => {
    setBody("");
    setFiles([]);
    if (!skill?.path || !workspace) return;
    void desktop.customize.readText(workspace.id, skill.path).then(setBody, (error) => setBody(`读取失败：${describeError(error)}`));
    void desktop.customize.listFiles(workspace.id, dirname(skill.path)).then(setFiles, () => setFiles(["SKILL.md"]));
  }, [skill?.path, workspace]);

  const run = async (task: () => Promise<void>) => {
    try {
      await task();
    } catch (error) {
      toast(describeError(error), "danger");
    }
  };

  return (
    <DetailDrawer
      open={!!skill}
      onClose={onClose}
      title={skill && <span className="font-mono">/{skill.name}</span>}
      subtitle={skill?.path && workspace && displayPath(skill.path, workspace.path)}
      footer={
        skill &&
        workspace && (
          <>
            <Button variant="secondary" size="sm" disabled={!skill.path} onClick={() => skill.path && void desktop.app.openPath(skill.path)}>
              在编辑器中打开
            </Button>
            {skill.source === "user" && skill.path && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void run(async () => {
                    await desktop.customize.installSkill(workspace.id, dirname(skill.path!), "project");
                    await reloadExtensions(workspace.id);
                    toast(`已复制到 .easy-agent/skills/${skill.name}/`, "success");
                  })
                }
              >
                复制到项目
              </Button>
            )}
            {skill.source !== "plugin" && skill.path && (
              <Button
                variant="danger"
                size="sm"
                className="ml-auto"
                onClick={() =>
                  void run(async () => {
                    await desktop.customize.trashSkill(workspace.id, dirname(skill.path!));
                    await reloadExtensions(workspace.id);
                    onDeleted();
                    toast(`已把 /${skill.name} 移到废纸篓`);
                  })
                }
              >
                删除
              </Button>
            )}
          </>
        )
      }
    >
      {skill && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-1.5">
            <ScopeBadge origin={originOf(skill, inventory)} />
            <InvocationBadge skill={skill} />
          </div>
          <p className="mb-4 text-[13px] leading-[1.6] text-fg-2">{skill.description}</p>
          <div className="mb-4 grid grid-cols-2 gap-2">
            <Stat
              label="清单（每轮）"
              value={`${skill.listing.value} tokens`}
              sub={skill.invocation === "manual" ? "仅手动，不进清单" : skill.activated === false ? "还没激活，不在清单里" : "名称 + 描述"}
            />
            <Stat label="正文（调用时）" value={`${skill.body.value.toLocaleString()} tokens`} sub="进入对话消息" />
          </div>
          <Field
            label="调用方式"
            hint={
              skill.invocation === "manual"
                ? "frontmatter 里设了 disable-model-invocation，模型看不到它，只能由你输入 /命令触发。"
                : skill.invocation === "paths"
                  ? "frontmatter 里设了 paths。会话里读写到匹配的文件后，它才加入技能清单。"
                  : "模型在技能清单里看到它，判断合适时会自己调用。"
            }
          >
            <div className="text-[13px] text-fg">
              {skill.invocation === "manual" ? "仅手动调用" : skill.invocation === "paths" ? "按文件路径激活" : "模型自动调用 + 手动调用"}
            </div>
          </Field>
          {skill.paths && (
            <Field label="激活路径">
              <Chips items={skill.paths} />
            </Field>
          )}
          {skill.allowedTools.length > 0 && (
            <Field label="运行期间免确认的工具" hint="allowed-tools 里的规则在技能运行期间加入会话的允许列表。">
              <Chips items={skill.allowedTools} />
            </Field>
          )}
          <Field label={`文件（${files.length}）`}>
            <div className="overflow-hidden rounded-lg border border-line">
              {files.map((f) => (
                <div key={f} className="flex h-8 items-center gap-2 border-b border-line bg-surface px-3 font-mono text-[12px] text-fg-2 last:border-b-0">
                  <FileText className="size-3.5 text-fg-3" />
                  {f}
                </div>
              ))}
            </div>
          </Field>
          <Field label="SKILL.md">
            <CodeBlock code={body} lang="md" />
          </Field>
        </>
      )}
    </DetailDrawer>
  );
}

export function SkillsPage({ query }: { query: string }) {
  const { inventory } = useWorkspaceData();
  const workspace = useActiveWorkspace();
  const [filter, setFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const skills = inventory?.skills ?? [];
  const visible = skills.filter(
    (s) => (filter === "all" || s.source === filter) && (!query || `${s.name} ${s.description}`.toLowerCase().includes(query.toLowerCase())),
  );
  const count = (kind: string) => skills.filter((s) => s.source === kind).length;
  const perTurn = skills.filter((s) => s.source !== "plugin").reduce((n, s) => n + s.listing.value, 0);
  const selected = skills.find((s) => s.id === selectedId);

  const row = (skill: SkillInventoryItem) => (
    <ItemRow
      key={skill.id}
      selected={selectedId === skill.id}
      onClick={() => setSelectedId(skill.id)}
      dimmed={skill.listing.value === 0}
      icon={<Sparkles />}
      title={<span className="font-mono">/{skill.name}</span>}
      badges={<InvocationBadge skill={skill} />}
      description={skill.description}
      right={
        <>
          <Tooltip
            content={
              skill.invocation === "manual"
                ? "只能用 /命令调用，不进技能清单"
                : skill.invocation === "paths"
                  ? "改到匹配的文件后才进入清单"
                  : "名称和描述每轮都在上下文里"
            }
          >
            <span>
              <TokenTag value={skill.listing.value} per="/轮" />
            </span>
          </Tooltip>
          {skill.source === "plugin" ? (
            <span className="w-[34px] text-center text-[11px] text-fg-3">插件</span>
          ) : (
            <PendingSwitch checked={skill.enabled} reason={SWITCH_PENDING} />
          )}
        </>
      }
    />
  );

  const groups = [
    { kind: "project", title: `项目 · ${workspace?.name ?? ""}`, meta: ".easy-agent/skills/" },
    { kind: "user", title: "全局", meta: "~/.easy-agent/skills/" },
    { kind: "plugin", title: "来自插件", meta: "随插件启用和停用" },
  ];

  return (
    <>
      <PageHeader
        icon={<Sparkles />}
        title="技能"
        en="Skills"
        description="把一类任务的做法写成 SKILL.md，Agent 判断需要时自己调用，你也可以用 /名称 直接触发。项目里的同名技能会覆盖全局的。"
        actions={
          <>
            <WriteScopePicker what="开关" />
            <Button variant="primary" onClick={() => setUploading(true)}>
              <Upload />
              上传技能
            </Button>
          </>
        }
      />
      <ScopeCards
        active={filter}
        onSelect={setFilter}
        cards={[
          {
            id: "project",
            scope: "project",
            title: "项目技能",
            path: ".easy-agent/skills/",
            ...(workspace ? { open: `${workspace.path}/.easy-agent/skills` } : {}),
            count: count("project"),
            hint: "提交到仓库，团队共享",
          },
          {
            id: "user",
            scope: "user",
            title: "全局技能",
            path: "~/.easy-agent/skills/",
            open: "~/.easy-agent/skills",
            count: count("user"),
            hint: "所有项目可用",
          },
          {
            id: "plugin",
            scope: "plugin",
            title: "插件技能",
            path: "~/.easy-agent/plugins/",
            open: "~/.easy-agent/plugins",
            count: count("plugin"),
            hint: "在插件页管理",
          },
        ]}
      />
      <div className="mb-4 flex items-center gap-2 rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[12.5px] text-fg-2">
        <Wand2 className="size-3.5 text-fg-3" />
        技能清单每轮占用 <span className="tabular font-medium text-fg">{perTurn}</span> tokens，正文只在调用时读取。插件带来的技能算在插件里。
      </div>
      {groups.map((g) => {
        const items = visible.filter((s) => s.source === g.kind);
        if (items.length === 0) return null;
        return (
          <Section key={g.kind} title={g.title} meta={g.meta}>
            {items.map(row)}
          </Section>
        );
      })}
      {visible.length === 0 && (
        <div className="py-16 text-center text-[13px] text-fg-3">{skills.length === 0 ? "还没有技能，点「上传技能」添加一个" : "没有匹配的技能"}</div>
      )}

      <SkillDetails skill={selected} onClose={() => setSelectedId(null)} onDeleted={() => setSelectedId(null)} />
      <UploadSkillDialog open={uploading} onOpenChange={setUploading} onInstalled={setSelectedId} />
    </>
  );
}
