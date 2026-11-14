/**
 * The Agent page: which Agent and tab it shows, and what it read about each
 * Agent from the workspace's default-Agent process (stored spec, resolved
 * settings, and the components as that Agent has them). Every change goes
 * through `harness/*`; afterwards the Agents it affected are read again.
 *
 * Processes that run a changed Agent resolve it again before their next
 * model request, so switches apply from the next turn. MCP servers start
 * with the process, so a change to them marks those processes as stale
 * until they restart.
 */

import { create } from "zustand";
import type { HarnessDefinition, HarnessImportPreview, ResolvedHarness, RuntimeInventory } from "../../shared/agent";
import { AgentCallError, agent, describeError } from "../agent/client";
import type { HarnessTab } from "../features/agents/model";
import { desktop } from "../lib/desktop";
import { loadAgents } from "./actions";
import { useUi } from "./ui";
import { useWorkspaces } from "./workspaces";

export interface AgentData {
  definition: HarnessDefinition;
  resolved: ResolvedHarness;
  /** Null when the Agent does not resolve. */
  inventory: RuntimeInventory | null;
}

/** An import the user is looking at before confirming it. */
export interface PendingImport {
  file: string;
  data: unknown;
  preview: HarnessImportPreview;
}

interface AgentsStore {
  open: boolean;
  name: string;
  tab: HarnessTab;
  /** By `workspaceId \0 name`. */
  data: Record<string, AgentData>;
  errors: Record<string, string>;
  /** Agents whose running processes started before a change to their MCP servers, per workspace. */
  staleMcp: Record<string, string[]>;
  pendingImport: PendingImport | null;
  openAgents(name?: string, tab?: HarnessTab): void;
  closeAgents(): void;
}

export const keyOf = (workspaceId: string, name: string) => `${workspaceId}\u0000${name}`;

export const useAgents = create<AgentsStore>()((set) => ({
  open: false,
  name: "default",
  tab: "prompt",
  data: {},
  errors: {},
  staleMcp: {},
  pendingImport: null,
  openAgents: (name, tab) => {
    set((s) => ({ open: true, name: name ?? s.name, tab: tab ?? s.tab }));
    void import("./settings").then(({ useSettings }) => useSettings.getState().closeSettings());
    void import("./customize").then(({ useCustomize }) => useCustomize.getState().closeCustomize());
    const workspaceId = useWorkspaces.getState().activeId;
    if (workspaceId) void loadAgent(workspaceId, name ?? useAgents.getState().name);
  },
  closeAgents: () => set({ open: false }),
}));

const toast = (text: string, tone: "default" | "success" | "danger" = "default") => useUi.getState().toast(text, tone);
const fail = (error: unknown) => toast(describeError(error), "danger");
const activeId = () => useWorkspaces.getState().activeId;

/** Read one Agent: its stored spec, its resolved settings, and its components. */
export async function loadAgent(workspaceId: string, name: string): Promise<void> {
  const key = keyOf(workspaceId, name);
  try {
    const [definition, resolved] = await Promise.all([agent.call(workspaceId, "harness/read", { name }), agent.call(workspaceId, "runtime/harness", { name })]);
    const broken = resolved.issues.some((issue) => issue.level === "error");
    const inventory = broken ? null : await agent.call(workspaceId, "runtime/inventory", { harness: { name } });
    useAgents.setState((s) => {
      const { [key]: _, ...errors } = s.errors;
      return { data: { ...s.data, [key]: { definition, resolved, inventory } }, errors };
    });
  } catch (error) {
    useAgents.setState((s) => ({ errors: { ...s.errors, [key]: describeError(error) } }));
  }
}

/** After a change: the list, every affected Agent the page has read, and the customize data. */
async function refresh(workspaceId: string, affected: readonly string[]): Promise<void> {
  const { data } = useAgents.getState();
  const cached = Object.keys(data)
    .filter((key) => key.startsWith(`${workspaceId}\u0000`))
    .map((key) => key.slice(workspaceId.length + 1));
  const reread = new Set([...affected.filter((name) => cached.includes(name)), useAgents.getState().name]);
  await Promise.all([loadAgents(workspaceId), ...[...reread].map((name) => loadAgent(workspaceId, name))]);
  void import("./customize").then((m) => m.loadInventory(workspaceId));
}

