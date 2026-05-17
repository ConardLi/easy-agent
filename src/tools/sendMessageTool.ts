/**
 * SendMessage — drop a text message into a teammate's inbox.
 *
 * Reference: claude-code-source-code/src/tools/SendMessageTool/SendMessageTool.ts
 *
 * Stage 21 implements only the plain-text path of source's tool:
 *   - `to: "<name>"`  — write to one teammate's inbox
 *   - `to: "*"`       — broadcast to every active teammate (skip self)
 *
 * Skipped vs source:
 *   - Structured messages: shutdown_request / shutdown_response /
 *     plan_approval_response. These require either the in-process
 *     subagent-task layer to wire abort signals back into the running
 *     teammate's loop (source) or a separate shutdown protocol. Stage
 *     21 keeps shutdown handling implicit (`run_in_background` agent
 *     naturally terminates; TeamDelete waits for `isActive=false`).
 *   - UDS / bridge cross-machine routing.
 *   - SendMessage-to-stopped-agent auto-resume (source's
 *     `resumeAgentBackground`). Easy Agent's async sub-agents are not
 *     resumable today (stage 20 §20.3 deferred).
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
import { isAgentTeamsEnabled } from "../utils/agentTeamsEnabled.js";
import { getActiveTeam } from "../state/teamContext.js";
import {
  readTeamFileAsync,
  TEAM_LEAD_NAME,
} from "../utils/teamHelpers.js";
import { writeToMailbox } from "../utils/teammateMailbox.js";

interface SendMessageInput {
  to: string;
  message: string;
  summary?: string;
}

function readInput(raw: Record<string, unknown>): SendMessageInput {
  const to = typeof raw["to"] === "string" ? raw["to"].trim() : "";
  const message = typeof raw["message"] === "string" ? raw["message"] : "";
  const summary =
    typeof raw["summary"] === "string" ? raw["summary"].trim() : undefined;
  return {
    to,
    message,
    ...(summary ? { summary } : {}),
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
  description:
    "Send a plain-text message to another teammate's inbox in the active Agent Teams session. " +
    "The recipient sees the message as a `<teammate-message>` context block at the start of their next loop turn. " +
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
    },
    required: ["to", "message"],
    additionalProperties: false,
  },

  async call(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const { to, message, summary } = readInput(input);
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

    await writeToMailbox(
      recipient.name,
      { from: senderName, text: message, timestamp, ...summaryField },
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
