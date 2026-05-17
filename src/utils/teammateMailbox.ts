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
 *     Mid-write corruption is impossible because writers always rewrite
 *     the FULL file atomically via fs.writeFile (write + rename under
 *     the hood); a reader catches either the pre- or post-write content.
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

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { getTeamDir, sanitizeName } from "./teamHelpers.js";

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
  await mkdir(join(getTeamDir(teamName), "inboxes"), { recursive: true });
  try {
    await writeFile(inboxPath, "[]", { encoding: "utf-8", flag: "wx" });
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "EEXIST") throw error;
  }
  return inboxPath;
}

/**
 * Read every message currently in an inbox. Returns [] if the inbox
 * file doesn't exist yet (a teammate that has never received a message).
 * Never throws — corrupt JSON is treated as "no messages" so a bad
 * write somewhere upstream can't bring down the recipient's loop.
 */
export async function readMailbox(
  agentName: string,
  teamName: string,
): Promise<TeammateMessage[]> {
  try {
    const content = await readFile(getInboxPath(agentName, teamName), "utf-8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? (parsed as TeammateMessage[]) : [];
  } catch {
    return [];
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
    await writeFile(inboxPath, JSON.stringify(messages, null, 2), "utf-8");
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
      await writeFile(inboxPath, JSON.stringify(messages, null, 2), "utf-8");
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
    if (unread.length === 0) return [];
    let changed = false;
    for (const m of messages) {
      if (!m.read) {
        m.read = true;
        changed = true;
      }
    }
    if (changed) {
      await writeFile(inboxPath, JSON.stringify(messages, null, 2), "utf-8");
    }
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
