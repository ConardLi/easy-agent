/**
 * The settings view: which page is open, which file Agent settings are
 * written to, and the active workspace's settings as the Agent reports them
 * (`config/read`). Every edit goes back through `config/write`, then the
 * snapshot is read again, so the pages always show what the files contain.
 */

import { create } from "zustand";
import type { ConfigSnapshot, ModelCheckResult } from "../../shared/agent";
import { agent, describeError } from "../agent/client";
import { type AgentSettings, agentFromConfig, type SettingKey, type SettingSources, writesFor } from "../features/settings/agentSettings";
import { keyName, modelsMapFor, providersFromConfig, reconcileProviders } from "../features/settings/providers";
import { desktop } from "../lib/desktop";
import type { ProviderConfig } from "../lib/models";
import { SCOPE_FILE, type WriteScope } from "../lib/scopes";
import { useUi } from "./ui";
import { useWorkspaces } from "./workspaces";

export type SettingsSection =
  | "general"
  | "appearance"
  | "shortcuts"
  | "runtime"
  | "about"
  | "models"
  | "behavior"
  | "permissions"
  | "sandbox"
  | "env"
  | "data"
  | "terminal";

export const AGENT_SECTIONS: SettingsSection[] = ["models", "behavior", "permissions", "sandbox", "env", "data", "terminal"];

interface SettingsStore {
  open: boolean;
  section: SettingsSection;
  writeScope: WriteScope;
  config: ConfigSnapshot | null;
  /** Workspace the snapshot was read from. */
  workspaceId: string | null;
  error: string | null;
  agent: AgentSettings | null;
  sources: SettingSources;
  providers: ProviderConfig[];
  secrets: Record<string, string>;
  /** Last connection check of each provider; not saved. */
  checks: Record<string, ModelCheckResult & { checking?: boolean }>;
  openSettings(section?: SettingsSection): void;
  closeSettings(): void;
  setWriteScope(scope: WriteScope): void;
}

export const useSettings = create<SettingsStore>()((set) => ({
  open: false,
  section: "general",
  writeScope: "user",
  config: null,
  workspaceId: null,
  error: null,
  agent: null,
  sources: {},
  providers: [],
  secrets: {},
  checks: {},
  openSettings: (section) => {
    set((s) => ({ open: true, section: section ?? s.section }));
    void loadConfig();
  },
  closeSettings: () => set({ open: false }),
  setWriteScope: (writeScope) => set({ writeScope }),
}));

const toast = (text: string, tone: "default" | "success" | "danger" = "default") => useUi.getState().toast(text, tone);

/** Read the active workspace's settings from its Agent. */
export async function loadConfig(): Promise<void> {
  const workspaceId = useWorkspaces.getState().activeId;
  const status = workspaceId ? useWorkspaces.getState().runtime[workspaceId]?.status : undefined;
  if (!workspaceId || status?.state !== "ready") {
    useSettings.setState({ config: null, workspaceId, agent: null, providers: [], error: workspaceId ? "Agent 进程还没有就绪" : null });
    return;
  }
  try {
    const [config, secrets] = await Promise.all([agent.call(workspaceId, "config/read", {}), desktop.secrets.list()]);
    const { agent: settings, sources } = agentFromConfig(config);
    const previous = useSettings.getState().workspaceId === workspaceId ? useSettings.getState().providers : [];
    const providers = reconcileProviders(previous, providersFromConfig(config, secrets));
    useSettings.setState({ config, workspaceId, agent: settings, sources, secrets, providers, error: null });
  } catch (error) {
    useSettings.setState({ error: describeError(error) });
  }
}

async function write(writes: { key: string; value: unknown }[], scope: WriteScope, quiet: boolean): Promise<boolean> {
  const { workspaceId } = useSettings.getState();
  if (!workspaceId || writes.length === 0) return false;
  try {
    const reloads = new Set<string>();
    for (const { key, value } of writes) reloads.add((await agent.call(workspaceId, "config/write", { scope, key, value })).reload);
    if (!quiet) toast(reloads.has("restart") ? `已写入 ${SCOPE_FILE[scope]}，重启 Agent 进程后生效` : `已写入 ${SCOPE_FILE[scope]}`);
    return true;
  } catch (error) {
    toast(describeError(error), "danger");
    return false;
  } finally {
    await loadConfig();
  }
}

/** Apply an edit to the settings and write the changed keys to the file being edited. */
export async function updateAgent(fn: (a: AgentSettings) => AgentSettings, keys: SettingKey[], quiet = false): Promise<void> {
  const { config, agent: current, writeScope } = useSettings.getState();
  if (!config || !current) return;
  const next = fn(current);
  useSettings.setState({ agent: next });
  await write(writesFor(config, writeScope, current, next, keys), writeScope, quiet);
}

