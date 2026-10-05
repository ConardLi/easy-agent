/**
 * What the interface asks of the Agent. The views themselves only change
 * through session events (see state/sessions.ts); these functions send the
 * requests and keep the workspace list and saved-session list current.
 */

import type { SessionEvent } from "../../shared/agent";
import { agent, describeError } from "../agent/client";
import { viewFromState } from "../agent/projector/session";
import type { Effort, PermissionMode } from "../agent/viewModel";
import { desktop } from "../lib/desktop";
import { useSessions } from "./sessions";
import { useUi } from "./ui";
import { useWorkspaces } from "./workspaces";

const toast = (text: string, tone: "default" | "success" | "danger" = "default") => useUi.getState().toast(text, tone);
const fail = (error: unknown) => toast(describeError(error), "danger");

// ─── Events ───────────────────────────────────────────────────────────────

let pending: { workspaceId: string; event: SessionEvent }[] = [];
let frame = 0;
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Apply streamed events once per animation frame instead of once per token. */
function enqueue(workspaceId: string, event: SessionEvent): void {
  pending.push({ workspaceId, event });
  if (event.type === "turn_completed") scheduleRefresh(workspaceId);
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const batch = pending;
    pending = [];
    useSessions.getState().applyEvents(batch);
  });
}

function scheduleRefresh(workspaceId: string): void {
  clearTimeout(refreshTimers.get(workspaceId));
  refreshTimers.set(
    workspaceId,
    setTimeout(() => void refreshSessions(workspaceId), 300),
  );
}

// ─── Workspaces ───────────────────────────────────────────────────────────

export async function bootstrap(): Promise<void> {
  desktop.agent.onEvent(({ workspaceId, event }) => enqueue(workspaceId, event));
  desktop.agent.onStatus((workspaceId, status) => {
    useWorkspaces.getState().patchRuntime(workspaceId, { status });
    if (status.state === "ready") void refreshSessions(workspaceId);
  });
  desktop.agent.onLog(({ level, message }) => {
    if (level === "error") toast(message, "danger");
    else console.warn(message);
  });
  desktop.workspaces.onChange((state) => useWorkspaces.setState(state));

  const state = await desktop.workspaces.get();
  useWorkspaces.setState(state);
  if (state.activeId) await showWorkspace(state.activeId, { reopenLast: true });
}

/** Start the workspace's Agent, load its sessions, and pick the conversation to show. */
async function showWorkspace(id: string, { reopenLast = false } = {}): Promise<void> {
  const { patchRuntime } = useWorkspaces.getState();
  void desktop.workspaces.branch(id).then((branch) => patchRuntime(id, { branch }));
  const status = await desktop.agent.start(id);
  patchRuntime(id, { status });
  if (status.state !== "ready") return;
  await adoptOpenSessions(id);
  await refreshSessions(id);
  const workspace = useWorkspaces.getState().workspaces.find((w) => w.id === id);
  const last = workspace?.lastSessionId;
  if (reopenLast && last && useWorkspaces.getState().runtime[id]?.sessions?.some((s) => s.sessionId === last)) await openSession(id, last);
}

/** Sessions the Agent still has open, e.g. after the window reloaded. */
async function adoptOpenSessions(workspaceId: string): Promise<void> {
  for (const sessionId of await desktop.agent.openSessions(workspaceId)) {
    if (useSessions.getState().views[sessionId]) continue;
    try {
      const { state, seq } = await agent.snapshot(workspaceId, sessionId);
      useSessions.setState((s) => ({ views: { ...s.views, [sessionId]: viewFromState(workspaceId, state, seq) } }));
    } catch {
      // Closed in the meantime.
    }
  }
}

export async function refreshSessions(workspaceId: string): Promise<void> {
  try {
    const { sessions } = await agent.call(workspaceId, "session/list", {});
    useWorkspaces.getState().patchRuntime(workspaceId, { sessions });
  } catch (error) {
    console.warn(describeError(error));
  }
}

export async function openFolder(): Promise<void> {
  const workspace = await desktop.workspaces.openFolder();
  if (!workspace) return;
  useSessions.setState({ activeId: null });
  await showWorkspace(workspace.id);
}

export async function switchWorkspace(id: string): Promise<void> {
  if (useWorkspaces.getState().activeId === id) return newSession();
  await desktop.workspaces.activate(id);
  useSessions.setState({ activeId: null });
  await showWorkspace(id, { reopenLast: true });
}

/** Trust decisions are made when the Agent initializes, so trusting restarts it. */
export async function trustWorkspace(workspaceId: string): Promise<void> {
  const status = await desktop.agent.restart(workspaceId, "session");
  useWorkspaces.getState().patchRuntime(workspaceId, { status });
  if (status.state === "ready") toast("已信任这个工作区，直到退出应用", "success");
}

export async function restartAgent(workspaceId: string): Promise<void> {
  const current = useWorkspaces.getState().runtime[workspaceId]?.status;
  const trust = current?.state === "ready" ? current.trust : "persisted";
  const status = await desktop.agent.restart(workspaceId, trust);
  useWorkspaces.getState().patchRuntime(workspaceId, { status });
}

// ─── Sessions ─────────────────────────────────────────────────────────────

const activeWorkspaceId = () => useWorkspaces.getState().activeId;

function remember(workspaceId: string, sessionId: string): void {
  void desktop.workspaces.update(workspaceId, { lastSessionId: sessionId });
}

export function newSession(): void {
  useSessions.setState({ activeId: null });
}

