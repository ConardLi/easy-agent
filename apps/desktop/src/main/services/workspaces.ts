import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { WorkspaceInfo, WorkspacePatch, WorkspacesState } from "../../shared/contract";

/** Avatar colors; a folder keeps its color because it is derived from the path. */
const COLORS = ["#6e74f7", "#f2703c", "#14a874", "#1d8fe0", "#e5487a", "#a855f7", "#0ea5a5", "#c98a0c"];

const colorFor = (path: string) => COLORS[createHash("sha1").update(path).digest()[0]! % COLORS.length]!;

export interface WorkspaceStore {
  get(): WorkspacesState;
  find(id: string): WorkspaceInfo | undefined;
  add(path: string): Promise<WorkspaceInfo>;
  activate(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  update(id: string, patch: WorkspacePatch): Promise<void>;
  onChange(listener: (state: WorkspacesState) => void): void;
}

function readState(file: string): WorkspacesState {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<WorkspacesState>;
    const workspaces = (Array.isArray(raw.workspaces) ? raw.workspaces : []).filter(
      (w): w is WorkspaceInfo => !!w && typeof w.id === "string" && typeof w.path === "string",
    );
    for (const w of workspaces) w.pinnedSessions = Array.isArray(w.pinnedSessions) ? w.pinnedSessions.filter((s) => typeof s === "string") : [];
    const activeId = workspaces.some((w) => w.id === raw.activeId) ? (raw.activeId as string) : (workspaces[0]?.id ?? null);
    return { workspaces, activeId };
  } catch {
    return { workspaces: [], activeId: null };
  }
}

/** The folders the user opened, most recent first, in one JSON file in the app data directory. */
export function createWorkspaceStore(file: string): WorkspaceStore {
  let state = readState(file);
  let writing: Promise<void> = Promise.resolve();
  const listeners: ((state: WorkspacesState) => void)[] = [];

  const commit = (next: WorkspacesState) => {
    state = next;
    for (const listener of listeners) listener(state);
    writing = writing
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
        await rename(tmp, file);
      })
      .catch((error: unknown) => console.error("Failed to save workspaces:", error));
    return writing;
  };

  const touch = (id: string) => {
    const now = Date.now();
    const target = state.workspaces.find((w) => w.id === id);
    if (!target) return state.workspaces;
    return [{ ...target, openedAt: now }, ...state.workspaces.filter((w) => w.id !== id)];
  };

  return {
    get: () => state,
    find: (id) => state.workspaces.find((w) => w.id === id),
    async add(path) {
      const resolved = await realpath(path);
      const existing = state.workspaces.find((w) => w.path === resolved);
      if (existing) {
        await commit({ workspaces: touch(existing.id), activeId: existing.id });
        return state.workspaces[0]!;
      }
      const now = Date.now();
      const created: WorkspaceInfo = {
        id: randomUUID(),
        path: resolved,
        name: basename(resolved) || resolved,
        color: colorFor(resolved),
        addedAt: now,
        openedAt: now,
        pinnedSessions: [],
      };
      await commit({ workspaces: [created, ...state.workspaces], activeId: created.id });
      return created;
    },
    async activate(id) {
      if (!state.workspaces.some((w) => w.id === id)) return;
      await commit({ workspaces: touch(id), activeId: id });
    },
    async remove(id) {
      const workspaces = state.workspaces.filter((w) => w.id !== id);
      await commit({ workspaces, activeId: state.activeId === id ? (workspaces[0]?.id ?? null) : state.activeId });
    },
    async update(id, patch) {
      const clean: WorkspacePatch = {};
      if (typeof patch.lastSessionId === "string") clean.lastSessionId = patch.lastSessionId;
      if (Array.isArray(patch.pinnedSessions)) clean.pinnedSessions = patch.pinnedSessions.filter((s) => typeof s === "string");
      await commit({ ...state, workspaces: state.workspaces.map((w) => (w.id === id ? { ...w, ...clean } : w)) });
    },
    onChange: (listener) => void listeners.push(listener),
  };
}
