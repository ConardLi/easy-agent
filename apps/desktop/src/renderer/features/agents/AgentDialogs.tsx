import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { Modal } from "../../design/Overlays";
import { Button } from "../../design/primitives";
import { confirmImport, createAgent, deleteAgent, keyOf, renameAgent, savePrompt, useAgents } from "../../state/agents";
import { useActiveWorkspace, useRuntime } from "../../state/workspaces";
import { Chips, Field, inputClass } from "../customize/shared";
import { AGENT_NAME, PROMPTS_DIR, promptFileName, SECTION_LABEL, SECTION_NAME, setKey, specSections } from "./model";

export type AgentDialog =
  | { kind: "create" }
  | { kind: "copy"; from: string }
  | { kind: "rename"; name: string }
  | { kind: "delete"; name: string }
  | { kind: "reset" }
  /** `section`: `identity`, a section name, or null to add one. */
  | { kind: "prompt"; agent: string; section: string | null };

const PLACEMENTS = ["instructions", "output_style", "language", "environment", "agent_md", "memory", "session_instructions", "skills", "agents", "team"];

function nameError(name: string, taken: string[]): string | undefined {
  if (!name) return undefined;
  if (!AGENT_NAME.test(name)) return "只能用字母、数字、点、下划线和短横线，以字母或数字开头";
  if (taken.includes(name)) return `已经有叫 ${name} 的 Agent`;
  return undefined;
}

