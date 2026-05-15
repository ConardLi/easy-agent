/**
 * Pending-notification queue for cross-turn message injection (stage 20).
 *
 * Background sub-agents finish at unpredictable times. When the parent's
 * agentic loop is between turns (sitting at the prompt waiting for the
 * user), the only safe time to slip a "your background agent is done"
 * message into the conversation is at the start of the *next* user
 * submission — otherwise we'd race with the API stream.
 *
 * This module provides that queue. The `runAsyncAgentLifecycle` wrapper
 * enqueues a `<task-notification>` block when its sub-agent terminates
 * (success / failure / kill). The QueryEngine's `submitInternal` drains
 * the queue at the very top of each new submission and prepends the
 * notifications as user messages — exactly how source's
 * `enqueuePendingNotification({ mode: 'task-notification' })` plus the
 * `useQueueProcessor` consumer cooperate.
 *
 * Why FIFO and not by-id keyed:
 *   Notifications are pure side-channel messages — once injected they're
 *   gone. We never need to dedupe or update them in-place; we just need
 *   to drain in the order they were enqueued so the model sees them in
 *   completion order.
 *
 * Why no per-session segregation:
 *   Easy Agent currently runs one QueryEngine per process. If we ever
 *   support concurrent sessions in the same process this would need to
 *   be keyed by session id; until then a single global queue is fine.
 */

export interface PendingNotification {
  /** Discriminator for future modes (compaction reminder, plan summary, ...). */
  mode: "task-notification";
  /** Pre-formatted XML/text message body — gets injected as a user message verbatim. */
  text: string;
  /** Enqueue timestamp in ms — kept for debug logs / future ordering tweaks. */
  enqueuedAt: number;
}

const queue: PendingNotification[] = [];

// ─── Signal subscription ─────────────────────────────────────────────
//
// Mirrors source's `messageQueueManager.ts` design: enqueue is a pure
// push + signal pattern, no polling. `useQueueProcessor` (source) /
// `useAgentSession` (here) subscribes to this signal so the moment a
// background sub-agent finishes, the listener fires and — if the main
// loop is idle — triggers a fresh turn that consumes the notification.
// Without this signal, notifications would only be drained on the
// next user submission, leaving the user staring at a finished bar
// pill with no chat reply.
type Listener = () => void;
const listeners = new Set<Listener>();

function notifyListeners(): void {
  for (const l of listeners) l();
}

/** Subscribe to enqueue events. Returns an unsubscribe handle. */
export function subscribePendingNotifications(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Add one notification to the back of the queue. */
export function enqueuePendingNotification(
  notification: Omit<PendingNotification, "enqueuedAt">,
): void {
  queue.push({ ...notification, enqueuedAt: Date.now() });
  notifyListeners();
}

/**
 * Snapshot the current queue without consuming it. Used by tests and by
 * the QueryEngine when it wants to peek (e.g. to decide whether to
 * surface a "you have N pending notifications" hint in the UI).
 */
export function peekPendingNotifications(): readonly PendingNotification[] {
  return queue;
}

/**
 * Atomically take all queued notifications and clear the queue. The
 * caller MUST inject every returned entry into the conversation — there
 * is no way to put them back.
 */
export function drainPendingNotifications(): PendingNotification[] {
  const out = queue.splice(0, queue.length);
  return out;
}

export function pendingNotificationCount(): number {
  return queue.length;
}

/** Drop everything — used by tests and `/clear`. */
export function clearPendingNotifications(): void {
  queue.length = 0;
}

// ─── XML builder for task notifications ─────────────────────────────
//
// The format mirrors source code's `<task-notification>` block (see
// LocalAgentTask.tsx → buildAgentTaskNotificationMessage). We keep the
// same outer tag + key inner tags so anyone reading our docs against
// the source can grok both at a glance.

export interface TaskNotificationParts {
  agentId: string;
  agentType: string;
  status: "completed" | "failed" | "killed";
  description?: string;
  outputFile: string;
  finalText?: string;
  error?: string;
  durationMs?: number;
  totalTokens?: number;
  toolUseCount?: number;
  worktreePath?: string;
  worktreeBranch?: string;
}

export function formatTaskNotification(parts: TaskNotificationParts): string {
  const lines: string[] = ["<task-notification>"];
  lines.push(`  <task_id>${parts.agentId}</task_id>`);
  lines.push(`  <agent_type>${parts.agentType}</agent_type>`);
  lines.push(`  <status>${parts.status}</status>`);
  if (parts.description) {
    lines.push(`  <description>${parts.description}</description>`);
  }
  lines.push(`  <output_file>${parts.outputFile}</output_file>`);
  if (parts.finalText) {
    lines.push("  <result>");
    lines.push(parts.finalText);
    lines.push("  </result>");
  }
  if (parts.error) {
    lines.push(`  <error>${parts.error}</error>`);
  }
  if (
    parts.durationMs !== undefined ||
    parts.totalTokens !== undefined ||
    parts.toolUseCount !== undefined
  ) {
    const usageBits: string[] = [];
    if (parts.totalTokens !== undefined) usageBits.push(`tokens=${parts.totalTokens}`);
    if (parts.toolUseCount !== undefined) usageBits.push(`tools=${parts.toolUseCount}`);
    if (parts.durationMs !== undefined) usageBits.push(`duration_ms=${parts.durationMs}`);
    lines.push(`  <usage>${usageBits.join(" ")}</usage>`);
  }
  if (parts.worktreePath) {
    lines.push(`  <worktree_path>${parts.worktreePath}</worktree_path>`);
    if (parts.worktreeBranch) {
      lines.push(`  <worktree_branch>${parts.worktreeBranch}</worktree_branch>`);
    }
  }
  lines.push("</task-notification>");
  return lines.join("\n");
}
