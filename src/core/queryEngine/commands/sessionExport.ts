/**
 * Session-export command group — `/copy`, `/export`, `/resume`.
 *
 * Extracted verbatim from queryEngine.ts; behavior is unchanged.
 *   - `/copy [n]`     copy an assistant reply to the system clipboard
 *   - `/export [f]`   write the conversation to a Markdown file
 *   - `/resume [n|id]` swap the live session for a saved one (in-process)
 */

import { writeFile } from "node:fs/promises";
import { resolve as resolvePath, isAbsolute as isAbsolutePath } from "node:path";
import { extractAssistantText } from "../helpers.js";
import { writeTextToClipboard } from "../../../utils/clipboard.js";
import { listProjectSessions, restoreSession } from "../../../session/storage.js";
import type { QueryEngineEvent } from "../types.js";
import type { CommandContext } from "./context.js";

/**
 * `/copy [n]` — copy an assistant reply to the system clipboard. `/copy`
 * copies the most recent reply; `/copy n` copies the n-th most recent
 * (1 = latest). Text-only: image blocks are ignored.
 */
export async function* handleCopyCommand(
  ctx: CommandContext,
  args: string[],
): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
  let n = 1;
  const raw = args[0]?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      yield {
        type: "command",
        kind: "error",
        message: `Invalid index: ${raw}. Usage: /copy [n] where n ≥ 1 (1 = most recent reply).`,
      };
      return { handled: true };
    }
    n = parsed;
  }

  const assistantTexts = ctx
    .getMessages()
    .filter((m) => m.role === "assistant")
    .map((m) => extractAssistantText(m))
    .filter((t) => t.trim().length > 0);

  if (assistantTexts.length === 0) {
    yield {
      type: "command",
      kind: "info",
      message: "Nothing to copy yet — no assistant reply in this conversation.",
    };
    return { handled: true };
  }
  if (n > assistantTexts.length) {
    yield {
      type: "command",
      kind: "error",
      message: `Cannot copy reply #${n}: only ${assistantTexts.length} assistant repl${assistantTexts.length === 1 ? "y" : "ies"} so far.`,
    };
    return { handled: true };
  }

  const text = assistantTexts[assistantTexts.length - n]!;
  const result = await writeTextToClipboard(text);
  if (result.ok) {
    const preview = text.replace(/\s+/g, " ").trim().slice(0, 60);
    yield {
      type: "command",
      kind: "info",
      message:
        `Copied reply #${n} to clipboard (${text.length} chars, via ${result.tool}).\n` +
        `  ${preview}${text.length > 60 ? "…" : ""}`,
    };
  } else {
    yield {
      type: "command",
      kind: "error",
      message: `Could not copy to clipboard: ${result.error}`,
    };
  }
  return { handled: true };
}

