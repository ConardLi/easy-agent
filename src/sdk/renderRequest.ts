/**
 * Render the first request a session would send for an input, with a given
 * Agent, without sending it.
 *
 * The input runs as the first turn of a temporary session: no transcript, no
 * file checkpoints, no background wake-ups, and no interactions. The turn
 * takes the same path as in a real session (system prompt, tool list,
 * ToolSearch shaping, attachments, skill expansion for a `/skill` input) and
 * stops where its first main-loop request would go out: the request is
 * captured, the turn is aborted, and the provider is never called. No tool
 * runs, since no model output arrives, and no hook runs. The Agent applies
 * only to the work of the rendering; the runtime's open sessions keep theirs.
 */

import { withHarness } from "../harness/active.js";
import { harnessValue, type ResolvedHarness } from "../harness/resolve.js";
import { loadPermissionSettings } from "../permissions/permissions.js";
import { createSessionId } from "../session/storage.js";
import { createSessionScope } from "../state/sessionScope.js";
import { type RenderedRequest, renderRequests } from "../trace/requestRender.js";
import { AgentSdkError } from "./errors.js";
import { SessionController } from "./session/controller.js";

export async function renderFirstRequest(
  cwd: string,
  harness: ResolvedHarness,
  prompt: string,
): Promise<RenderedRequest> {
  if (!prompt.trim()) throw new AgentSdkError("invalid_argument", "The prompt is empty.");
  return withHarness(harness, async () => {
    const captured: { request?: RenderedRequest } = {};
    let controller: SessionController | null = null;
    await renderRequests(
      (request) => {
        if (request.purpose !== "main" || captured.request) return;
        captured.request = request;
        controller?.interrupt();
      },
      async () => {
        controller = await SessionController.create({
          scope: createSessionScope(),
          cwd,
          sessionId: createSessionId(),
          model: harnessValue<string>(harness, "model.main"),
          options: { persist: false, autoWake: false, interactions: [] },
          permissionSettings: await loadPermissionSettings(cwd),
          initialMessages: [],
          initialMessageIds: [],
          initialUsage: { input_tokens: 0, output_tokens: 0 },
          fileHistorySnapshots: [],
          revertedToolUses: [],
          onSessionReplaced: () => {},
          onClosed: () => {},
        });
        try {
          await controller.send(prompt);
        } finally {
          await controller.close();
        }
      },
    );
    if (!captured.request) {
      throw new AgentSdkError("invalid_argument", `${JSON.stringify(prompt)} makes no model request.`);
    }
    return captured.request;
  });
}