/** Agents among `names` that a process of the workspace runs now. */
function runningAgents(workspaceId: string, names: readonly string[]): string[] {
  const runtime = useWorkspaces.getState().runtime[workspaceId];
  if (!runtime) return [];
  const running = [runtime.status, ...Object.values(runtime.agentHosts)].flatMap((status) => (status.state === "ready" ? [status.harness.name] : []));
  return names.filter((name) => running.includes(name));
}

/**
 * Write a new spec for `name`, built from what the page has for it. `mcp`
 * marks running processes of the affected Agents as stale.
 */
export async function writeSpec(
  name: string,
  build: (spec: Record<string, unknown>, data: AgentData) => Record<string, unknown>,
  { mcp = false, message }: { mcp?: boolean; message?: string } = {},
): Promise<boolean> {
  const workspaceId = activeId();
  const current = workspaceId ? useAgents.getState().data[keyOf(workspaceId, name)] : undefined;
  if (!workspaceId || !current) return false;
  try {
    const result = await agent.call(workspaceId, "harness/write", { name, spec: build(current.definition.spec, current) });
    if (mcp) {
      const stale = runningAgents(workspaceId, result.affected);
      if (stale.length > 0)
        useAgents.setState((s) => ({ staleMcp: { ...s.staleMcp, [workspaceId]: [...new Set([...(s.staleMcp[workspaceId] ?? []), ...stale])] } }));
    }
    toast(message ?? `已写入 harnesses.${name}`);
    await refresh(workspaceId, result.affected);
    return true;
  } catch (error) {
    fail(error);
    await loadAgent(workspaceId, name);
    return false;
  }
}

/** Save identity or section text to `~/.easy-agent/prompts/` and reference it from the Agent. */
export async function savePrompt(
  name: string,
  fileName: string,
  text: string,
  build: (spec: Record<string, unknown>, data: AgentData, file: string) => Record<string, unknown>,
): Promise<boolean> {
  const workspaceId = activeId();
  if (!workspaceId) return false;
  try {
    const { file, path } = await agent.call(workspaceId, "harness/writePrompt", { name: fileName, text });
    return await writeSpec(name, (spec, data) => build(spec, data, file), { message: `已保存 ${path.replace(/^.*\/\.easy-agent\//, "~/.easy-agent/")}` });
  } catch (error) {
    fail(error);
    return false;
  }
}

export async function restartStaleAgents(): Promise<void> {
  const workspaceId = activeId();
  if (!workspaceId) return;
  const names = useAgents.getState().staleMcp[workspaceId] ?? [];
  const restarted = await desktop.agent.restartAgents(workspaceId, names);
  useAgents.setState((s) => ({ staleMcp: { ...s.staleMcp, [workspaceId]: [] } }));
  toast(restarted.length > 0 ? `已重启 ${restarted.join("、")} 的进程` : "这些 Agent 的进程已经停了，下次用时会按新设置启动");
}

/** Create an Agent; `spec` is its whole definition. */
export async function createAgent(name: string, spec: Record<string, unknown>, message: string): Promise<boolean> {
  const workspaceId = activeId();
  if (!workspaceId) return false;
  try {
    await agent.call(workspaceId, "harness/write", { name, spec });
    toast(message);
    await loadAgents(workspaceId);
    useAgents.getState().openAgents(name);
    return true;
  } catch (error) {
    fail(error);
    return false;
  }
}

export async function renameAgent(from: string, to: string): Promise<boolean> {
  const workspaceId = activeId();
  if (!workspaceId) return false;
  try {
    const result = await agent.call(workspaceId, "harness/rename", { from, to });
    toast(`已把 ${from} 改名为 ${to}${result.updatedExtends.length ? `，${result.updatedExtends.join("、")} 的 extends 跟着改了` : ""}`);
    useAgents.setState((s) => {
      const { [keyOf(workspaceId, from)]: _, ...data } = s.data;
      return { data };
    });
    await refresh(workspaceId, result.affected);
    useAgents.getState().openAgents(to);
    return true;
  } catch (error) {
    fail(error);
    return false;
  }
}

