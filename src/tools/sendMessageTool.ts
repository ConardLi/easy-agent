/**
 * SendMessage — drop a text message into a teammate's inbox.
 *
 * Reference: claude-code-source-code/src/tools/SendMessageTool/SendMessageTool.ts
 *
 * Supports ordinary messages and teammate control requests:
 *   - `to: "<name>"`  — write to one teammate's inbox
 *   - `to: "*"`       — broadcast to every active teammate (skip self)
 *
 *   - `type: "shutdown_request"` stops after the current tool batch.
 *   - `type: "abort_request"` cancels immediately.
 *
 * Skipped vs source:
 *   - Plan approval and permission-request routing.
 *   - UDS / bridge cross-machine routing.
 *   - SendMessage-to-stopped-agent auto-resume; the lead must start a
 *     new named run explicitly.
 *
 * Identity: who is "from"? Two paths converge here:
 *
 *   1. The team LEAD calls SendMessage — `from = TEAM_LEAD_NAME`.
 *   2. A TEAMMATE calls SendMessage — `from = <teammate's name>`.
 *
 * Path 2 needs the teammate's identity. We thread it through the
 * `ToolContext.teammateIdentity` field that AgentTool sets on the
 * sub-agent's enriched tool context. When the field is absent we
 * default to TEAM_LEAD_NAME — the symmetric assumption that any tool
 * call without a teammate identity is coming from the lead's session.
 */

import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { randomUUID } from "node:crypto";
import { getAsyncAgent, killAsyncAgent, requestShutdownAsyncAgent } from "../state/asyncAgentStore.js";
import { isAgentTeamsEnabled } from "../utils/agentTeamsEnabled.js";
import { getActiveTeam } from "../state/teamContext.js";
import {
  readTeamFileAsync,
  setMemberStatus,
  TEAM_LEAD_NAME,
} from "../utils/teamHelpers.js";
import { markControlRequestAsRead, writeToMailbox } from "../utils/teammateMailbox.js";

interface SendMessageInput {
  to: string;
  message: string;
  summary?: string;
  type?: "message" | "shutdown_request" | "abort_request";
}

function readInput(raw: Record<string, unknown>): SendMessageInput {
  const to = typeof raw["to"] === "string" ? raw["to"].trim() : "";
  const message = typeof raw["message"] === "string" ? raw["message"] : "";
  const summary =
    typeof raw["summary"] === "string" ? raw["summary"].trim() : undefined;
  const type = raw["type"] === "shutdown_request" || raw["type"] === "abort_request"
    ? raw["type"] : "message";
  return {
    to,
    message,
    ...(summary ? { summary } : {}),
    type,
  };
}

/**
 * Resolve the sender's display name from the tool context.
 *
 * - In-process teammates carry their identity via the
 *   `teammateIdentity` ToolContext field that AgentTool plumbs in
 *   when launching them. We use the `agentName` (NOT agentId) here
 *   so SendMessage replies can re-target the sender by the same
 *   `to` value they'd use for any other teammate — symmetric API.
 * - The lead has no teammateIdentity set; default to TEAM_LEAD_NAME.
 */
function resolveSenderName(context: ToolContext): string {
  const identity = (
    context as ToolContext & { teammateIdentity?: { agentName?: string } }
  ).teammateIdentity;
  return identity?.agentName ?? TEAM_LEAD_NAME;
}

