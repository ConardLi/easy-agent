import type { ElectronApplication } from "@playwright/test";
import type { RequestDiff, SessionContext } from "../../src/shared/agent";

/** Test-only replay at the IPC boundary; all other calls still go to the real Agent. */
export async function replayRequests(
  app: ElectronApplication,
  replies: { context?: SessionContext; comparison?: RequestDiff; error?: string; delay?: number },
) {
  await app.evaluate(({ ipcMain }, data) => {
    const state = globalThis as typeof globalThis & { requestReplayCompleted?: number };
    state.requestReplayCompleted = 0;
    type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;
    const handlers = (ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
    const original = handlers.get("agent:call");
    if (!original) throw new Error("Agent IPC handler missing");
    ipcMain.removeHandler("agent:call");
    ipcMain.handle("agent:call", async (event, workspace, method, params) => {
      if ((method === "session/context" && data.context) || (method === "runtime/diffHarness" && data.comparison)) {
        if (data.delay) await new Promise((resolve) => setTimeout(resolve, data.delay));
        state.requestReplayCompleted = (state.requestReplayCompleted ?? 0) + 1;
        if (data.error) return { ok: false, error: { code: -32000, message: data.error } };
        return { ok: true, result: method === "session/context" ? data.context : { request: data.comparison } };
      }
      return original(event, workspace, method, params);
    });
  }, replies);
}

export async function completedReplays(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => (globalThis as typeof globalThis & { requestReplayCompleted?: number }).requestReplayCompleted ?? 0);
}
