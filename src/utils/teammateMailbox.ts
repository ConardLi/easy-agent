/**
 * Teammate mailbox — file-locked, JSON-array inbox per team member.
 *
 * Reference: claude-code-source-code/src/utils/teammateMailbox.ts
 *
 * Why file-based and not in-memory:
 *
 *   1. Symmetry. A teammate that runs in the background is reachable from
 *      anywhere — the lead's main loop, another teammate's
 *      `SendMessage`, even a future tmux backend. An on-disk inbox is
 *      the lowest-common-denominator channel that doesn't care which
 *      process or which thread put the message there.
 *   2. Durability across resumes. Source supports `--resume` on
 *      teammates and the inbox file survives the gap. We don't ship
 *      teammate resume in stage 21, but keeping the same on-disk shape
 *      means we don't have to re-architect when we add it.
 *   3. Reusing proper-lockfile we already brought in for taskStore.
 *      Source uses the same library for the same job.
 *
 * On-disk shape: a single JSON file per teammate at
 * `~/.easy-agent/teams/<team>/inboxes/<name>.json`, containing an array
 * of TeammateMessage records. Read = parse, write = lock + append +
 * write. The lock file lives next to the inbox file with a `.lock`
 * suffix (proper-lockfile's default convention).
 *
 * Concurrency contract:
 *   - Multiple writers (e.g. two teammates SendMessage'ing the same
 *     recipient in the same tick) are serialized by the per-file lock.
 *     proper-lockfile retries with backoff for up to ~2.6s; the second
 *     writer waits, then sees the first writer's append and appends
 *     after it.
 *   - Readers are unsynchronized (atomic read of a JSON array file).
 *     Writers replace the full file through the shared durable atomic-write
 *     primitive, so a reader sees either the pre- or post-write document.
 *
 * What we explicitly skip vs source (the source file is 1200 lines):
 *   - Structured protocol messages (shutdown_request / plan_approval /
 *     sandbox_permission_request / team_permission_update). The
 *     teaching version only handles plain text messages.
 *   - Idle / permission-request notification helpers; those rely on
 *     polling layers we don't ship.
 *   - markMessagesAsReadByPredicate / readUnreadMessages /
 *     getLastPeerDmSummary etc. — kept the minimum: read-all,
 *     write-one, mark-all-read.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { getTeamDir, sanitizeName } from "./teamHelpers.js";
import {
  createPrivateFileIfMissing,
  ensurePrivateDirectory,
  writePrivateFile,
} from "./privateData.js";
import {
  parsePersistedJson,
  PersistentDataError,
} from "./atomicFile.js";

/** One inbox entry, persisted as-is inside the JSON-array file. */
export interface TeammateMessage {
  /** Sender's `name` (NOT agentId). Lead messages use `TEAM_LEAD_NAME`. */
  from: string;
  /** Plain text body. */
  text: string;
  /** ISO timestamp set at write time. */
  timestamp: string;
  /** False until the recipient consumes the message; flipped by markMessagesAsRead. */
  read: boolean;
  /** Optional 5-10 word preview shown in any future UI panel. */
  summary?: string;
  type?: "message" | "shutdown_request" | "shutdown_response" | "abort_request";
  requestId?: string;
}

// Per-file lock options — patterned after source's LOCK_OPTIONS in
// teammateMailbox.ts:35. ~2.6s worst-case wait gives concurrent writers
// time to serialize through the lock rather than getting EEXIST'd.
const LOCK_OPTIONS = {
  retries: {
    retries: 30,
    minTimeout: 5,
    maxTimeout: 100,
  },
};

type MailboxListener = (recipientName: string, teamName: string) => void;
const mailboxListeners = new Set<MailboxListener>();
const pendingLeadSignals = new Set<string>();

export function subscribeMailboxWrites(listener: MailboxListener): () => void {
  mailboxListeners.add(listener);
  return () => { mailboxListeners.delete(listener); };
}

export function hasPendingLeadMailboxSignal(teamName: string): boolean {
  return pendingLeadSignals.has(teamName);
}

/** Returns the absolute path to a teammate's inbox file. */
export function getInboxPath(agentName: string, teamName: string): string {
  // Both segments sanitized: agentName lands in a filename; teamName is
  // already a directory segment. Pin the agentName cleanse here too so
  // a malformed `name` (e.g. one passed from the model with a `/`)
  // can't escape the inbox directory.
  const safeName = sanitizeName(agentName);
  return join(getTeamDir(teamName), "inboxes", `${safeName}.json`);
}

/**
 * Make sure the per-team `inboxes/` directory and a specific
 * teammate's inbox file both exist. Returns the inbox file path.
 *
 * Idempotent: the file is opened with `wx` so an existing inbox is
 * left untouched (preserves unread messages across teammate restarts).
 */
async function ensureInboxFile(
  agentName: string,
  teamName: string,
): Promise<string> {
  const inboxPath = getInboxPath(agentName, teamName);
  await ensurePrivateDirectory(join(getTeamDir(teamName), "inboxes"));
  await createPrivateFileIfMissing(inboxPath, "[]");
  return inboxPath;
}

/**
 * Read every message currently in an inbox. Returns [] if the inbox
 * file doesn't exist yet. Invalid data is preserved and reported.
 */
