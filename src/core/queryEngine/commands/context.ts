/**
 * CommandContext — the narrow seam between the QueryEngine and its extracted
 * slash-command handlers.
 *
 * Each `/command` handler used to be a private method on QueryEngine, reaching
 * directly into `this.*`. To split them into their own modules without breaking
 * encapsulation (and without exposing the engine's private fields), handlers
 * now receive a `CommandContext`: a minimal, read-/write-through view of just
 * the engine state they actually touch.
 *
 * QueryEngine builds one of these (see `QueryEngine.commandContext()`) and
 * passes it to each handler. The interface grows member-by-member as more
 * command groups are extracted — only add what a handler genuinely needs.
 */

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { Usage } from "../../../types/message.js";
import type { PermissionMode, PermissionSettings, PermissionRuleSet } from "../../../permissions/permissions.js";
import type { ContextBreakdown } from "../contextBreakdown.js";

export interface CommandContext {
  /** Working directory for this session (mirrors toolContext.cwd). */
  readonly cwd: string;
  /** Session id, or undefined when running without persistence. */
  readonly sessionId: string | undefined;
  /** The model the engine was constructed with (before any override). */
  readonly defaultModel: string;

  /** Live conversation messages. Read-only for handlers in this group. */
  getMessages(): MessageParam[];
  /** Cumulative token usage for the session. */
  getTotalUsage(): Usage;
  /** Effective model after session/turn overrides. */
  getActiveModel(): string;
  /** Whether the active model comes from the default or a session override. */
  getModelSource(): "default" | "session";
  /** Current permission mode (default | plan | auto). */
  getPermissionMode(): PermissionMode;
  /** Mode to restore to on plan exit, or null when not in plan mode. */
  getPrePlanMode(): PermissionMode | null;

  /**
   * Swap the live session for a restored one (`/resume`). Encapsulates the
   * engine's private bookkeeping — messages, usage, usage anchor, last-call
   * usage, message id, and the once-per-session SessionStart hook flag — so
   * handlers don't reach into engine internals.
   */
  applyRestoredSession(messages: MessageParam[], totalUsage: Usage): void;

  /**
   * Cached permission settings (mode + persisted allow/deny), or undefined when
   * not yet loaded. The `/permissions` handlers fall back to a fresh load when
   * this is absent.
   */
  getPermissionSettings(): PermissionSettings | undefined;
  /** In-memory, this-run-only allow/deny rules (not persisted). */
  getSessionPermissionRules(): PermissionRuleSet;
  /** Re-read permission settings from disk so the next tool call sees them. */
  reloadPermissionSettings(): Promise<void>;
  /** How the next request would fill the context window. */
  getContextBreakdown(): Promise<ContextBreakdown>;
}