export const sendMessageTool: Tool = {
  name: "SendMessage",
  searchHint: "send messages to agent teammates (swarm protocol)",
  shouldDefer: true,
  description:
    "Send a message or control request to another teammate in the active Agent Teams session. " +
    "A running recipient sees ordinary messages before its next model call. " +
    "Use this for coordination (\"backend, the auth endpoint is at /v2/login\") or for status pings (\"reviewer, ready for you to look at PR draft\"). " +
    "Use `to: \"*\"` to broadcast to every other active teammate. " +
    "If no team is active, this tool errors — call TeamCreate first.",
  inputSchema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description:
          "Recipient teammate name (the `name` you passed to `Agent({ name, ... })`), \"team-lead\" for the lead, or \"*\" to broadcast to every active teammate other than yourself.",
      },
      message: {
        type: "string",
        description:
          "Plain text body. Treated as user-side context by the recipient — write it the same way you'd write instructions to a human collaborator.",
      },
      summary: {
        type: "string",
        description:
          "Optional 5-10 word preview the UI shows alongside the full message. Recommended for messages longer than ~200 chars.",
      },
      type: {
        type: "string",
        enum: ["message", "shutdown_request", "abort_request"],
        description: "Use shutdown_request to stop a teammate after its current tool batch, or abort_request to cancel immediately.",
      },
    },
    required: ["to", "message"],
    additionalProperties: false,
  },

  async call(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    if (context.taskScope === "session" && !context.teammateIdentity) {
      return { content: "Error: ordinary sub-agents are not team members.", isError: true };
    }
    const { to, message, summary, type } = readInput(input);
    if (!to) {
      return {
        content: "Error: 'to' is required (teammate name or '*').",
        isError: true,
      };
    }
    if (!message || !message.trim()) {
      return {
        content: "Error: 'message' is required and must be non-empty.",
        isError: true,
      };
    }

    const active = getActiveTeam();
    if (!active) {
      return {
        content:
          "Error: no team is active. Call TeamCreate first, then spawn teammates with Agent({ name, team_name, ... }).",
        isError: true,
      };
    }

    const teamFile = await readTeamFileAsync(active.teamName);
    if (!teamFile) {
      return {
        content: `Error: team "${active.teamName}" is registered in-process but the team file is missing on disk.`,
        isError: true,
      };
    }

    const senderName = resolveSenderName(context);
    const timestamp = new Date().toISOString();
    const summaryField: Pick<{ summary: string }, "summary"> | object =
      summary ? { summary } : {};

    if (to === "*") {
      if (type !== "message") return { content: "Error: control requests require a single teammate recipient.", isError: true };
      // Broadcast — every active member except the sender.
      const recipients = teamFile.members.filter(
        (m) => m.isActive && m.name !== senderName,
      );
      if (recipients.length === 0) {
        return {
          content:
            "No active teammates to broadcast to (you're the only active member).",
        };
      }
      for (const r of recipients) {
        await writeToMailbox(
          r.name,
          { from: senderName, text: message, timestamp, ...summaryField },
          active.teamName,
        );
      }
      return {
        content: `Broadcast message to ${recipients.length} teammate(s): ${recipients
          .map((r) => r.name)
          .join(", ")}.`,
      };
    }

    // Single-recipient send.
    const recipient = teamFile.members.find((m) => m.name === to);
    if (!recipient) {
      const known = teamFile.members.map((m) => m.name).join(", ");
      return {
        content: `Error: no teammate named "${to}" in team "${active.teamName}". Known members: ${known}.`,
        isError: true,
      };
    }
    if (to === senderName) {
      return {
        content: `Error: cannot SendMessage to yourself ("${to}").`,
        isError: true,
      };
    }

    if (type === "shutdown_request" || type === "abort_request") {
      if (senderName !== TEAM_LEAD_NAME) return { content: "Error: only the team lead can stop a teammate.", isError: true };
      if (!recipient.isActive || !recipient.runId) {
        return { content: `Error: teammate "${to}" is not running in this team.`, isError: true };
      }
      if (getAsyncAgent(recipient.agentId)?.status !== "running") {
        return { content: `Error: teammate "${to}" is no longer running in this process. Recover the team before retrying.`, isError: true };
      }
      const requestId = randomUUID();
      await writeToMailbox(recipient.name, { from: senderName, text: message, timestamp, type, requestId, ...summaryField }, active.teamName);
      const accepted = type === "shutdown_request"
        ? requestShutdownAsyncAgent(recipient.agentId, requestId)
        : killAsyncAgent(recipient.agentId, requestId);
      if (!accepted) {
        await markControlRequestAsRead(recipient.name, active.teamName, requestId);
        return { content: `Error: teammate "${to}" is no longer running in this process. Recover the team before retrying.`, isError: true };
      }
      try {
        await setMemberStatus(active.teamName, recipient.name, recipient.runId, type === "shutdown_request" ? "stopping" : "aborting");
        return { content: `${type} ${requestId} accepted for "${to}".` };
      } catch (error) {
        return { content: `${type} ${requestId} accepted for "${to}", but team status could not be updated: ${error instanceof Error ? error.message : String(error)}` };
      }
    }

    await writeToMailbox(
      recipient.name,
      { from: senderName, text: message, timestamp, type: "message", ...summaryField },
      active.teamName,
    );

    const offlineHint = recipient.isActive
      ? ""
      : ` (note: "${to}" is currently isActive=false — the message will sit in their inbox until they're respawned.)`;
    return {
      content: `Message delivered to "${to}"'s inbox in team "${active.teamName}".${offlineHint}`,
    };
  },

  isReadOnly(): boolean {
    // Writes to a file under ~/.easy-agent/teams/.
    return false;
  },

  isEnabled(): boolean {
    return isAgentTeamsEnabled();
  },

  isConcurrencySafe(): boolean {
    // Two parallel SendMessage calls to different recipients are
    // perfectly safe (each takes a separate per-inbox lock). Two
    // parallel calls to the SAME recipient also work — proper-lockfile
    // serializes them under the hood. So this is concurrency-safe.
    return true;
  },
};