/** Serialize the live conversation into readable Markdown. */
function serializeConversationMarkdown(ctx: CommandContext): string {
  const messages = ctx.getMessages();
  const lines: string[] = [];
  lines.push("# Easy Agent session export");
  lines.push("");
  lines.push(`- Session id: ${ctx.sessionId ?? "(none)"}`);
  lines.push(`- Exported: ${new Date().toISOString()}`);
  lines.push(`- Model: ${ctx.getActiveModel()}`);
  lines.push(`- Messages: ${messages.length}`);
  lines.push("");

  for (const msg of messages) {
    const role = msg.role === "user" ? "User" : "Assistant";
    lines.push("", "---", "", `## ${role}`, "");
    const content = msg.content;
    if (typeof content === "string") {
      lines.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as unknown as Record<string, unknown> & { type: string };
      switch (b.type) {
        case "text":
          lines.push(String(b.text ?? ""));
          break;
        case "tool_use":
          lines.push(
            `**Tool call: \`${String(b.name)}\`**`,
            "",
            "```json",
            JSON.stringify(b.input ?? {}, null, 2),
            "```",
          );
          break;
        case "tool_result": {
          const rc = b.content;
          const text =
            typeof rc === "string"
              ? rc
              : Array.isArray(rc)
                ? rc
                    .map((x) => {
                      const xx = x as { type: string; text?: string };
                      return xx.type === "text" ? (xx.text ?? "") : `[${xx.type}]`;
                    })
                    .join("\n")
                : "";
          const capped = text.length > 4000 ? `${text.slice(0, 4000)}\n…(truncated)` : text;
          lines.push(`**Tool result${b.is_error ? " (error)" : ""}:**`, "", "```", capped, "```");
          break;
        }
        case "image":
          lines.push("`[image]`");
          break;
        default:
          break;
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * `/export [filename]` — write the current conversation to a Markdown file.
 * With no filename it falls back to a timestamped default in the cwd. Relative
 * paths resolve against the cwd.
 */
export async function* handleExportCommand(
  ctx: CommandContext,
  args: string[],
): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
  const messages = ctx.getMessages();
  if (messages.length === 0) {
    yield { type: "command", kind: "info", message: "Nothing to export — the conversation is empty." };
    return { handled: true };
  }

  const md = serializeConversationMarkdown(ctx);
  const rawName = args.join(" ").trim();
  const defaultName = `easy-agent-export-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
  const target = rawName || defaultName;
  const outPath = isAbsolutePath(target) ? target : resolvePath(ctx.cwd, target);

  try {
    await writeFile(outPath, md, "utf-8");
  } catch (error) {
    yield {
      type: "command",
      kind: "error",
      message: `Failed to write export: ${error instanceof Error ? error.message : String(error)}`,
    };
    return { handled: true };
  }

  yield {
    type: "command",
    kind: "info",
    message: `Exported ${messages.length} message(s) to:\n  ${outPath}`,
  };
  return { handled: true };
}

/**
 * `/resume [n|id]` (alias `/continue`).
 *   - no arg  → list this project's saved sessions, numbered, for selection
 *   - <n>     → resume the n-th session from the list (1 = most recent)
 *   - <id>    → resume by session id (exact or unique prefix)
 * The switch happens in-process: the engine swaps its message log + usage,
 * and emits `session_switched` so the UI rebinds the session id, file
 * history, and transcript target.
 */
export async function* handleResumeCommand(
  ctx: CommandContext,
  args: string[],
): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
  const cwd = ctx.cwd;
  const sessions = await listProjectSessions(cwd).catch(() => []);
  const arg = args[0]?.trim();

  if (!arg) {
    if (sessions.length === 0) {
      yield { type: "command", kind: "info", message: "No saved sessions for this project yet." };
      return { handled: true };
    }
    // Hand the list to the UI, which renders an interactive picker
    // (↑↓ + Enter) and re-invokes `/resume <id>` on selection instead of a
    // static text dump.
    yield {
      type: "resume_picker",
      sessions: sessions.map((s) => ({
        sessionId: s.sessionId,
        startedAt: s.startedAt,
        updatedAt: s.updatedAt,
        messageCount: s.messageCount,
        model: s.model,
        totalTokens: s.totalUsage.input_tokens + s.totalUsage.output_tokens,
        isCurrent: s.sessionId === ctx.sessionId,
        firstPrompt: s.firstPrompt,
        ...(s.title ? { title: s.title } : {}),
      })),
    };
    return { handled: true };
  }

  let targetId: string | undefined;
  const asIndex = Number(arg);
  if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= sessions.length) {
    targetId = sessions[asIndex - 1]!.sessionId;
  } else {
    const exact = sessions.find((s) => s.sessionId === arg);
    const prefix = sessions.find((s) => s.sessionId.startsWith(arg));
    targetId = exact?.sessionId ?? prefix?.sessionId;
  }

  if (!targetId) {
    yield { type: "command", kind: "error", message: `No session matches "${arg}". Use /resume to list sessions.` };
    return { handled: true };
  }
  if (targetId === ctx.sessionId) {
    yield { type: "command", kind: "info", message: "That session is already active." };
    return { handled: true };
  }

  let restored: Awaited<ReturnType<typeof restoreSession>>;
  try {
    restored = await restoreSession(cwd, targetId);
  } catch (error) {
    yield {
      type: "command",
      kind: "error",
      message: `Failed to restore session: ${error instanceof Error ? error.message : String(error)}`,
    };
    return { handled: true };
  }

  ctx.applyRestoredSession(restored.messages, restored.summary.totalUsage);

  // Note: we deliberately do NOT emit `messages_updated` here. The UI's
  // session_switched handler owns the swap — it must first blank the message
  // list (so Ink's <Static> resets its print cursor) before repainting the
  // restored conversation. A `messages_updated` would set the list early and
  // leave Static's cursor past the end, so nothing repaints after the clear.
  yield {
    type: "session_switched",
    sessionId: targetId,
    messages: [...restored.messages],
    totalUsage: { ...restored.summary.totalUsage },
    fileHistorySnapshots: restored.fileHistorySnapshots,
  };
  // Non-blocking `notice` (not a `command` panel): the switch already cleared
  // the screen and repainted the restored conversation, so this is just a
  // transient confirmation. A `command` panel would hide the input until Esc,
  // which felt like "you can't chat after resuming".
  yield {
    type: "notice",
    tone: "info",
    title: `Switched to session ${targetId.slice(0, 8)}`,
    body: [`${restored.summary.messageCount} message(s) restored`, `Model: ${restored.summary.model}`].join("\n"),
  };
  return { handled: true };
}