/**
 * Apply an edit to the providers. Keys typed into the Models page are stored
 * in the keychain first; then each affected file's `models` map is written.
 * Agent processes pick up new keychain keys when they restart.
 */
export async function updateProviders(fn: (list: ProviderConfig[]) => ProviderConfig[]): Promise<void> {
  const { providers: current } = useSettings.getState();
  const next = fn(current);
  let secretsChanged = false;
  const saved: ProviderConfig[] = [];
  for (const p of next) {
    if (p.key.kind === "keychain" && p.key.value) {
      const name = p.key.name || keyName(p.id);
      try {
        await desktop.secrets.set(name, p.key.value);
      } catch (error) {
        toast(describeError(error), "danger");
        return;
      }
      secretsChanged = true;
      saved.push({ ...p, key: { kind: "keychain", name, masked: `${p.key.value.slice(0, 3)}••••••••${p.key.value.slice(-4)}` } });
    } else saved.push(p);
  }
  useSettings.setState({ providers: saved });
  const scopes = new Set([...current, ...saved].map((p) => p.scope));
  for (const scope of scopes) {
    const after = modelsMapFor(saved, scope);
    if (JSON.stringify(modelsMapFor(current, scope)) !== JSON.stringify(after))
      await write([{ key: "models", value: Object.keys(after).length ? after : null }], scope, true);
  }
  if (secretsChanged) await restartIdleAgents("密钥已存进钥匙串");
  else await loadConfig();
}

/** Restart every workspace's Agent process that has no turn running, so new keys and process settings apply. */
export async function restartIdleAgents(reason: string): Promise<void> {
  const { useSessions } = await import("./sessions");
  const { runtime } = useWorkspaces.getState();
  const views = Object.values(useSessions.getState().views);
  const busy = new Set(views.filter((v) => v.busy).map((v) => v.workspaceId));
  const running = Object.entries(runtime).filter(([, r]) => r.status.state === "ready" || r.status.state === "crashed");
  const restarted: string[] = [];
  for (const [id, r] of running) {
    if (busy.has(id)) continue;
    const trust = r.status.state === "ready" ? r.status.trust : "persisted";
    const status = await desktop.agent.restart(id, trust);
    useWorkspaces.getState().patchRuntime(id, { status });
    restarted.push(id);
  }
  const skipped = running.length - restarted.length;
  toast(skipped > 0 ? `${reason}。有 ${skipped} 个工作区正在运行，空闲后到「Agent 进程」里重启` : `${reason}，Agent 进程已重启`, "success");
  await loadConfig();
}

/** Send one small request through a provider's first model. */
export async function checkProvider(p: ProviderConfig): Promise<void> {
  const { workspaceId } = useSettings.getState();
  const handle = p.models.find((m) => m.enabled)?.handle;
  if (!workspaceId || !handle) return toast("先保存一个模型再检测");
  useSettings.setState((s) => ({ checks: { ...s.checks, [p.id]: { ok: false, protocol: p.protocol, model: handle, latencyMs: 0, checking: true } } }));
  try {
    const result = await agent.call(workspaceId, "models/check", { model: handle });
    useSettings.setState((s) => ({ checks: { ...s.checks, [p.id]: result } }));
  } catch (error) {
    useSettings.setState((s) => ({
      checks: { ...s.checks, [p.id]: { ok: false, protocol: p.protocol, model: handle, latencyMs: 0, error: describeError(error) } },
    }));
  }
}

/** Model ids the provider offers; null when it has no saved model to ask through or the request fails. */
export async function fetchProviderModels(p: ProviderConfig): Promise<string[] | null> {
  const { workspaceId } = useSettings.getState();
  const handle = p.models.find((m) => m.enabled)?.handle;
  if (!workspaceId || !handle) return null;
  try {
    return (await agent.call(workspaceId, "models/list", { model: handle })).models;
  } catch {
    return null;
  }
}

/** Save or revoke trust for a workspace, then restart its Agent so project settings apply or stop applying. */
export async function setWorkspaceTrust(workspaceId: string, trusted: boolean): Promise<void> {
  try {
    await desktop.agent.start(workspaceId);
    await agent.call(workspaceId, "workspace/trust", { trusted });
    const status = await desktop.agent.restart(workspaceId, "persisted");
    useWorkspaces.getState().patchRuntime(workspaceId, { status });
    toast(trusted ? "已信任这个工作区" : "已撤销信任", "success");
  } catch (error) {
    toast(describeError(error), "danger");
  }
  await loadConfig();
}
