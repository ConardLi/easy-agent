/**
 * Pure, React-free helpers extracted from useAgentSession (二期 C1).
 *
 * These four members capture no closure state and touch no hooks — they are
 * plain functions + one constant. Moving them out shrinks the hook file and
 * makes them unit-testable in isolation. Behavior is unchanged.
 */

import type { SystemNotice, ToolCallInfo } from "../../types.js";
import type { TokenWarningResult } from "../../../context/autoCompact.js";
import type { LoopTerminationReason } from "../../../core/agenticLoop.js";

export interface ToolCallCompletion {
  resultLength: number;
  isError?: boolean;
  displayName?: string;
  displayHint?: string;
  inputPreview?: string;
  input?: Record<string, unknown>;
  errorMessage?: string;
}

/**
 * Mark a specific tool call card as complete, identified by its unique
 * tool_use id. We must NOT match by `name` alone — when an assistant turn
 * fires several parallel calls of the same tool (e.g. three Reads), a
 * name-based match would either update every pending card with the first
 * result that lands, or silently drop subsequent results.
 */
export function markToolCallComplete(
  toolCalls: ToolCallInfo[],
  id: string,
  completion: ToolCallCompletion,
): ToolCallInfo[] {
  return toolCalls.map((toolCall) =>
    toolCall.id === id ? { ...toolCall, ...completion } : toolCall,
  );
}

/**
 * Split a command message into a header title + body. The first non-empty
 * line becomes the panel title (e.g. "Skills (3 loaded)", "Model status"),
 * and the remaining lines become the body — removing the duplication of
 * rendering the same header both as the panel title and as the first body row.
 */
export function splitHeader(message: string): { title: string; body: string } {
  const lines = message.split("\n");
  const title = (lines.shift() ?? "").trim();
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  return { title, body: lines.join("\n") };
}

export function buildCommandNotice(message: string, kind: "info" | "error"): SystemNotice {
  if (message.startsWith("Commands:")) {
    return {
      tone: "info",
      title: "Available commands",
      body: [
        "/help — Show available commands",
        "/clear — Clear conversation history",
        "/config [list|get|set] — Inspect or change settings (--user/--project/--local)",
        "/cost — Show session token usage",
        "/model [name|default] — Inspect or override the session model",
        "/mode [default|plan|auto] — Inspect or switch permission mode",
        "/tasks [task|todo|reset] — Switch task system or reset the task graph",
        "/mcp — Inspect MCP servers and their tools",
        "/skills — List loaded skills (user + project scope)",
        "/<skill-name> [args] — Run a registered skill as a chat turn",
        "/<command> [args] — Run a user-defined command (~/.easy-agent/commands)",
        "/output-style [name] — Inspect or switch the answer style",
        "/agents — List built-in + custom sub-agent definitions",
        "/history — Show saved sessions for this project",
        "/compact — Compact conversation context",
        "/status — Snapshot of the current session config",
        "/context — Visualize context window usage by category",
        "/doctor — Run an environment health check",
        "/copy [n] — Copy an assistant reply to the clipboard",
        "/export [file] — Export the conversation to Markdown",
        "/resume [n|id] — List and switch to a saved session",
        "/diff [n] — Show uncommitted git changes + recent agent edits",
        "/init — Analyze the repo and draft an AGENT.md (runs a model turn)",
        "/permissions [allow|deny|remove <rule>] — Manage allow/deny rules by layer",
        "/memory [edit <n>] — List/edit AGENT.md + project memory files in $EDITOR",
        "/exit | /quit | /bye — Exit session",
      ].join("\n"),
    };
  }

  if (message.startsWith("Unknown command:") || message.startsWith("Unknown skill:")) {
    const { title, body } = splitHeader(message);
    return { tone: "error", title, body };
  }

  // Errors: keep the full text as the body under a short label unless the
  // message already reads as a header + detail block.
  if (kind === "error") {
    const { title, body } = splitHeader(message);
    return body ? { tone: "error", title, body } : { tone: "error", title: "Error", body: message };
  }

  // Generic info commands (skills / agents / model / task / mcp / output-style
  // / session usage / cleared …): first line is the section header, the rest
  // is the detail body. One rule replaces a dozen hand-written branches.
  const { title, body } = splitHeader(message);
  return { tone: "info", title, body };
}