/** Delete an Agent, or for `default` drop the changes to the built-in one. */
export async function deleteAgent(name: string): Promise<boolean> {
  const workspaceId = activeId();
  if (!workspaceId) return false;
  try {
    const result = await agent.call(workspaceId, "harness/delete", { name });
    toast(name === "default" ? "default 已恢复成内置预设" : `已删除 ${name}`);
    if (name !== "default")
      useAgents.setState((s) => {
        const { [keyOf(workspaceId, name)]: _, ...data } = s.data;
        return { data };
      });
    await refresh(
      workspaceId,
      result.affected.filter((agentName) => agentName !== name || name === "default"),
    );
    if (name !== "default") useAgents.getState().openAgents("default");
    return true;
  } catch (error) {
    fail(error);
    return false;
  }
}

export async function setProjectDefault(name: string): Promise<void> {
  const workspaceId = activeId();
  if (!workspaceId) return;
  try {
    const { path } = await agent.call(workspaceId, "harness/setProjectDefault", { name });
    toast(`这个工作区默认用 ${name}，写在 ${path.replace(/^.*\/(\.easy-agent\/)/, "$1")}`);
    await loadAgents(workspaceId);
  } catch (error) {
    if (error instanceof AgentCallError && error.sdkCode === "untrusted") toast("信任这个工作区以后才能设默认 Agent", "danger");
    else fail(error);
  }
}

export async function exportAgent(name: string): Promise<void> {
  const workspaceId = activeId();
  if (!workspaceId) return;
  try {
    const exported = await agent.call(workspaceId, "harness/export", { name });
    const saved = await desktop.app.saveText(`${name}.agent.json`, `${JSON.stringify(exported, null, 2)}\n`);
    if (saved) toast(`已导出到 ${saved}，提示词文件已经内联`, "success");
  } catch (error) {
    fail(error);
  }
}

/** Pick an exported Agent and preview what it would turn on here. */
export async function pickImport(): Promise<void> {
  const workspaceId = activeId();
  if (!workspaceId) return;
  try {
    const picked = await desktop.agent.pickImport();
    if (!picked) return;
    const preview = await agent.call(workspaceId, "harness/previewImport", { data: picked.data });
    useAgents.setState({ pendingImport: { ...picked, preview } });
  } catch (error) {
    fail(error);
  }
}

export async function confirmImport(name: string): Promise<boolean> {
  const workspaceId = activeId();
  const pending = useAgents.getState().pendingImport;
  if (!workspaceId || !pending) return false;
  try {
    const replace = name === pending.preview.name && pending.preview.exists;
    const result = await agent.call(workspaceId, "harness/import", {
      data: pending.data,
      fingerprint: pending.preview.fingerprint,
      ...(name !== pending.preview.name ? { name } : {}),
      ...(replace ? { replace: true } : {}),
    });
    useAgents.setState({ pendingImport: null });
    toast(`已导入 ${result.name}`, "success");
    await refresh(workspaceId, result.affected);
    useAgents.getState().openAgents(result.name);
    return true;
  } catch (error) {
    fail(error);
    return false;
  }
}

/**
 * Turn components of the Agent the workspace's default process runs on or
 * off from the customize pages: `change` gets that Agent's stored spec and
 * resolved settings, read fresh, and returns the new spec.
 */
export async function changeWorkspaceAgent(
  change: (spec: Record<string, unknown>, resolved: ResolvedHarness) => Record<string, unknown>,
  { mcp = false, message }: { mcp?: boolean; message: (agent: string) => string },
): Promise<void> {
  const workspaceId = activeId();
  const runtime = workspaceId ? useWorkspaces.getState().runtime[workspaceId] : undefined;
  if (!workspaceId || runtime?.status.state !== "ready") return;
  const name = runtime.status.harness.name;
  try {
    const [definition, resolved] = await Promise.all([agent.call(workspaceId, "harness/read", { name }), agent.call(workspaceId, "runtime/harness", { name })]);
    const result = await agent.call(workspaceId, "harness/write", { name, spec: change(definition.spec, resolved) });
    if (mcp) {
      const stale = runningAgents(workspaceId, result.affected);
      if (stale.length > 0)
        useAgents.setState((s) => ({ staleMcp: { ...s.staleMcp, [workspaceId]: [...new Set([...(s.staleMcp[workspaceId] ?? []), ...stale])] } }));
    }
    toast(message(name));
    await refresh(workspaceId, result.affected);
  } catch (error) {
    fail(error);
  }
}