export async function readMailbox(
  agentName: string,
  teamName: string,
): Promise<TeammateMessage[]> {
  const filePath = getInboxPath(agentName, teamName);
  try {
    const content = await readFile(filePath, "utf-8");
    const parsed = parsePersistedJson<unknown>(filePath, content);
    if (!Array.isArray(parsed)) {
      throw new PersistentDataError(filePath, "mailbox must contain a JSON array");
    }
    return parsed as TeammateMessage[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Append one message to a teammate's inbox. Acquires the per-inbox
 * lock for the full read-modify-write sequence so concurrent writers
 * end up with a consistent append-order rather than one stomping the
 * other.
 */
export async function writeToMailbox(
  recipientName: string,
  message: Omit<TeammateMessage, "read">,
  teamName: string,
): Promise<void> {
  const inboxPath = await ensureInboxFile(recipientName, teamName);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(inboxPath, LOCK_OPTIONS);
    const messages = await readMailbox(recipientName, teamName);
    messages.push({ ...message, read: false });
    await writePrivateFile(inboxPath, JSON.stringify(messages, null, 2));
    if (recipientName === "team-lead") pendingLeadSignals.add(teamName);
    for (const listener of mailboxListeners) {
      try { listener(recipientName, teamName); } catch { /* UI listeners cannot fail a send. */ }
    }
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        // Lock release races (e.g. already released by stale lock cleanup)
        // are not user-visible failures.
      }
    }
  }
}

/**
 * Flip every unread message in a teammate's inbox to read. Used at the
 * top of each teammate-loop turn after the messages have been injected
 * into the model's context (so we don't re-inject the same message
 * twice next turn).
 *
 * No-op if the inbox doesn't exist or has nothing unread.
 */
export async function markMessagesAsRead(
  agentName: string,
  teamName: string,
): Promise<void> {
  const inboxPath = getInboxPath(agentName, teamName);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(inboxPath, LOCK_OPTIONS);
    const messages = await readMailbox(agentName, teamName);
    if (messages.length === 0) return;
    let changed = false;
    for (const m of messages) {
      if (!m.read) {
        m.read = true;
        changed = true;
      }
    }
    if (changed) {
      await writePrivateFile(inboxPath, JSON.stringify(messages, null, 2));
    }
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return; // Nothing to mark.
    throw error;
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        // see writeToMailbox.
      }
    }
  }
}

export async function markTerminalControlMessagesAsRead(agentName: string, teamName: string): Promise<void> {
  const inboxPath = getInboxPath(agentName, teamName);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(inboxPath, LOCK_OPTIONS);
    const messages = await readMailbox(agentName, teamName);
    let changed = false;
    for (const message of messages) {
      if (!message.read && (message.type === "shutdown_request" || message.type === "abort_request")) {
        message.read = true;
        changed = true;
      }
    }
    if (changed) await writePrivateFile(inboxPath, JSON.stringify(messages, null, 2));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    if (release) await release().catch(() => {});
  }
}

export async function markControlRequestAsRead(agentName: string, teamName: string, requestId: string): Promise<void> {
  const inboxPath = getInboxPath(agentName, teamName);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(inboxPath, LOCK_OPTIONS);
    const messages = await readMailbox(agentName, teamName);
    let changed = false;
    for (const message of messages) {
      if (message.requestId === requestId && !message.read) {
        message.read = true;
        changed = true;
      }
    }
    if (changed) await writePrivateFile(inboxPath, JSON.stringify(messages, null, 2));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    if (release) await release().catch(() => {});
  }
}

/**
 * Atomically read + clear unread messages in one locked op. Equivalent
 * to `read → markMessagesAsRead` but holds the lock across both steps
 * so a concurrent SendMessage can't slip in an unread record that we'd
 * then silently mark read in the second step.
 *
 * Returns only the messages that were unread at the moment of the call
 * — already-read history is ignored. This is the primitive the
 * runChildAgent loop polls between turns.
 */
export async function drainUnreadMessages(
  agentName: string,
  teamName: string,
): Promise<TeammateMessage[]> {
  const inboxPath = getInboxPath(agentName, teamName);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(inboxPath, LOCK_OPTIONS);
    const messages = await readMailbox(agentName, teamName);
    const unread = messages.filter((m) => !m.read);
    if (unread.length === 0) {
      if (agentName === "team-lead") pendingLeadSignals.delete(teamName);
      return [];
    }
    let changed = false;
    for (const m of messages) {
      if (!m.read) {
        m.read = true;
        changed = true;
      }
    }
    if (changed) {
      await writePrivateFile(inboxPath, JSON.stringify(messages, null, 2));
    }
    if (agentName === "team-lead") pendingLeadSignals.delete(teamName);
    return unread;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return [];
    throw error;
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        // see writeToMailbox.
      }
    }
  }
}

/**
 * Format one or more mailbox messages as a single user-side context
 * block. Mirrors source's `<teammate-message>` shape so a future
 * Markdown / UI renderer can match the same tag, but with one outer
 * wrapper so the model knows "these arrived asynchronously while you
 * were working".
 *
 * Putting all unread messages in a single user message (vs N separate)
 * keeps the conversation history compact when 5+ messages arrive between
 * turns — the model still sees each `from` / `timestamp` distinctly.
 */
export function formatMailboxAttachment(
  messages: TeammateMessage[],
): string {
  if (messages.length === 0) return "";
  const blocks = messages.map((m) => {
    const attrs: string[] = [`from="${m.from}"`, `at="${m.timestamp}"`];
    if (m.summary) attrs.push(`summary="${m.summary}"`);
    if (m.type && m.type !== "message") attrs.push(`type="${m.type}"`);
    if (m.requestId) attrs.push(`request_id="${m.requestId}"`);
    return `<teammate-message ${attrs.join(" ")}>\n${m.text}\n</teammate-message>`;
  });
  return [
    "<teammate-messages>",
    "The following message(s) were sent to you by other team members while you were working.",
    "Read them as authoritative team coordination input — treat them like user instructions.",
    "",
    ...blocks,
    "</teammate-messages>",
  ].join("\n");
}
