/**
 * The customize view and the data behind it: what each workspace's Agent has
 * loaded (`runtime/inventory`), the settings files as the Agent reads them
 * (`config/read`, for editing hooks, MCP servers, and rule exclusions), and
 * the context breakdown of open sessions (`session/context`).
 *
 * Every change goes to the Agent or to a file, then the inventory is read
 * again, so the pages show what the Agent actually uses.
 */

import { create } from "zustand";
import type { ConfigSnapshot, RuntimeInventory, SessionContext } from "../../shared/agent";
import { agent, describeError } from "../agent/client";
import { SCOPE_FILE, type WriteScope } from "../lib/scopes";
import { useUi } from "./ui";
import { useWorkspaces } from "./workspaces";

export type CustomizeTab = "skills" | "mcp" | "plugins" | "hooks" | "rules" | "tools";

interface CustomizeStore {
  open: boolean;
  tab: CustomizeTab;
  /** Settings file that switches and exclusions on these pages write to. */
  writeScope: WriteScope;
  inventories: Record<string, RuntimeInventory>;
  configs: Record<string, ConfigSnapshot>;
  errors: Record<string, string>;
  /** Context breakdown of each open session, from its latest read. */
  contexts: Record<string, SessionContext>;
  openCustomize(tab?: CustomizeTab): void;
  closeCustomize(): void;
  setWriteScope(scope: WriteScope): void;
}

export const useCustomize = create<CustomizeStore>()((set) => ({
  open: false,
  tab: "skills",
  writeScope: "user",
  inventories: {},
  configs: {},
  errors: {},
  contexts: {},
  openCustomize: (tab) => {
    set((s) => ({ open: true, tab: tab ?? s.tab }));
    void import("./settings").then(({ useSettings }) => useSettings.getState().closeSettings());
    void loadInventory();
  },
  closeCustomize: () => set({ open: false }),
  setWriteScope: (writeScope) => set({ writeScope }),
}));

/** The active workspace's inventory and settings, once read. */
export function useWorkspaceData(): { inventory: RuntimeInventory | undefined; config: ConfigSnapshot | undefined; error: string | undefined } {
  const id = useWorkspaces((s) => s.activeId);
  const inventory = useCustomize((s) => (id ? s.inventories[id] : undefined));
  const config = useCustomize((s) => (id ? s.configs[id] : undefined));
  const error = useCustomize((s) => (id ? s.errors[id] : undefined));
  return { inventory, config, error };
}

const toast = (text: string, tone: "default" | "success" | "danger" = "default") => useUi.getState().toast(text, tone);
const fail = (error: unknown) => toast(describeError(error), "danger");

const activeId = () => useWorkspaces.getState().activeId;
const ready = (workspaceId: string | null): workspaceId is string => !!workspaceId && useWorkspaces.getState().runtime[workspaceId]?.status.state === "ready";

const PENDING_POLL_MS = 1000;
const PENDING_POLL_LIMIT = 60;
const pendingPolls = new Map<string, { timer: ReturnType<typeof setTimeout>; left: number }>();

/**
 * Read the workspace's inventory and settings from its Agent. MCP servers
 * connect in the background after the Agent starts, so while any server is
 * still connecting the inventory is read again every second, for up to a minute.
 */
export async function loadInventory(workspaceId = activeId()): Promise<void> {
  if (!ready(workspaceId)) return;
  try {
    const [inventory, config] = await Promise.all([agent.call(workspaceId, "runtime/inventory", {}), agent.call(workspaceId, "config/read", {})]);
    useCustomize.setState((s) => {
      const { [workspaceId]: _, ...errors } = s.errors;
      return { inventories: { ...s.inventories, [workspaceId]: inventory }, configs: { ...s.configs, [workspaceId]: config }, errors };
    });
    const poll = pendingPolls.get(workspaceId);
    clearTimeout(poll?.timer);
    const left = poll ? poll.left - 1 : PENDING_POLL_LIMIT;
    if (inventory.mcpServers.some((m) => m.status === "pending") && left > 0) {
      pendingPolls.set(workspaceId, { timer: setTimeout(() => void loadInventory(workspaceId), PENDING_POLL_MS), left });
    } else pendingPolls.delete(workspaceId);
  } catch (error) {
    useCustomize.setState((s) => ({ errors: { ...s.errors, [workspaceId]: describeError(error) } }));
  }
}