export function AgentDialogs({ dialog, onClose }: { dialog: AgentDialog | null; onClose: () => void }) {
  const workspace = useActiveWorkspace();
  const agents = useRuntime(workspace?.id).agents ?? [];
  const data = useAgents((s) => s.data);
  const pendingImport = useAgents((s) => s.pendingImport);
  const taken = agents.map((a) => a.name);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [base, setBase] = useState("default");
  const [text, setText] = useState("");
  const [after, setAfter] = useState("agent_md");
  const [busy, setBusy] = useState(false);
  const [importName, setImportName] = useState("");

  const promptAgent = dialog?.kind === "prompt" ? dialog.agent : undefined;
  const promptData = workspace && promptAgent ? data[keyOf(workspace.id, promptAgent)] : undefined;
  useEffect(() => {
    if (!dialog) return;
    setDescription("");
    setBase("default");
    setAfter("agent_md");
    setBusy(false);
    if (dialog.kind === "copy") setName(`${dialog.from}-copy`);
    else if (dialog.kind === "rename") setName(dialog.name);
    else if (dialog.kind === "prompt") {
      setName(dialog.section ?? "");
      const section = dialog.section ? promptData?.inventory?.promptSections.find((s) => s.name === dialog.section) : undefined;
      setText(section?.text ?? "");
    } else setName("");
    // Seed the fields when a dialog opens, not when its data is read again.
  }, [dialog]);
  useEffect(() => setImportName(pendingImport?.preview.name ?? ""), [pendingImport]);

  const run = async (action: () => Promise<boolean>) => {
    setBusy(true);
    const ok = await action();
    setBusy(false);
    if (ok) onClose();
  };

  if (pendingImport) {
    const { preview } = pendingImport;
    const replacing = importName === preview.name && preview.exists;
    const error = importName === preview.name ? undefined : nameError(importName, taken);
    const close = () => useAgents.setState({ pendingImport: null });
    return (
      <Modal
        open
        onOpenChange={(v) => !v && close()}
        title={`导入 ${preview.name}`}
        description={`${pendingImport.file} · 导入前看一下它在这个工作区会打开什么`}
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              取消
            </Button>
            <Button
              variant="primary"
              disabled={busy || preview.errors.length > 0 || !importName || !!error}
              onClick={() => void run(() => confirmImport(importName))}
            >
              {replacing ? "替换" : "导入"}
            </Button>
          </>
        }
      >
        {preview.errors.length > 0 && (
          <div className="mb-4 flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2.5 text-[12.5px] text-fg-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
            {preview.errors.join("；")}
          </div>
        )}
        <Field
          label="名字"
          hint={
            error ? <span className="text-danger">{error}</span> : replacing ? `已经有叫 ${preview.name} 的 Agent，导入会替换它；换个名字就另存一份` : undefined
          }
        >
          <input value={importName} onChange={(e) => setImportName(e.target.value)} className={`${inputClass} font-mono`} />
        </Field>
        <Field label="保留的内置工具">
          <Chips items={preview.tools} />
        </Field>
        <Field label="会启动的 MCP 服务器">
          {preview.mcpServers.length ? <Chips items={preview.mcpServers} /> : <span className="text-[12.5px] text-fg-3">无</span>}
        </Field>
        <Field label="权限" hint="导入的 Agent 只能加规则，你在全局设置里的 deny 照样生效">
          <div className="text-[12.5px] text-fg-2">
            模式 <span className="font-mono">{preview.permissions.mode}</span>
            {(["allow", "ask", "deny"] as const).map((effect) =>
              preview.permissions[effect].length ? (
                <span key={effect}>
                  ，新增 {effect} <span className="font-mono">{preview.permissions[effect].join(", ")}</span>
                </span>
              ) : null,
            )}
          </div>
        </Field>
        <Field label="设置的项">{preview.sets.length ? <Chips items={preview.sets} /> : <span className="text-[12.5px] text-fg-3">无</span>}</Field>
      </Modal>
    );
  }

  if (!dialog) return null;
  const open = (v: boolean) => !v && onClose();
  const error = dialog.kind === "rename" && name === dialog.name ? undefined : nameError(name, taken);

  if (dialog.kind === "create" || dialog.kind === "copy") {
    const copy = dialog.kind === "copy";
    const source = copy && workspace ? data[keyOf(workspace.id, dialog.from)] : undefined;
    return (
      <Modal
        open
        onOpenChange={open}
        title={copy ? `复制 ${dialog.from}` : "新建 Agent"}
        description={copy ? "新 Agent 带着同样的设置，之后各改各的。" : "新 Agent 继承另一个 Agent 的全部设置，你只需要改不一样的地方。"}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button
              variant="primary"
              disabled={busy || !name || !!error || (copy && !source)}
              onClick={() =>
                void run(() =>
                  createAgent(
                    name,
                    // A copy of default keeps its changes and extends the built-in default, like default itself.
                    copy
                      ? structuredClone(source!.definition.spec)
                      : { ...(base !== "default" ? { extends: base } : {}), ...(description ? { description } : {}) },
                    copy ? `已把 ${dialog.from} 复制为 ${name}` : `已写入 harnesses.${name}`,
                  ),
                )
              }
            >
              {copy ? "复制" : "创建"}
            </Button>
          </>
        }
      >
        <Field label="名字" hint={error ? <span className="text-danger">{error}</span> : "新建会话时按这个名字选 Agent，也用在 --harness 里"}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="reviewer" aria-label="Agent 名字" className={`${inputClass} font-mono`} />
        </Field>
        {!copy && (
          <>
            <Field label="描述">
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="它擅长做什么" className={inputClass} />
            </Field>
            <Field label="继承自">
              <select value={base} onChange={(e) => setBase(e.target.value)} className={inputClass}>
                {agents
                  .filter((a) => a.errors.length === 0)
                  .map((a) => (
                    <option key={a.name} value={a.name}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </Field>
          </>
        )}
      </Modal>
    );
  }

  if (dialog.kind === "rename") {
    const agent = agents.find((a) => a.name === dialog.name);
    return (
      <Modal
        open
        onOpenChange={open}
        title={`给 ${dialog.name} 改名`}
        description={
          agent?.dependents.length || agent?.projectDefault ? `继承它的 Agent${agent.projectDefault ? "和这个工作区的默认 Agent" : ""}会跟着改。` : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button
              variant="primary"
              disabled={busy || !name || !!error || name === dialog.name}
              onClick={() => void run(() => renameAgent(dialog.name, name))}
            >
              改名
            </Button>
          </>
        }
      >
        <Field label="新名字" hint={error ? <span className="text-danger">{error}</span> : "用这个 Agent 的旧会话恢复时，会提示 Agent 已经不在"}>
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label="新名字" className={`${inputClass} font-mono`} />
        </Field>
      </Modal>
    );
  }

  if (dialog.kind === "delete" || dialog.kind === "reset") {
    const target = dialog.kind === "delete" ? dialog.name : "default";
    const agent = agents.find((a) => a.name === target);
    const blocked = dialog.kind === "delete" && (agent?.dependents.length ?? 0) > 0;
    return (
      <Modal
        open
        onOpenChange={open}
        title={dialog.kind === "delete" ? `删除 ${target}？` : "把 default 恢复成内置预设？"}
        description={
          dialog.kind === "delete"
            ? "用它的会话以后恢复时改用 default 继续。提示词文件留在 prompts/ 里。"
            : "harnesses.default 里的改动会删掉，继承 default 的 Agent 也跟着变。"
        }
        width={460}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" className="!bg-danger" disabled={busy || blocked} onClick={() => void run(() => deleteAgent(target))}>
              {dialog.kind === "delete" ? "删除" : "恢复默认"}
            </Button>
          </>
        }
      >
        {blocked ? (
          <div className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2.5 text-[12.5px] text-fg-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            {agent?.dependents.join("、")} 继承了它，先改掉它们的 extends 再删。
          </div>
        ) : agent?.projectDefault && dialog.kind === "delete" ? (
          <p className="text-[12.5px] text-fg-2">它是这个工作区的默认 Agent，删掉后工作区改用 default。</p>
        ) : null}
      </Modal>
    );
  }

  const identity = dialog.section === "identity";
  const adding = dialog.section === null;
  const sectionName = identity ? "identity" : (dialog.section ?? name);
  const file = promptFileName(dialog.agent, sectionName || "section");
  const builtIn = dialog.section ? promptData?.inventory?.promptSections.find((s) => s.name === dialog.section && s.source === "built-in") : undefined;
  const known = promptData?.inventory?.promptSections.map((s) => s.name) ?? [];
  const addError = adding && name ? (!SECTION_NAME.test(name) ? "用小写字母、数字、_ 和 -" : known.includes(name) ? "已经有这个段了" : undefined) : undefined;
  return (
    <Modal
      open
      onOpenChange={open}
      width={680}
      title={identity ? `${dialog.agent} 的身份段` : adding ? "添加提示词段" : `改写 ${SECTION_LABEL[dialog.section ?? ""] ?? dialog.section}`}
      description={`保存到 ${PROMPTS_DIR}${file}，并在 harnesses.${dialog.agent} 里引用它。`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={busy || !promptData || (adding && (!name || !!addError)) || (!identity && !text.trim())}
            onClick={() =>
              void run(() =>
                savePrompt(dialog.agent, file, text, (spec, current, ref) => {
                  if (identity) return setKey(spec, "prompt.identity", { file: ref });
                  const sections = specSections(current.resolved);
                  const previous = sections[sectionName];
                  const placed = adding ? after : typeof previous === "object" ? previous.after : undefined;
                  return setKey(spec, "prompt.sections", { ...sections, [sectionName]: { file: ref, ...(placed ? { after: placed } : {}) } });
                }),
              )
            }
          >
            保存
          </Button>
        </>
      }
    >
      {adding && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="段名" hint={addError ? <span className="text-danger">{addError}</span> : undefined}>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="review-rules" aria-label="段名" className={`${inputClass} font-mono`} />
          </Field>
          <Field label="放在哪一段后面">
            <select value={after} onChange={(e) => setAfter(e.target.value)} className={inputClass}>
              {PLACEMENTS.map((p) => (
                <option key={p} value={p}>
                  {SECTION_LABEL[p] ?? p}（{p}）
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}
      <Field label="内容" hint={identity ? "留空就不发送身份段。" : builtIn ? "保存后用这段文字代替内置的内容。" : undefined}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={12}
          spellCheck={false}
          aria-label="提示词内容"
          className="scroll-thin w-full resize-y rounded-[10px] border border-line bg-canvas px-3 py-2.5 font-mono text-[12.5px] leading-[1.6] text-fg outline-none focus:border-accent-line"
        />
      </Field>
    </Modal>
  );
}