export async function openSession(workspaceId: string, sessionId: string): Promise<void> {
  const { views } = useSessions.getState();
  if (!views[sessionId]) {
    try {
      const { state } = await agent.call(workspaceId, "session/resume", { sessionId });
      // The snapshot event may still be queued for the next frame; seed the view from the response.
      useSessions.setState((s) => (s.views[sessionId] ? s : { views: { ...s.views, [sessionId]: viewFromState(workspaceId, state, -1) } }));
    } catch (error) {
      return fail(error);
    }
  }
  useSessions.setState((s) => {
    const { [sessionId]: _, ...unread } = s.unread;
    return { activeId: sessionId, unread };
  });
  remember(workspaceId, sessionId);
}

const EFFORT_COMMANDS: Record<Effort, [string, string[]][]> = {
  off: [["think", ["off"]]],
  default: [
    ["think", ["on"]],
    ["effort", ["default"]],
  ],
  low: [
    ["think", ["on"]],
    ["effort", ["low"]],
  ],
  medium: [
    ["think", ["on"]],
    ["effort", ["medium"]],
  ],
  high: [
    ["think", ["on"]],
    ["effort", ["high"]],
  ],
  max: [
    ["think", ["on"]],
    ["effort", ["max"]],
  ],
};

async function runCommands(workspaceId: string, sessionId: string, commands: [string, string[]][]): Promise<void> {
  for (const [name, args] of commands) await agent.call(workspaceId, "session/command", { sessionId, name, args });
}

export async function sendMessage(text: string): Promise<boolean> {
  const workspaceId = activeWorkspaceId();
  const input = text.trim();
  if (!workspaceId || !input) return false;
  let sessionId = useSessions.getState().activeId;
  try {
    if (!sessionId) {
      const { draft } = useSessions.getState();
      const created = await agent.call(workspaceId, "session/create", {
        permissionMode: draft.mode,
        ...(draft.model ? { model: draft.model } : {}),
      });
      sessionId = created.sessionId;
      const id = sessionId;
      useSessions.setState((s) => ({
        activeId: id,
        views: s.views[id] ? s.views : { ...s.views, [id]: viewFromState(workspaceId, created.state, -1) },
      }));
      remember(workspaceId, id);
      if (draft.effort !== "default") await runCommands(workspaceId, id, EFFORT_COMMANDS[draft.effort]);
    }
    // The reply streams in as events; the returned turn result is not needed.
    void agent.call(workspaceId, "session/send", { sessionId, input }).catch(fail);
    return true;
  } catch (error) {
    fail(error);
    return false;
  }
}

export async function interrupt(): Promise<void> {
  const view = useSessions.getState().activeId ? useSessions.getState().views[useSessions.getState().activeId!] : undefined;
  if (!view) return;
  await agent.call(view.workspaceId, "session/interrupt", { sessionId: view.id }).catch(fail);
}

/**
 * Mode, model, and effort changes run as local commands, which wait for an
 * idle session. TODO(G1): `session/setPermissionMode` and friends switch
 * immediately, also while a turn runs.
 */
async function changeActive(commands: [string, string[]][], draftPatch: Parameters<ReturnType<typeof useSessions.getState>["setDraft"]>[0]): Promise<void> {
  const { activeId, views, setDraft } = useSessions.getState();
  const view = activeId ? views[activeId] : undefined;
  if (!view) return setDraft(draftPatch);
  if (view.busy) return toast("这一轮结束后才能切换");
  await runCommands(view.workspaceId, view.id, commands).catch(fail);
}

export const setMode = (mode: PermissionMode) => changeActive([["mode", [mode]]], { mode });
export const setModel = (model: string) => changeActive([["model", [model]]], { model });
export const setEffort = (effort: Effort) => changeActive(EFFORT_COMMANDS[effort], { effort });

export async function renameSession(workspaceId: string, sessionId: string, title: string): Promise<void> {
  try {
    await agent.call(workspaceId, "session/rename", { sessionId, title });
    await refreshSessions(workspaceId);
  } catch (error) {
    fail(error);
  }
}

export async function forkSession(workspaceId: string, sessionId: string, title?: string): Promise<void> {
  try {
    const { session } = await agent.call(workspaceId, "session/fork", { sessionId, ...(title ? { title: `${title}（分叉）` } : {}) });
    await refreshSessions(workspaceId);
    await openSession(workspaceId, session.sessionId);
    toast("已分叉为新会话", "success");
  } catch (error) {
    fail(error);
  }
}

export async function deleteSession(workspaceId: string, sessionId: string): Promise<void> {
  try {
    // A session must be closed before its files can go.
    if (useSessions.getState().views[sessionId]) {
      await agent.call(workspaceId, "session/close", { sessionId });
      useSessions.setState((s) => {
        const { [sessionId]: _, ...views } = s.views;
        return { views, activeId: s.activeId === sessionId ? null : s.activeId };
      });
    }
    await agent.call(workspaceId, "session/delete", { sessionId });
    await refreshSessions(workspaceId);
    toast("会话已删除");
  } catch (error) {
    fail(error);
  }
}

export async function togglePin(workspaceId: string, sessionId: string): Promise<void> {
  const workspace = useWorkspaces.getState().workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return;
  const pinned = workspace.pinnedSessions.includes(sessionId)
    ? workspace.pinnedSessions.filter((id) => id !== sessionId)
    : [...workspace.pinnedSessions, sessionId];
  await desktop.workspaces.update(workspaceId, { pinnedSessions: pinned });
}