// Erase visible screen (2J) + the terminal's scrollback buffer (3J) + home the
// cursor (H). Identical to ansi-escapes' `clearTerminal` on POSIX. We write this
// through Ink's `useStdout().write`, which erases the live frame, emits our
// escape, then restores the live frame — so the committed <Static> history
// (banner + old conversation) is wiped from both the screen and the scrollback,
// and never reprints (Static's cursor is already past it). The input prompt is
// re-drawn at the top and new turns append fresh below.
export const CLEAR_TERMINAL = "\u001B[2J\u001B[3J\u001B[H";

// ─── Engine-event → SystemNotice builders ──────────────────────────────────
//
// These translate a single engine event payload into the notice the UI shows.
// They are pure (event in, notice out) — the submit loop keeps the setState
// call so the side effect stays where the React state lives.

/**
 * Notice for a `token_warning` event. Returns null for non-alerting states
 * (the submit loop then leaves the existing notice untouched), matching the
 * original behavior where only warning/error/blocking produced a notice.
 */
export function tokenWarningNotice(warning: TokenWarningResult): SystemNotice | null {
  const pct = Math.round((warning.estimatedTokens / warning.contextWindow) * 100);
  if (warning.state === "warning") {
    return {
      tone: "info",
      title: "Context window filling up",
      body: `${pct}% used (${warning.estimatedTokens} / ${warning.contextWindow} tokens). Consider using /compact.`,
    };
  }
  if (warning.state === "error") {
    return {
      tone: "error",
      title: "Context window nearly full",
      body: `${pct}% used (${warning.estimatedTokens} / ${warning.contextWindow} tokens). Auto-compaction will trigger.`,
    };
  }
  if (warning.state === "blocking") {
    return {
      tone: "error",
      title: "Context window limit reached",
      body: `${pct}% used (${warning.estimatedTokens} / ${warning.contextWindow} tokens). Use /compact to free space.`,
    };
  }
  return null;
}

/**
 * Notice for a `turn_complete` event. Only the two "stopped short" reasons
 * surface a notice; a clean completion / abort returns null.
 */
export function turnCompleteNotice(
  reason: LoopTerminationReason,
  turnCount: number,
): SystemNotice | null {
  if (reason === "max_turns") {
    return {
      tone: "error",
      title: "Maximum tool turns reached",
      body: `Reached maximum tool turns (${turnCount}).`,
    };
  }
  if (reason === "blocking_limit") {
    return {
      tone: "error",
      title: "Context window limit reached",
      body: "Cannot continue — context is full. Use /compact to free space.",
    };
  }
  return null;
}

/** Notice for a `compacted` event, keyed on what triggered the compaction. */
export function compactionNotice(trigger: "auto" | "manual" | "micro"): SystemNotice {
  const title =
    trigger === "micro"
      ? "Context micro-compacted"
      : trigger === "auto"
        ? "Context auto-compacted"
        : "Conversation compacted";
  const body =
    trigger === "micro"
      ? "Old tool results cleared to save context space."
      : "Conversation history has been summarized to free up context window.";
  return { tone: "info", title, body };
}

/** Notice for an `api_retry` event (transient-failure backoff countdown). */
export function apiRetryNotice(retry: {
  delayMs: number;
  message: string;
  attempt: number;
  maxRetries: number;
}): SystemNotice {
  const secs = (retry.delayMs / 1000).toFixed(1);
  return {
    tone: "info",
    title: "Retrying request",
    body: `${retry.message}\nRetrying in ${secs}s… (attempt ${retry.attempt}/${retry.maxRetries}).`,
  };
}

/** Notice for entering/leaving plan mode (engine `onModeChange`). */
export function modeChangeNotice(newMode: string): SystemNotice {
  const title = newMode === "plan" ? "Entered plan mode" : "Exited plan mode";
  const body =
    newMode === "plan"
      ? "Only read-only tools are available. Explore the codebase and write your plan."
      : `Returned to ${newMode} mode. Full tool access restored.`;
  return { tone: "info", title, body };
}