/** Reload skills, commands, sub-agents, output styles, and plugins after files changed on disk. */
export async function reloadExtensions(workspaceId = activeId()): Promise<void> {
  if (!ready(workspaceId)) return;
  try {
    const result = await agent.call(workspaceId, "runtime/reload", {});
    if (result.errors.length > 0) toast(`重新加载时有 ${result.errors.length} 个插件报错：${result.errors[0]}`, "danger");
  } catch (error) {
    fail(error);
  }
  await loadInventory(workspaceId);
}

export async function approveMcpServer(name: string, approved: boolean): Promise<void> {
  const workspaceId = activeId();
  if (!ready(workspaceId)) return;
  try {
    const result = await agent.call(workspaceId, "mcp/approve", { name, approved });
    if (result.error) toast(result.error, "danger");
    else if (!approved) toast(`已拒绝 ${name}，记录在 ${SCOPE_FILE[result.scope]} 的 disabledMcpjsonServers`);
    else if (result.status === "connected") toast(`已批准 ${name}，写入 ${SCOPE_FILE[result.scope]} 的 enabledMcpjsonServers`, "success");
    else toast(`已批准 ${name}，但没有连上`, "danger");
  } catch (error) {
    fail(error);
  }
  await loadInventory(workspaceId);
}

export async function reconnectMcpServer(name: string): Promise<void> {
  const workspaceId = activeId();
  if (!ready(workspaceId)) return;
  try {
    const result = await agent.call(workspaceId, "mcp/reconnect", { name });
    if (result.status === "connected") toast(`${name} 已重新连接，${result.toolCount} 个工具`, "success");
    else toast(result.error ? `${name} 连接失败：${result.error}` : `${name} 还没有连上`, "danger");
  } catch (error) {
    fail(error);
  }
  await loadInventory(workspaceId);
}

/** Write one settings key through the Agent, then read everything again. Returns whether it was written. */
export async function writeSetting(scope: WriteScope, key: string, value: unknown, message?: string): Promise<boolean> {
  const workspaceId = activeId();
  if (!ready(workspaceId)) return false;
  let ok = false;
  try {
    const { reload } = await agent.call(workspaceId, "config/write", { scope, key, value });
    ok = true;
    toast(reload === "restart" ? `${message ?? `已写入 ${SCOPE_FILE[scope]}`}，重启 Agent 进程后生效` : (message ?? `已写入 ${SCOPE_FILE[scope]}`));
  } catch (error) {
    fail(error);
  }
  await loadInventory(workspaceId);
  return ok;
}

/** Display-safe values of one settings file, as the Agent read them. */
export function sourceValues(config: ConfigSnapshot | undefined, scope: WriteScope): Record<string, unknown> {
  return config?.sources.find((s) => s.source === scope)?.values ?? {};
}

/**
 * MCP servers configured in settings start with the Agent process, so a new
 * or removed one applies after a restart. Restart now unless a turn is running.
 */
export async function restartForMcp(workspaceId = activeId()): Promise<void> {
  if (!workspaceId) return;
  const { useSessions } = await import("./sessions");
  const busy = Object.values(useSessions.getState().views).some((v) => v.workspaceId === workspaceId && v.busy);
  if (busy) {
    toast("这一轮结束后，到「设置 · Agent 进程」里重启，新的 MCP 配置才会生效");
    return;
  }
  const { restartAgent } = await import("./actions");
  await restartAgent(workspaceId);
  await loadInventory(workspaceId);
}

/** Read how the session's next request fills the context window. */
export async function loadContext(workspaceId: string, sessionId: string): Promise<void> {
  try {
    const context = await agent.call(workspaceId, "session/context", { sessionId });
    useCustomize.setState((s) => ({ contexts: { ...s.contexts, [sessionId]: context } }));
  } catch {
    // The session closed or the Agent restarted; the panel keeps the last reading.
  }
}
