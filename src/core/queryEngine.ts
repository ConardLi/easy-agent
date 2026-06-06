import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, stat as fsStat, mkdir } from "node:fs/promises";
import {
  resolve as resolvePath,
  isAbsolute as isAbsolutePath,
  join as joinPath,
  dirname as dirnamePath,
} from "node:path";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import {
  query,
  type AgenticLoopEvent,
  type LoopTerminationReason,
} from "./agenticLoop.js";
import {
  loadPermissionSettings,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRequest,
  type PermissionRuleSet,
  type PermissionSettings,
} from "../permissions/permissions.js";
import { buildSystemPrompt, renderSystemPrompt } from "../context/systemPrompt.js";
import { compactMessages } from "../context/compaction.js";
import { autoCompactIfNeeded, calculateTokenWarningState, type TokenWarningResult } from "../context/autoCompact.js";
import {
  tokenCountWithEstimation,
  buildTokenBudgetSnapshot,
  estimateSystemPromptTokens,
  roughTokenCountEstimationForMessages,
  getContextWindowForModel,
} from "../utils/tokens.js";
import { loadAgentMdContext, getAgentMdFiles } from "../context/claudeMd.js";
import {
  readMemoryEntrypoint,
  loadMemoryHeaders,
  getProjectMemoryDir,
  MEMORY_ENTRYPOINT,
} from "../context/memory/memdir.js";
import { getGlobalAgentMdPath } from "../utils/paths.js";
import {
  isPlatformSupported as isSandboxPlatformSupported,
  isSandboxRuntimeReady,
  getSandboxUnavailableReason,
  loadSandboxSettings,
} from "../sandbox/index.js";
import { loadSettingsDiagnostics } from "../utils/settings.js";
import { writeTextToClipboard } from "../utils/clipboard.js";
import { formatProjectSessionHistory } from "../session/history.js";
import {
  listProjectSessions,
  restoreSession,
  type FileHistorySnapshotRecord,
} from "../session/storage.js";
import {
  fileHistoryEnabled,
  fileHistoryGetDiffStats,
  fileHistoryMakeSnapshot,
  fileHistoryRewind,
  getSnapshotByOffset,
  snapshotCount,
} from "../session/fileHistory.js";
import { relative as relativePath } from "node:path";
import { getToolsApiParams, getAllTools } from "../tools/index.js";
import { buildUserMessageContent } from "./attachImages.js";
import type { ToolContext } from "../tools/Tool.js";
import type { Usage } from "../types/message.js";
import type { ModelProfile } from "../services/api/providers/profile.js";
import { getPlanFilePath, planExists as checkPlanExists } from "../context/plans.js";
import { getPlanModeAttachment, getPlanModeExitAttachment } from "../context/planAttachments.js";
import {
  getTaskMode,
  setTaskMode,
  type TaskMode,
} from "../state/taskModeStore.js";
import { getTaskListId, resetTaskList } from "../state/taskStore.js";
import { getMcpRegistry, getMcpRegistryEntry } from "../services/mcp/registry.js";
import { reconnectMcpServer } from "../services/mcp/bootstrap.js";
import {
  findSkill,
  getAllUserInvocableSkills,
} from "../services/skills/registry.js";
import { getAllAgents } from "../agents/registry.js";
import {
  drainPendingNotifications,
  pendingNotificationCount,
} from "../state/notificationStore.js";
import type { Skill } from "../types/types.js";
import { findUserCommand } from "../commands/userCommands/registry.js";
import { substituteArguments } from "../commands/userCommands/argumentSubstitution.js";
import { isBuiltinCommandName } from "../commands/builtinCommandNames.js";
import { tryExpandBuiltinPromptCommand } from "../commands/builtinPromptCommands.js";
import {
  getActiveOutputStyleName,
  getAllOutputStyles,
  resolveOutputStyle,
  setActiveOutputStyle,
} from "../styles/registry.js";
import {
  updateUserSettings,
  updateProjectSettings,
  updateLocalSettings,
} from "../utils/settings.js";
import { loadSettingSources, type SettingSource } from "../config/sources.js";
import type { UserCommand } from "../commands/userCommands/types.js";
import {
  runSessionStartHooks,
  runUserPromptSubmitHooks,
  loadHooksDiagnosticReport,
  HOOK_EVENTS,
  type HookEvent,
  type HooksSettings,
} from "../hooks/index.js";

/**
 * One selectable session in the `/resume` picker. Carries just enough metadata
 * to render a useful row without loading the full transcript.
 */
export interface ResumeSessionInfo {
  sessionId: string;
  startedAt: string;
  updatedAt: string;
  messageCount: number;
  model: string;
  totalTokens: number;
  isCurrent: boolean;
  /** First user prompt — the human-readable label shown in the picker. */
  firstPrompt: string;
}

/** One editable memory target shown in the `/memory` picker. */
export interface MemoryPickerItem {
  /** Human-readable label, e.g. "project AGENT.md" or "memory: <title>". */
  label: string;
  /** Absolute path of the file. */
  path: string;
  /** False when the file doesn't exist yet (created on edit). */
  exists: boolean;
  /** Byte size when it exists, else 0. */
  size: number;
}

/** Where a permission rule lives. "session" rules are in-memory (not editable). */
export type PermissionRuleScope = SettingSource | "session";

/** One allow/deny rule + the layer it came from, for the `/permissions` UI. */
export interface PermissionRuleRow {
  rule: string;
  scope: PermissionRuleScope;
}

/** Structured payload for the interactive `/permissions` manager overlay. */
export interface PermissionsViewData {
  mode: PermissionMode;
  allow: PermissionRuleRow[];
  deny: PermissionRuleRow[];
}

/** A single file's unified-patch body, parsed out of `git diff`. */
export interface DiffFilePatch {
  /** Display path (relative to cwd when possible). */
  path: string;
  /** Porcelain status letters from `git status --short` (e.g. "M", "??"). */
  status: string;
  /** Patch body lines (everything after the `diff --git` header). */
  lines: string[];
}

/** Structured payload for the `/diff` panel — colorized by the UI, not text. */
export interface DiffViewData {
  /** True when the cwd is inside a git work tree. */
  isRepo: boolean;
  /** Working-tree changes vs HEAD, one entry per file. */
  files: DiffFilePatch[];
  /** Aggregate `git diff --shortstat`, or null when nothing changed. */
  gitStat: { files: number; insertions: number; deletions: number } | null;
  /** True when the patch was capped to keep the panel bounded. */
  truncated: boolean;
  /** Number of agent turns summarised in the file-history section. */
  turns: number;
  /** Agent file-history edits over the last `turns` turns. */
  fileHistory:
    | { state: "disabled" }
    | { state: "empty" }
    | {
        state: "changes";
        filesChanged: string[];
        insertions: number;
        deletions: number;
      };
}

export type QueryEngineEvent =
  | AgenticLoopEvent
  | { type: "messages_updated"; messages: MessageParam[] }
  | { type: "compacted"; summary?: string; trigger: "auto" | "manual" | "micro" }
  | { type: "usage_updated"; totalUsage: Usage; turnUsage: Usage; lastCallUsage: Usage }
  | { type: "token_warning"; warning: TokenWarningResult }
  | { type: "command"; message: string; kind: "info" | "error" }
  | { type: "notice"; tone: "info" | "error"; title: string; body: string }
  | { type: "model_changed"; model: string; source: "default" | "session" }
  | { type: "session_cleared" }
  | { type: "mode_changed"; mode: PermissionMode; previousMode: PermissionMode }
  | { type: "task_mode_changed"; mode: TaskMode; previousMode: TaskMode }
  | { type: "resume_picker"; sessions: ResumeSessionInfo[] }
  | { type: "diff_view"; data: DiffViewData }
  | { type: "open_editor"; filePath: string; label: string }
  | { type: "memory_picker"; items: MemoryPickerItem[] }
  | { type: "permissions_view"; data: PermissionsViewData }
  | {
      type: "session_switched";
      sessionId: string;
      messages: MessageParam[];
      totalUsage: Usage;
      fileHistorySnapshots: FileHistorySnapshotRecord[];
    };

export interface QueryEngineOptions {
  model: string;
  toolContext: ToolContext;
  initialMessages?: MessageParam[];
  initialUsage?: Usage;
  permissionMode?: PermissionMode;
  permissionSettings?: PermissionSettings;
  sessionPermissionRules?: PermissionRuleSet;
  onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionDecision>;
}

export interface QueryEngineState {
  messages: MessageParam[];
  totalUsage: Usage;
  model: string;
  modelSource: "default" | "session";
}

function createEmptyUsage(): Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
  };
}

const execFileAsync = promisify(execFile);

/** Flatten an assistant message's content down to its text blocks. */
function extractAssistantText(message: MessageParam): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("\n");
}

/**
 * Split `git diff` output into one entry per file. Each entry keeps the patch
 * body (the lines after the `diff --git` header) so the UI can colorize the
 * `@@`/`+`/`-` lines. Rename/mode-only diffs are preserved as-is.
 */
function parseGitDiff(patch: string): { path: string; lines: string[] }[] {
  const out: { path: string; lines: string[] }[] = [];
  let current: { path: string; lines: string[] } | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current) out.push(current);
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      const path = match ? match[2]! : line.slice("diff --git ".length).trim();
      current = { path, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) out.push(current);
  // Drop a trailing empty line many git versions append.
  for (const file of out) {
    while (file.lines.length > 0 && file.lines[file.lines.length - 1] === "") {
      file.lines.pop();
    }
  }
  return out;
}

/** Map each path from `git status --short` to its 2-char porcelain status. */
function parseGitStatus(status: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of status.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2).trim();
    let rest = line.slice(3);
    // Renames render as "old -> new"; key on the new path git diff reports.
    const arrow = rest.indexOf(" -> ");
    if (arrow >= 0) rest = rest.slice(arrow + 4);
    map.set(rest.trim(), code || "M");
  }
  return map;
}

/** Parse `git diff --shortstat` ("N files changed, A insertions(+), D deletions(-)"). */
function parseShortStat(
  shortstat: string,
): { files: number; insertions: number; deletions: number } | null {
  const text = shortstat.trim();
  if (!text) return null;
  const files = Number(/(\d+) files? changed/.exec(text)?.[1] ?? 0);
  const insertions = Number(/(\d+) insertions?\(\+\)/.exec(text)?.[1] ?? 0);
  const deletions = Number(/(\d+) deletions?\(-\)/.exec(text)?.[1] ?? 0);
  return { files, insertions, deletions };
}

export class QueryEngine {
  private messages: MessageParam[];
  private totalUsage: Usage;
  private readonly defaultModel: string;
  private sessionModelOverride: string | null = null;
  /**
   * Stage 23: one-shot model override for a single turn, set when a user
   * command's frontmatter declares `model:`. Cleared after the turn ends so
   * the next prompt reverts to the session/default model.
   */
  private turnModelOverride: string | null = null;
  private readonly toolContext: ToolContext;
  private currentPermissionMode: PermissionMode;
  private prePlanMode: PermissionMode | null = null;
  // Not readonly: `/config set` can rewrite permission rules / mode and call
  // reloadPermissionSettings() to apply them live (no restart needed).
  private permissionSettings?: PermissionSettings;
  private readonly sessionPermissionRules: PermissionRuleSet;
  private readonly onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionDecision>;
  private abortController: AbortController | null = null;
  private usageAnchorIndex: number = -1;
  private lastCallUsage: Usage = { input_tokens: 0, output_tokens: 0 };
  private modeChangeCallback?: (mode: PermissionMode, previousMode: PermissionMode) => void;
  private needsPlanModeExitAttachment = false;
  /**
   * Stage 22: tracks whether SessionStart hooks have already fired
   * this process. The hook is a once-per-session boot signal — we
   * deliberately do NOT re-fire on /clear, because source treats
   * /clear as a different event type ("source: clear") that we don't
   * teach in this stage.
   */
  private sessionStartHooksFired = false;

  /**
   * Stage 26: the id of the current user turn. File-history snapshots bind to
   * this id (mirrors source's `messageId` on `fileHistoryMakeSnapshot`), and
   * `/rewind` resolves a target snapshot by walking these per-turn ids. The UI
   * layer calls `beginUserTurn()` right before persisting the user prompt so
   * the transcript entry and the snapshot share the same id; the auto-trigger
   * (background-agent) path lazily generates one inside `submitMessage`.
   */
  private currentMessageId: string | null = null;

  constructor(options: QueryEngineOptions) {
    this.messages = [...(options.initialMessages ?? [])];
    this.totalUsage = { ...(options.initialUsage ?? createEmptyUsage()) };
    this.usageAnchorIndex = this.messages.length > 0 ? this.messages.length - 1 : -1;
    this.defaultModel = options.model;
    this.toolContext = options.toolContext;
    this.currentPermissionMode = options.permissionMode ?? "default";
    this.permissionSettings = options.permissionSettings;
    this.sessionPermissionRules = options.sessionPermissionRules ?? { allow: [], deny: [] };
    this.onPermissionRequest = options.onPermissionRequest;
  }

  getPermissionMode(): PermissionMode {
    return this.currentPermissionMode;
  }

  /**
   * Re-read permission settings from disk and apply them to this live session.
   * Called by `/config set` so a permission-rule / mode change takes effect on
   * the next tool call without a restart. We do NOT clobber an explicit
   * in-session `/mode` choice: mode is only adopted from settings when the
   * session is still on the default and not currently in plan mode.
   */
  async reloadPermissionSettings(): Promise<void> {
    const next = await loadPermissionSettings(this.toolContext.cwd);
    this.permissionSettings = next;
    if (this.currentPermissionMode === "default" && this.prePlanMode === null) {
      this.currentPermissionMode = next.mode;
    }
    // Re-snapshot the `disableAllHooks` kill switch so toggling it via
    // `/config set` takes effect this session without a restart.
    const { refreshHookDisableFromSettings } = await import("../hooks/settings.js");
    await refreshHookDisableFromSettings(this.toolContext.cwd).catch(() => {});
  }

  /** Register a callback for when mode changes (used by UI layer). */
  onModeChange(callback: (mode: PermissionMode, previousMode: PermissionMode) => void): void {
    this.modeChangeCallback = callback;
  }

  private setPermissionMode(mode: PermissionMode): void {
    const previous = this.currentPermissionMode;
    if (mode === "plan" && previous !== "plan") {
      this.prePlanMode = previous;
      this.needsPlanModeExitAttachment = false;
    }
    if (mode !== "plan" && previous === "plan" && this.prePlanMode !== null) {
      this.currentPermissionMode = this.prePlanMode;
      this.prePlanMode = null;
      this.needsPlanModeExitAttachment = true;
    } else {
      this.currentPermissionMode = mode;
    }
    if (this.currentPermissionMode !== previous) {
      this.modeChangeCallback?.(this.currentPermissionMode, previous);
    }
  }

  private addSessionAllowRules(rules: string[]): void {
    for (const rule of rules) {
      if (!this.sessionPermissionRules.allow.includes(rule)) {
        this.sessionPermissionRules.allow.push(rule);
      }
    }
  }

  /**
   * Clear conversation history and prepare an "implement this plan" message.
   * Used after ExitPlanMode with the "clear context" option.
   */
  clearContextAndImplement(planContent: string, allowedPrompts?: string[]): string {
    this.messages = [];
    this.invalidateUsageAnchor();
    if (allowedPrompts) {
      this.addSessionAllowRules(allowedPrompts);
    }
    return `Implement the following plan:\n\n${planContent}`;
  }

  getState(): QueryEngineState {
    return {
      messages: [...this.messages],
      totalUsage: { ...this.totalUsage },
      model: this.getActiveModel(),
      modelSource: this.getModelSource(),
    };
  }

  /**
   * Stage 26: open a fresh user turn, generating the id that file-history
   * snapshots for this turn will bind to. Returns the id so the caller can
   * stamp it onto the persisted user-message transcript entry, keeping the
   * transcript and the snapshot in lockstep.
   */
  beginUserTurn(): string {
    this.currentMessageId = randomUUID();
    return this.currentMessageId;
  }

  /** Stage 26: id of the active user turn (null before the first turn). */
  getCurrentMessageId(): string | null {
    return this.currentMessageId;
  }

  interrupt(): boolean {
    if (!this.abortController) {
      return false;
    }
    this.abortController.abort();
    this.abortController = null;
    return true;
  }

  async *submitMessage(
    input: string,
  ): AsyncGenerator<QueryEngineEvent, { handled: boolean; reason?: LoopTerminationReason }> {
    const trimmed = input.trim();
    // Stage 20: empty input is a valid call when there are background-
    // agent notifications waiting — the auto-trigger path in
    // useAgentSession passes "" to mean "drain whatever's in the queue
    // and run a turn". `submitInternal` is already empty-text safe (it
    // skips the user-message append).
    if (!trimmed && pendingNotificationCount() === 0) {
      return { handled: false };
    }

    // Stage 26: the auto-trigger (background-agent reply) path has no
    // user-typed prompt for the UI to stamp via beginUserTurn(), so open
    // the turn here. Normal turns already had beginUserTurn() called by the
    // UI before the prompt was persisted.
    if (!trimmed) {
      this.beginUserTurn();
    }

    if (trimmed.startsWith("/")) {
      // Stage 33: built-in `prompt` command (`/init`). Resolved FIRST so a
      // reserved prompt command always means itself and can never be shadowed
      // by a user command or skill file. Expands into a prompt and runs a
      // normal model turn (the model analyses the repo and writes AGENT.md),
      // using the same visible-marker + hidden-body pattern as skills.
      const promptExpansion = tryExpandBuiltinPromptCommand(trimmed);
      if (promptExpansion) {
        const markerMessage: MessageParam = {
          role: "user",
          content: promptExpansion.markerContent,
        };
        this.messages = [...this.messages, markerMessage];
        yield { type: "messages_updated", messages: [...this.messages] };
        return yield* this.submitInternal(promptExpansion.bodyText);
      }

      // Stage 23: user-defined slash command (`/review [args]`). Resolved
      // BEFORE skills so an explicit user command takes precedence, but we
      // skip reserved built-in names so `/help`, `/output-style`, etc. can
      // never be shadowed by a same-named file on disk. Expands into the
      // same two-message pattern as skills (visible marker + hidden body).
      const userExpansion = this.tryExpandUserCommand(trimmed);
      if (userExpansion) {
        if (userExpansion.model) {
          this.turnModelOverride = userExpansion.model;
        }
        const markerMessage: MessageParam = {
          role: "user",
          content: userExpansion.markerContent,
        };
        this.messages = [...this.messages, markerMessage];
        yield { type: "messages_updated", messages: [...this.messages] };
        return yield* this.submitInternal(userExpansion.bodyText);
      }

      // User-invoked skill: `/skill-name [args]`. Resolve the skill against
      // the registry; if it matches, expand into the source's two-message
      // pattern and submit normally. Falls through to handleCommand() for
      // /help, /mcp, /clear, etc. when no skill matches.
      //
      // Source reference (claude-code-source-code/src/utils/processUserInput
      // /processSlashCommand.tsx ~ line 1237 `getMessagesForPromptSlashCommand`):
      //
      //   const messages = [
      //     createUserMessage({ content: metadata }),                  // visible bubble
      //     createUserMessage({ content: skillBody, isMeta: true }),   // hidden, model-only
      //     ...
      //   ]
      //
      // The metadata message wraps `<command-name>/foo</command-name>` +
      // `<command-message>foo</command-message>` + `<command-args>...</...>`
      // tags. The UI's `UserCommandMessage` extracts those tags and renders
      // a styled "❯ /foo args" command bubble that stays in the transcript
      // forever (unlike a transient SystemNotice). The body message is
      // marked `isMeta: true` so the UI hides it from the human view while
      // the model still receives it as a regular user prompt.
      //
      // We don't have an `isMeta` field on `MessageParam`, so we use a
      // string-prefix sentinel ("[skill_invocation:<name>]\n") for the body
      // and the source's exact XML format for the marker — both matched in
      // ConversationView.
      const skillExpansion = this.tryExpandSkillCommand(trimmed);
      if (skillExpansion) {
        const markerMessage: MessageParam = {
          role: "user",
          content: skillExpansion.markerContent,
        };
        this.messages = [...this.messages, markerMessage];
        yield { type: "messages_updated", messages: [...this.messages] };
        return yield* this.submitInternal(skillExpansion.bodyText);
      }
      return yield* this.handleCommand(trimmed);
    }

    return yield* this.submitInternal(trimmed);
  }

  /**
   * Expand `/skill-name [args]` into the two-message pattern source uses:
   *   - `markerContent` — short XML block consumed by the UI to render a
   *     styled "❯ /skill-name args" command bubble in the transcript.
   *   - `bodyText` — the substituted SKILL.md body that becomes the actual
   *     prompt for the model. Prefixed with `[skill_invocation:<name>]\n`
   *     so the conversation view filters it out (the marker bubble already
   *     tells the user what they ran; rendering the SKILL.md body as a
   *     giant user dump is exactly the UX bug we're fixing).
   *
   * Returns null when the input doesn't match any loaded skill — the caller
   * falls back to the generic /command dispatcher in that case.
   */
  private tryExpandSkillCommand(
    input: string,
  ): { skill: Skill; markerContent: string; bodyText: string } | null {
    const match = input.match(/^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/);
    if (!match) return null;
    const [, name, rawArgs] = match;
    const skill = findSkill(name);
    if (!skill) return null;

    const args = rawArgs?.trim() ?? "";
    const dir = skill.baseDir.split(/[\\/]/).join("/");
    const sessionId = this.toolContext.sessionId ?? "unknown-session";

    // Inject allowed-tools into session-allow rules now (the user just
    // explicitly asked for this skill to run — no need to re-prompt for
    // each tool call inside it). Same effect as the SkillTool's
    // contextModifier when the model invokes a skill.
    if (skill.frontmatter.allowedTools.length > 0) {
      this.addSessionAllowRules(skill.frontmatter.allowedTools);
    }

    const body = skill.body
      .replaceAll("${CLAUDE_SKILL_DIR}", dir)
      .replaceAll("${CLAUDE_SESSION_ID}", sessionId)
      .replaceAll("$ARGUMENTS", args);

    // Match `formatCommandInputTags` from source/utils/messages.ts:577.
    // ConversationView's command-bubble renderer parses these exact tags;
    // changing the format here also requires updating extractCommandTag().
    const markerLines = [
      `<command-message>${skill.name}</command-message>`,
      `<command-name>/${skill.name}</command-name>`,
    ];
    if (args) {
      markerLines.push(`<command-args>${args}</command-args>`);
    }
    const markerContent = markerLines.join("\n");

    const header =
      `[skill_invocation:${skill.name}]\n` +
      `Run skill "${skill.name}" with the following instructions. ` +
      `Base directory for this skill: ${dir}.\n\n`;
    return { skill, markerContent, bodyText: header + body };
  }

  /**
   * Stage 23: expand `/command-name [args]` into the same two-message
   * pattern as skills. The visible marker renders a "❯ /command args"
   * bubble; the hidden body (prefixed `[command_invocation:<name>]`) carries
   * the substituted prompt template to the model.
   *
   * Returns null when:
   *   - the input doesn't look like a slash command, OR
   *   - the name is a reserved built-in (so `/help` etc. reach handleCommand), OR
   *   - no user command with that name is loaded.
   */
  private tryExpandUserCommand(
    input: string,
  ): { command: UserCommand; markerContent: string; bodyText: string; model?: string } | null {
    // Command names may contain `:` (namespace) in addition to skill chars.
    const match = input.match(/^\/([a-zA-Z0-9_:-]+)(?:\s+(.*))?$/);
    if (!match) return null;
    const [, name, rawArgs] = match;
    if (isBuiltinCommandName(name)) return null;

    const command = findUserCommand(name);
    if (!command) return null;

    const args = rawArgs?.trim() ?? "";

    // Honour the command's allowed-tools whitelist by pre-authorizing those
    // tools for this session (same as skills) — the user explicitly invoked
    // the command, so we don't re-prompt for each internal tool call.
    if (command.allowedTools.length > 0) {
      this.addSessionAllowRules(command.allowedTools);
    }

    const body = substituteArguments(command.body, args);

    const markerLines = [
      `<command-message>${command.name}</command-message>`,
      `<command-name>/${command.name}</command-name>`,
    ];
    if (args) {
      markerLines.push(`<command-args>${args}</command-args>`);
    }
    const markerContent = markerLines.join("\n");

    const bodyText = `[command_invocation:${command.name}]\n${body}`;
    return { command, markerContent, bodyText, model: command.model };
  }

  /**
   * The original `submitMessage` body, factored out so user-invoked skills
   * can re-enter it with their expanded prompt text. Everything below this
   * point is identical to the pre-skills implementation.
   */
  private async *submitInternal(
    trimmed: string,
  ): AsyncGenerator<QueryEngineEvent, { handled: boolean; reason?: LoopTerminationReason }> {

    // ─── Stage 26: open the file-history snapshot for this turn ─────
    // Fire at turn start (before any edit) so the snapshot bound to this
    // turn's id captures the filesystem state *before* the model's edits;
    // fileHistoryTrackEdit (in the loop) then attaches pre-edit backups to
    // it, and `/rewind` to this id undoes the whole turn. Best-effort: a
    // null id (shouldn't happen — beginUserTurn runs first) is backfilled.
    if (!this.currentMessageId) this.beginUserTurn();
    await fileHistoryMakeSnapshot(this.currentMessageId!);

    // ─── Stage 22: SessionStart hook (one-shot per process) ─────────
    // Source fires SessionStart from the bootstrap path; we delay
    // until the user's first submit so the hook can't block CLI
    // startup if it's slow / broken. The hook's additionalContext
    // gets prepended to the conversation as a hidden "[session-start]"
    // user message — the model sees it before the actual user prompt.
    if (!this.sessionStartHooksFired) {
      this.sessionStartHooksFired = true;
      const startOutcome = await runSessionStartHooks({
        source: this.messages.length === 0 ? "startup" : "resume",
        cwd: this.toolContext.cwd,
      });
      const startCtx = startOutcome.additionalContext;
      if (startCtx) {
        const startMessage: MessageParam = {
          role: "user",
          content: `[session-start]\n${startCtx}`,
        };
        this.messages = [...this.messages, startMessage];
        yield { type: "messages_updated", messages: [...this.messages] };
      }
      if (startOutcome.systemMessage) {
        yield {
          type: "command",
          kind: "info",
          message: `[SessionStart hook] ${startOutcome.systemMessage}`,
        };
      }
    }

    // ─── Stage 22: UserPromptSubmit hook ───────────────────────────
    // Source fires UserPromptSubmit RIGHT BEFORE the prompt becomes
    // a user message. The hook can:
    //   - inject additionalContext (prepended to the user's prompt)
    //   - block the prompt outright (decision: "block" / exit 2)
    // We honor both. Skipping when `trimmed` is empty because empty
    // calls are the background-notification drain path — there's no
    // user prompt to feed the hook.
    let promptToSubmit = trimmed;
    if (trimmed.length > 0) {
      const userOutcome = await runUserPromptSubmitHooks({
        prompt: trimmed,
        cwd: this.toolContext.cwd,
      });
      if (userOutcome.blockingError) {
        yield {
          type: "command",
          kind: "error",
          message: `[UserPromptSubmit hook blocked] ${userOutcome.blockingError}`,
        };
        return { handled: true };
      }
      if (userOutcome.additionalContext) {
        promptToSubmit = `[user-context]\n${userOutcome.additionalContext}\n\n${trimmed}`;
      }
      if (userOutcome.systemMessage) {
        yield {
          type: "command",
          kind: "info",
          message: `[UserPromptSubmit hook] ${userOutcome.systemMessage}`,
        };
      }
    }

    const previewSystemParts = await buildSystemPrompt({
      cwd: this.toolContext.cwd,
      userQuery: promptToSubmit,
    });
    const previewSystemPrompt = renderSystemPrompt(previewSystemParts);

    // Only run compaction when there's meaningful conversation history
    if (this.messages.length > 0) {
      // Micro-compact old tool results first
      const microResult = await compactMessages(this.messages, undefined, {
        usage: this.lastCallUsage,
        usageAnchorIndex: this.usageAnchorIndex,
        systemPrompt: previewSystemPrompt,
        model: this.getActiveModel(),
      });
      if (microResult.didMicroCompact || microResult.didCompact) {
        this.messages = [...microResult.messages];
        this.invalidateUsageAnchor();
        yield { type: "messages_updated", messages: [...this.messages] };
        yield {
          type: "compacted",
          summary: microResult.summary,
          trigger: microResult.didCompact ? "auto" : "micro",
        };
      }

      // Auto-compact with circuit breaker if still over threshold
      const { result: autoResult, didAutoCompact } = await autoCompactIfNeeded(
        this.messages,
        this.getActiveModel(),
        {
          usage: this.lastCallUsage,
          usageAnchorIndex: this.usageAnchorIndex,
          systemPrompt: previewSystemPrompt,
        },
      );
      if (didAutoCompact) {
        this.messages = [...autoResult.messages];
        this.invalidateUsageAnchor();
        yield { type: "messages_updated", messages: [...this.messages] };
        yield { type: "compacted", summary: autoResult.summary, trigger: "auto" };
      }

      // Emit token warning if approaching limits
      const estimatedTokens = tokenCountWithEstimation(this.messages, {
        usage: this.lastCallUsage,
        usageAnchorIndex: this.usageAnchorIndex,
        systemPrompt: previewSystemPrompt,
      });
      const warningState = calculateTokenWarningState(estimatedTokens, this.getActiveModel());
      if (warningState.state !== "normal") {
        yield { type: "token_warning", warning: warningState };
      }
    }

    // Inject plan mode attachments as user messages (before user input)
    if (this.currentPermissionMode === "plan") {
      const planAttachment = getPlanModeAttachment(this.messages, getPlanFilePath());
      if (planAttachment) {
        this.messages = [...this.messages, planAttachment];
      }
    } else if (this.needsPlanModeExitAttachment) {
      this.needsPlanModeExitAttachment = false;
      const exists = await checkPlanExists();
      const exitAttachment = getPlanModeExitAttachment(getPlanFilePath(), exists);
      this.messages = [...this.messages, exitAttachment];
    }

    // Stage 20: drain any pending background-agent notifications BEFORE
    // the user message. The model will see them as system-side user
    // messages tagged `[task-notification]` so it can react ("oh the
    // background reviewer finished — let me look at its output") before
    // tackling the actual user prompt.
    //
    // Source reference: claude-code-source-code/src/utils/queueProcessor.ts
    //   `processQueueIfReady` drains task-notification entries between
    //   turns and calls `enqueueUserOrSystemMessage` to inject them.
    const pendingNotifs = drainPendingNotifications();
    for (const notif of pendingNotifs) {
      const notifMessage: MessageParam = {
        role: "user",
        content: `[task-notification]\n${notif.text}`,
      };
      this.messages = [...this.messages, notifMessage];
    }
    if (pendingNotifs.length > 0) {
      yield { type: "messages_updated", messages: [...this.messages] };
    }

    // Stage 20: when this turn was triggered by a background-agent
    // notification (no real user input), skip appending an empty user
    // message — the notification(s) we just drained ARE the user-side
    // input for the model. The Anthropic API also rejects empty
    // user-content blocks, so this guard is correctness, not just hygiene.
    if (promptToSubmit.length > 0) {
      // Attach any `@image.png` references as real image blocks so the model
      // can see them. Falls back to a plain string when there are none.
      const built = await buildUserMessageContent(promptToSubmit, this.toolContext.cwd);
      // Image feedback is transient and must NOT seize the screen: emit it as a
      // non-blocking notice (vs. a `command` panel, which pins above the input
      // and hides it until Esc).
      for (const err of built.errors) {
        yield { type: "notice", tone: "error", title: "Image", body: err };
      }
      if (built.attached.length > 0) {
        const names = built.attached.map((a) => a.ref).join(", ");
        yield { type: "notice", tone: "info", title: "Image attached", body: names };
      }
      const userMessage: MessageParam = {
        role: "user",
        content: built.content as MessageParam["content"],
      };
      this.messages = [...this.messages, userMessage];
      yield { type: "messages_updated", messages: [...this.messages] };
    }

    const abortController = new AbortController();
    this.abortController = abortController;

    try {
      const systemParts = previewSystemParts;
      const systemPrompt = renderSystemPrompt(systemParts);
      const enrichedToolContext: ToolContext = {
        ...this.toolContext,
        abortSignal: abortController.signal,
        setPermissionMode: (mode: string) => this.setPermissionMode(mode as PermissionMode),
        getPermissionMode: () => this.currentPermissionMode,
        addSessionAllowRules: (rules: string[]) => this.addSessionAllowRules(rules),
        // Sub-agent spawning support (stage 19): expose the parent's
        // permission infrastructure + active model so the AgentTool can
        // hand them to runChildAgent. Tools other than Agent ignore
        // these fields.
        permissionSettings: this.permissionSettings,
        sessionPermissionRules: this.sessionPermissionRules,
        onPermissionRequest: this.onPermissionRequest,
        defaultModel: this.getActiveModel(),
        // Stage 26: the active turn id, so the loop can back up files
        // (fileHistoryTrackEdit) before Edit/Write run.
        messageId: this.currentMessageId ?? undefined,
      };

      const loop = query({
        messages: [...this.messages],
        systemPrompt,
        getTools: () => getToolsApiParams(this.currentPermissionMode),
        model: this.getActiveModel(),
        abortSignal: abortController.signal,
        toolContext: enrichedToolContext,
        permissionMode: this.currentPermissionMode,
        permissionSettings: this.permissionSettings,
        sessionPermissionRules: this.sessionPermissionRules,
        onPermissionRequest: this.onPermissionRequest,
      });

      while (true) {
        const { value, done } = await loop.next();
        if (done) {
          this.messages = [...value.state.messages];
          this.totalUsage = {
            input_tokens: this.totalUsage.input_tokens + value.usage.input_tokens,
            output_tokens: this.totalUsage.output_tokens + value.usage.output_tokens,
            cache_creation_input_tokens:
              (this.totalUsage.cache_creation_input_tokens ?? 0) + (value.usage.cache_creation_input_tokens ?? 0),
            cache_read_input_tokens:
              (this.totalUsage.cache_read_input_tokens ?? 0) + (value.usage.cache_read_input_tokens ?? 0),
          };
          this.lastCallUsage = { ...value.lastCallUsage };
          this.usageAnchorIndex = this.messages.length > 0 ? this.messages.length - 1 : -1;
          yield { type: "messages_updated", messages: [...this.messages] };
          yield {
            type: "usage_updated",
            totalUsage: { ...this.totalUsage },
            turnUsage: { ...value.usage },
            lastCallUsage: { ...this.lastCallUsage },
          };
          return { handled: true, reason: value.reason };
        }

        yield value;

        switch (value.type) {
          case "assistant_message":
          case "tool_result_message":
            this.messages = [...this.messages, value.message];
            yield { type: "messages_updated", messages: [...this.messages] };
            break;
          default:
            break;
        }
      }
    } finally {
      this.abortController = null;
      // Stage 23: drop any per-turn model override so the next prompt
      // reverts to the session/default model.
      this.turnModelOverride = null;
    }
  }

  private invalidateUsageAnchor(): void {
    this.usageAnchorIndex = -1;
    this.lastCallUsage = { input_tokens: 0, output_tokens: 0 };
  }

  private getActiveModel(): string {
    return this.turnModelOverride ?? this.sessionModelOverride ?? this.defaultModel;
  }

  private getModelSource(): "default" | "session" {
    return this.sessionModelOverride ? "session" : "default";
  }

  private async *handleCommand(command: string): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
    const [name, ...args] = command.slice(1).split(/\s+/).filter(Boolean);

    switch (name) {
      case "help":
        yield {
          type: "command",
          kind: "info",
          message: "Commands: /help /clear /config [list|get|set] /cost /model [name|list|default] /mode [default|plan|auto] /tasks [task|todo|reset] /mcp [tools <name>|reconnect <name>] /skills /agents /hooks /output-style [name] /history /compact /rewind [n] /status /context /doctor /copy [n] /export [file] /resume [n|id] /diff [n] /init /permissions [allow|deny|remove <rule>] /memory [edit <n>] /<skill-or-command> [args] /exit /quit /bye",
        };
        return { handled: true };
      case "config":
        return yield* this.handleConfigCommand(args);
      case "mcp":
        return yield* this.handleMcpCommand(args);
      case "output-style":
      case "output_style":
        return yield* this.handleOutputStyleCommand(args);
      case "skills":
        return yield* this.handleSkillsCommand();
      case "agents":
        return yield* this.handleAgentsCommand();
      case "hooks":
      case "hook":
        return yield* this.handleHooksCommand();
      case "mode": {
        const nextMode = args[0]?.trim();
        if (!nextMode) {
          yield {
            type: "command",
            kind: "info",
            message: `Current mode: ${this.currentPermissionMode}` +
              (this.prePlanMode ? ` (will restore to ${this.prePlanMode} on plan exit)` : ""),
          };
          return { handled: true };
        }
        if (nextMode !== "default" && nextMode !== "plan" && nextMode !== "auto") {
          yield { type: "command", kind: "error", message: `Invalid mode: ${nextMode}. Must be default, plan, or auto.` };
          return { handled: true };
        }
        const previous = this.currentPermissionMode;
        this.setPermissionMode(nextMode as PermissionMode);
        yield { type: "mode_changed", mode: this.currentPermissionMode, previousMode: previous };
        yield {
          type: "command",
          kind: "info",
          message: `Mode changed: ${previous} → ${this.currentPermissionMode}`,
        };
        return { handled: true };
      }
      case "tasks": {
        const arg = args[0]?.trim();
        const current = getTaskMode();
        if (!arg) {
          yield {
            type: "command",
            kind: "info",
            message: [
              "Task system status",
              `- Active: ${current} (${current === "task" ? "persistent graph (Task V2)" : "session memory (TodoWrite V1)"})`,
              "- Usage: /tasks task      Use persistent Task V2 tools (default)",
              "- Usage: /tasks todo      Use in-memory TodoWrite V1",
              "- Usage: /tasks reset     Delete every task in the current task list",
            ].join("\n"),
          };
          return { handled: true };
        }
        if (arg === "reset") {
          const taskListId = getTaskListId(this.toolContext.sessionId ?? "default");
          try {
            await resetTaskList(taskListId);
            yield { type: "command", kind: "info", message: `Task list '${taskListId}' has been reset.` };
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            yield { type: "command", kind: "error", message: `Failed to reset task list: ${msg}` };
          }
          return { handled: true };
        }
        if (arg !== "task" && arg !== "todo") {
          yield {
            type: "command",
            kind: "error",
            message: `Invalid task mode: ${arg}. Must be task, todo, or reset.`,
          };
          return { handled: true };
        }
        if (arg === current) {
          yield {
            type: "command",
            kind: "info",
            message: `Task system is already '${current}'.`,
          };
          return { handled: true };
        }
        setTaskMode(arg);
        yield { type: "task_mode_changed", mode: arg, previousMode: current };
        yield {
          type: "command",
          kind: "info",
          message: `Task system changed: ${current} → ${arg}.`,
        };
        return { handled: true };
      }
      case "clear":
        this.messages = [];
        yield { type: "session_cleared" };
        yield { type: "messages_updated", messages: [] };
        yield { type: "command", kind: "info", message: "Conversation cleared." };
        return { handled: true };
      case "cost":
        yield {
          type: "command",
          kind: "info",
          message: `Session usage\n- Input tokens: ${this.totalUsage.input_tokens}\n- Output tokens: ${this.totalUsage.output_tokens}\n- Total tokens: ${this.totalUsage.input_tokens + this.totalUsage.output_tokens}`,
        };
        return { handled: true };
      case "model": {
        const nextModel = args.join(" ").trim();
        const { loadProfiles } = await import("../services/api/providers/profile.js");

        const emptyProfiles: Record<string, ModelProfile> = {};

        if (!nextModel) {
          const { profiles } = await loadProfiles(this.toolContext.cwd).catch(() => ({ profiles: emptyProfiles }));
          const ids = Object.keys(profiles);
          yield {
            type: "command",
            kind: "info",
            message: [
              "Model status",
              `- Active model: ${this.getActiveModel()}`,
              `- Source: ${this.getModelSource()}`,
              `- Default model: ${this.defaultModel}`,
              this.sessionModelOverride ? `- Session override: ${this.sessionModelOverride}` : "- Session override: none",
              ids.length ? `- Declared profiles: ${ids.join(", ")}` : "- Declared profiles: none (set them in settings.json `models`)",
              "- Usage: /model <name|profile> to override for this session",
              "- Usage: /model list to see profiles, /model default to clear the override",
            ].join("\n"),
          };
          return { handled: true };
        }

        if (nextModel === "list") {
          const { profiles, defaultModel, warnings } = await loadProfiles(this.toolContext.cwd).catch(
            () => ({ profiles: emptyProfiles, defaultModel: undefined as string | undefined, warnings: [] as string[] }),
          );
          const ids = Object.keys(profiles);
          const lines: string[] = ["Model profiles"];
          if (ids.length === 0) {
            lines.push("  (none declared — add a `models` block to settings.json)");
          } else {
            for (const id of ids) {
              const p = profiles[id]!;
              const marker = id === this.getActiveModel() ? " (active)" : defaultModel === id ? " (default)" : "";
              lines.push(`  ${id}${marker} · ${p.protocol} · ${p.model}${p.baseURL ? ` · ${p.baseURL}` : ""}`);
            }
          }
          for (const w of warnings) lines.push(`  ⚠ ${w}`);
          lines.push("", "Switch with /model <id>; clear with /model default.");
          yield { type: "command", kind: "info", message: lines.join("\n") };
          return { handled: true };
        }

        if (nextModel === "default") {
          this.sessionModelOverride = null;
          const activeModel = this.getActiveModel();
          yield { type: "model_changed", model: activeModel, source: "default" };
          yield {
            type: "command",
            kind: "info",
            message: [
              "Model updated",
              `- Active model: ${activeModel}`,
              "- Source: default",
              "- Session override cleared",
            ].join("\n"),
          };
          return { handled: true };
        }

        // Annotate the switch with the resolved protocol when it matches a
        // declared profile (helps the user confirm they hit the right one).
        const { profiles } = await loadProfiles(this.toolContext.cwd).catch(() => ({ profiles: emptyProfiles }));
        const matched = profiles[nextModel];
        this.sessionModelOverride = nextModel;
        yield { type: "model_changed", model: nextModel, source: "session" };
        yield {
          type: "command",
          kind: "info",
          message: [
            "Model updated",
            `- Active model: ${nextModel}`,
            matched ? `- Protocol: ${matched.protocol} · upstream model: ${matched.model}` : "- Protocol: anthropic (raw model name)",
            "- Source: session",
            `- Default model remains: ${this.defaultModel}`,
          ].join("\n"),
        };
        return { handled: true };
      }
      case "history":
        yield {
          type: "command",
          kind: "info",
          message: await formatProjectSessionHistory(this.toolContext.cwd),
        };
        return { handled: true };
      case "compact": {
        const focus = args.join(" ").trim();
        const manualSystemParts = await buildSystemPrompt({ cwd: this.toolContext.cwd });
        const manualSystemPrompt = renderSystemPrompt(manualSystemParts);
        const result = await compactMessages(this.messages, focus || undefined, { usage: this.lastCallUsage, usageAnchorIndex: this.usageAnchorIndex, systemPrompt: manualSystemPrompt, model: this.getActiveModel(), force: true });
        this.messages = [...result.messages];
        if (result.didCompact || result.didMicroCompact) {
          this.invalidateUsageAnchor();
        }
        yield { type: "messages_updated", messages: [...this.messages] };
        if (result.didCompact || result.didMicroCompact) {
          yield { type: "compacted", summary: result.summary, trigger: focus ? "manual" : result.didCompact ? "manual" : "micro" };
        } else {
          yield { type: "command", kind: "info", message: "Conversation did not need compaction." };
        }
        return { handled: true };
      }
      case "rewind":
      case "checkpoint":
        return yield* this.handleRewindCommand(args);
      case "status":
        return yield* this.handleStatusCommand();
      case "context":
        return yield* this.handleContextCommand();
      case "doctor":
        return yield* this.handleDoctorCommand();
      case "copy":
        return yield* this.handleCopyCommand(args);
      case "export":
        return yield* this.handleExportCommand(args);
      case "resume":
      case "continue":
        return yield* this.handleResumeCommand(args);
      case "diff":
        return yield* this.handleDiffCommand(args);
      case "permissions":
      case "allowed-tools":
      case "allowed_tools":
        return yield* this.handlePermissionsCommand(args);
      case "memory":
        return yield* this.handleMemoryCommand(args);
      default:
        yield {
          type: "command",
          kind: "error",
          message: `Unknown command: /${name}. Try /help.`,
        };
        return { handled: true };
    }
  }

  /**
   * Stage 25: `/config [list|get|set]`.
   *   - list                              → every effective top-level setting
   *                                          with the source that supplied it
   *   - get <key>                         → one setting's effective value + source
   *   - set <key> <value> [--user|--project|--local]
   *                                       → write to the chosen scope (default
   *                                          --user), then hot-reload permission
   *                                          settings so changes apply live.
   *
   * Values are parsed as JSON when possible (so `["Read"]`, `true`, `42` work),
   * otherwise treated as a literal string. `mode` is treated as a sensitive key:
   * it is never honored from project/local files, and `list`/`get` reflect that.
   */
  /**
   * Stage 26: `/rewind [n]` (alias `/checkpoint`). Restores tracked files to
   * the state at the start of the n-th-from-last user turn (default 1 = undo
   * the most recent turn's edits). Shows the affected file list + diff stats,
   * then applies the rewind. Only files are rewound; the conversation is left
   * intact.
   */
  private async *handleRewindCommand(
    args: string[],
  ): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
    if (!fileHistoryEnabled()) {
      yield {
        type: "command",
        kind: "info",
        message: "File history is disabled (checkpointingEnabled: false). Nothing to rewind.",
      };
      return { handled: true };
    }

    const total = snapshotCount();
    if (total === 0) {
      yield {
        type: "command",
        kind: "info",
        message: "No file-history snapshots yet — make an edit first.",
      };
      return { handled: true };
    }

    // Parse the step count (how many turns to go back). Default 1.
    let steps = 1;
    const rawArg = args[0]?.trim();
    if (rawArg) {
      const parsed = Number(rawArg);
      if (!Number.isInteger(parsed) || parsed < 1) {
        yield {
          type: "command",
          kind: "error",
          message: `Invalid step count: ${rawArg}. Usage: /rewind [n] where n ≥ 1.`,
        };
        return { handled: true };
      }
      steps = parsed;
    }

    const target = getSnapshotByOffset(steps);
    if (!target) {
      yield {
        type: "command",
        kind: "error",
        message: `Cannot rewind ${steps} step(s): only ${total} snapshot(s) available.`,
      };
      return { handled: true };
    }

    const cwd = this.toolContext.cwd;
    const rel = (p: string): string => {
      const r = relativePath(cwd, p);
      return r && !r.startsWith("..") ? r : p;
    };

    // Preview the changes the rewind would make.
    const stats = await fileHistoryGetDiffStats(target.messageId);

    let changed: string[];
    try {
      changed = await fileHistoryRewind(target.messageId);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      yield { type: "command", kind: "error", message: `Rewind failed: ${msg}` };
      return { handled: true };
    }

    if (changed.length === 0) {
      yield {
        type: "command",
        kind: "info",
        message: `Already at that state — no files changed (rewound ${steps} turn(s)).`,
      };
      return { handled: true };
    }

    const lines = [
      `Rewound ${steps} turn(s). Restored ${changed.length} file(s) (+${stats.insertions} -${stats.deletions}):`,
      ...changed.map((p) => `  ${rel(p)}`),
    ];
    yield { type: "command", kind: "info", message: lines.join("\n") };
    return { handled: true };
  }

  /**
   * Stage 33: `/status` — a read-only snapshot of the live session config:
   * cwd, session id, active model + source, permission/task mode, output
   * style, message count, session token usage, enabled tools, and MCP server
   * status. Never touches the model.
   */
  private async *handleStatusCommand(): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
    const tools = getAllTools();
    const toolNames = tools.map((t) => t.name);
    const mcp = getMcpRegistry();
    const connectedMcp = mcp.filter((e) => e.connection.type === "connected");

    const lines = [
      "Status",
      "",
      `- cwd: ${this.toolContext.cwd}`,
      `- Session id: ${this.toolContext.sessionId ?? "(none)"}`,
      `- Model: ${this.getActiveModel()} (source: ${this.getModelSource()}; default: ${this.defaultModel})`,
      `- Permission mode: ${this.currentPermissionMode}` +
        (this.prePlanMode ? ` (restores to ${this.prePlanMode} on plan exit)` : ""),
      `- Task system: ${getTaskMode()}`,
      `- Output style: ${getActiveOutputStyleName()}`,
      `- Messages in context: ${this.messages.length}`,
      `- Session tokens: in ${this.totalUsage.input_tokens} / out ${this.totalUsage.output_tokens}`,
      `- Tools enabled (${tools.length}): ${toolNames.join(", ")}`,
      mcp.length === 0
        ? "- MCP servers: none configured"
        : `- MCP servers: ${connectedMcp.length}/${mcp.length} connected`,
    ];
    yield { type: "command", kind: "info", message: lines.join("\n") };
    return { handled: true };
  }

  /**
   * Stage 33: `/context` — visualize how the context window is currently
   * split across System prompt / AGENT.md + memory / Tool definitions /
   * Conversation history / Free space, each as a proportional bar. Estimates
   * reuse the same token heuristics the auto-compactor relies on.
   */
  private async *handleContextCommand(): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
    const cwd = this.toolContext.cwd;
    const model = this.getActiveModel();

    const systemParts = await buildSystemPrompt({ cwd });
    const systemPrompt = renderSystemPrompt(systemParts);
    const toolsJson = JSON.stringify(getToolsApiParams(this.currentPermissionMode));
    const [agentMd, memoryEntry] = await Promise.all([
      loadAgentMdContext(cwd).catch(() => null),
      readMemoryEntrypoint(cwd).catch(() => null),
    ]);

    const roughText = (s: string): number => Math.max(0, Math.round(s.length / 4));
    const roughJson = (s: string): number => Math.max(0, Math.round(s.length / 2));

    const memoryTokens = roughText(`${agentMd ?? ""}\n${memoryEntry ?? ""}`);
    const systemTotalTokens = estimateSystemPromptTokens(systemPrompt);
    const systemCoreTokens = Math.max(0, systemTotalTokens - memoryTokens);
    const toolTokens = roughJson(toolsJson);
    const historyTokens = roughTokenCountEstimationForMessages(this.messages);

    const contextWindow = getContextWindowForModel(model);
    const used = systemCoreTokens + memoryTokens + toolTokens + historyTokens;
    const free = Math.max(0, contextWindow - used);

    const snapshot = buildTokenBudgetSnapshot(this.messages, { systemPrompt, model });

    const fmt = (n: number): string => n.toLocaleString("en-US");
    const pct = (n: number): string => `${((n / contextWindow) * 100).toFixed(1)}%`;
    const bar = (n: number): string => {
      const width = 20;
      const filled = Math.min(width, Math.max(0, Math.round((n / contextWindow) * width)));
      return "█".repeat(filled) + "░".repeat(width - filled);
    };
    const row = (label: string, n: number): string =>
      `  ${label.padEnd(22)} ${bar(n)} ${pct(n).padStart(6)}  ${fmt(n)} tok`;

    const lines = [
      `Context usage (${model})`,
      "",
      `Context window: ${fmt(contextWindow)} tokens`,
      "",
      row("System prompt", systemCoreTokens),
      row("AGENT.md + memory", memoryTokens),
      row("Tool definitions", toolTokens),
      row("Conversation history", historyTokens),
      row("Free space", free),
      "",
      `Estimated used: ${fmt(used)} / ${fmt(contextWindow)} (${pct(used)})`,
    ];
    if (snapshot.estimatedConversationTokens >= snapshot.autoCompactThreshold) {
      lines.push("", "⚠ Approaching the auto-compact threshold — consider /compact.");
    }
    yield { type: "command", kind: "info", message: lines.join("\n") };
    return { handled: true };
  }

  /** Best-effort reachability probe for the API endpoint (5s timeout). */
  private async probeEndpoint(
    baseURL: string,
  ): Promise<{ ok: boolean; status?: number; error?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(baseURL, { method: "GET", signal: controller.signal });
      return { ok: true, status: res.status };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Stage 33: `/doctor` — environment health check. Each line carries a
   * status icon (✓ ok / ⚠ warning / ✗ failure) plus a remediation hint:
   * Node version, API auth token, endpoint reachability, MCP connections,
   * sandbox availability, and settings-file validity.
   */
  private async *handleDoctorCommand(): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
    const cwd = this.toolContext.cwd;
    const ICON = { ok: "✓", warn: "⚠", fail: "✗" };
    const lines = ["Doctor — environment check", ""];

    // Node version
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    if (nodeMajor >= 18) lines.push(`${ICON.ok} Node.js ${process.version}`);
    else lines.push(`${ICON.fail} Node.js ${process.version} — upgrade to v18+ (v20+ recommended).`);

    // API auth token (env or a model profile's apiKey)
    const hasEnvToken = !!(process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY);
    let hasProfileKey = false;
    try {
      const { loadProfiles } = await import("../services/api/providers/profile.js");
      const { profiles } = await loadProfiles(cwd);
      hasProfileKey = Object.values(profiles).some((p) => !!p.apiKey);
    } catch {
      // ignore profile load failures here — surfaced under settings validity
    }
    if (hasEnvToken || hasProfileKey) {
      lines.push(
        `${ICON.ok} API auth token present${hasEnvToken ? " (ANTHROPIC_AUTH_TOKEN)" : " (model profile)"}`,
      );
    } else {
      lines.push(
        `${ICON.fail} No API auth token — set ANTHROPIC_AUTH_TOKEN (and ANTHROPIC_BASE_URL for a custom endpoint).`,
      );
    }

    // Endpoint + reachability
    const baseURL = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
    lines.push(`  Endpoint: ${baseURL}`);
    const reach = await this.probeEndpoint(baseURL);
    if (reach.ok) lines.push(`${ICON.ok} Endpoint reachable (HTTP ${reach.status})`);
    else lines.push(`${ICON.warn} Endpoint not reachable: ${reach.error}`);

    // MCP servers
    const mcp = getMcpRegistry();
    if (mcp.length === 0) {
      lines.push(`${ICON.ok} MCP: none configured`);
    } else {
      for (const { connection } of mcp) {
        if (connection.type === "connected") lines.push(`${ICON.ok} MCP ${connection.name}: connected`);
        else if (connection.type === "failed") lines.push(`${ICON.fail} MCP ${connection.name}: ${connection.error}`);
        else if (connection.type === "pending") lines.push(`${ICON.warn} MCP ${connection.name}: connecting…`);
        else lines.push(`${ICON.warn} MCP ${connection.name}: disabled`);
      }
    }

    // Sandbox
    let sandboxEnabled = false;
    try {
      sandboxEnabled = (await loadSandboxSettings(cwd)).enabled === true;
    } catch {
      // treat as disabled
    }
    if (!isSandboxPlatformSupported()) {
      lines.push(
        `${sandboxEnabled ? ICON.warn : ICON.ok} Sandbox: not supported on ${process.platform}` +
          (sandboxEnabled ? " (sandbox.enabled has no effect here)" : ""),
      );
    } else if (isSandboxRuntimeReady()) {
      lines.push(
        `${ICON.ok} Sandbox: sandbox-exec available${sandboxEnabled ? " (enabled)" : " (disabled in settings)"}`,
      );
    } else {
      const reason = getSandboxUnavailableReason(true) ?? "sandbox-exec not found";
      lines.push(`${sandboxEnabled ? ICON.fail : ICON.warn} Sandbox: ${reason}`);
    }

    // Settings validity
    const settingsErrors = await loadSettingsDiagnostics(cwd).catch(() => [] as string[]);
    if (settingsErrors.length === 0) {
      lines.push(`${ICON.ok} Settings files valid`);
    } else {
      lines.push(`${ICON.fail} Settings problems:`);
      for (const e of settingsErrors) lines.push(`    - ${e}`);
    }

    yield { type: "command", kind: "info", message: lines.join("\n") };
    return { handled: true };
  }

  /**
   * Stage 33: `/copy [n]` — copy an assistant reply to the system clipboard.
   * `/copy` copies the most recent reply; `/copy n` copies the n-th most
   * recent (1 = latest). Text-only: image blocks are ignored.
   */
  private async *handleCopyCommand(
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

    const assistantTexts = this.messages
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

  /** Serialize the live conversation (`this.messages`) into readable Markdown. */
  private serializeConversationMarkdown(): string {
    const lines: string[] = [];
    lines.push("# Easy Agent session export");
    lines.push("");
    lines.push(`- Session id: ${this.toolContext.sessionId ?? "(none)"}`);
    lines.push(`- Exported: ${new Date().toISOString()}`);
    lines.push(`- Model: ${this.getActiveModel()}`);
    lines.push(`- Messages: ${this.messages.length}`);
    lines.push("");

    for (const msg of this.messages) {
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
   * Stage 33: `/export [filename]` — write the current conversation to a
   * Markdown file. With no filename it falls back to a timestamped default in
   * the cwd. Relative paths resolve against the cwd.
   */
  private async *handleExportCommand(
    args: string[],
  ): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
    if (this.messages.length === 0) {
      yield { type: "command", kind: "info", message: "Nothing to export — the conversation is empty." };
      return { handled: true };
    }

    const md = this.serializeConversationMarkdown();
    const rawName = args.join(" ").trim();
    const defaultName = `easy-agent-export-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
    const target = rawName || defaultName;
    const outPath = isAbsolutePath(target) ? target : resolvePath(this.toolContext.cwd, target);

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
      message: `Exported ${this.messages.length} message(s) to:\n  ${outPath}`,
    };
    return { handled: true };
  }

  /**
   * Stage 33: `/resume [n|id]` (alias `/continue`).
   *   - no arg  → list this project's saved sessions, numbered, for selection
   *   - <n>     → resume the n-th session from the list (1 = most recent)
   *   - <id>    → resume by session id (exact or unique prefix)
   * The switch happens in-process: the engine swaps its message log + usage,
   * and emits `session_switched` so the UI rebinds the session id, file
   * history, and transcript target.
   */
  private async *handleResumeCommand(
    args: string[],
  ): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
    const cwd = this.toolContext.cwd;
    const sessions = await listProjectSessions(cwd).catch(() => []);
    const arg = args[0]?.trim();

    if (!arg) {
      if (sessions.length === 0) {
        yield { type: "command", kind: "info", message: "No saved sessions for this project yet." };
        return { handled: true };
      }
      // Hand the list to the UI, which renders an interactive picker
      // (↑↓ + Enter) and re-invokes `/resume <id>` on selection — mirroring
      // source's LogSelector instead of a static text dump.
      yield {
        type: "resume_picker",
        sessions: sessions.map((s) => ({
          sessionId: s.sessionId,
          startedAt: s.startedAt,
          updatedAt: s.updatedAt,
          messageCount: s.messageCount,
          model: s.model,
          totalTokens: s.totalUsage.input_tokens + s.totalUsage.output_tokens,
          isCurrent: s.sessionId === this.toolContext.sessionId,
          firstPrompt: s.firstPrompt,
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
    if (targetId === this.toolContext.sessionId) {
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

    this.messages = [...restored.messages];
    this.totalUsage = { ...restored.summary.totalUsage };
    this.usageAnchorIndex = this.messages.length > 0 ? this.messages.length - 1 : -1;
    this.lastCallUsage = { input_tokens: 0, output_tokens: 0 };
    this.currentMessageId = null;
    // A resumed session is a fresh boot for the SessionStart hook semantics.
    this.sessionStartHooksFired = false;

    // Note: we deliberately do NOT emit `messages_updated` here. The UI's
    // session_switched handler owns the swap — it must first blank the message
    // list (so Ink's <Static> resets its print cursor) before repainting the
    // restored conversation. A `messages_updated` would set the list early and
    // leave Static's cursor past the end, so nothing repaints after the clear.
    yield {
      type: "session_switched",
      sessionId: targetId,
      messages: [...this.messages],
      totalUsage: { ...this.totalUsage },
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
      body: [
        `${restored.summary.messageCount} message(s) restored`,
        `Model: ${restored.summary.model}`,
      ].join("\n"),
    };
    return { handled: true };
  }

  /** Run a git command in the cwd; never throws (returns ok:false instead). */
  private async runGit(args: string[]): Promise<{ ok: boolean; stdout: string; error?: string }> {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd: this.toolContext.cwd,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { ok: true, stdout };
    } catch (error) {
      return { ok: false, stdout: "", error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Stage 33: `/diff [n]` — show what changed, as a colorized panel.
   *   - Uncommitted git changes (working tree vs HEAD): per-file unified
   *     patches the UI renders with green/red/cyan hunks (mirrors source's
   *     DiffDetailView). Falls back gracefully outside a git repo.
   *   - Agent file-history edits over the last n turns (default 1), reusing the
   *     same snapshot machinery `/rewind` relies on.
   *
   * Emits a structured `diff_view` event rather than a text blob so the diff
   * reads like a real diff instead of a raw `git diff` dump.
   */
  private async *handleDiffCommand(
    args: string[],
  ): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
    let turns = 1;
    const raw = args[0]?.trim();
    if (raw) {
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        yield { type: "command", kind: "error", message: `Invalid turn count: ${raw}. Usage: /diff [n] where n ≥ 1.` };
        return { handled: true };
      }
      turns = parsed;
    }

    const cwd = this.toolContext.cwd;
    // Total patch-line budget across all files so a huge working tree can't
    // flood the terminal. Past this the UI shows a "run git diff" hint.
    const MAX_PATCH_LINES = 400;

    let isRepo = false;
    let files: DiffFilePatch[] = [];
    let gitStat: DiffViewData["gitStat"] = null;
    let truncated = false;

    const repoCheck = await this.runGit(["rev-parse", "--is-inside-work-tree"]);
    if (repoCheck.ok && repoCheck.stdout.trim() === "true") {
      isRepo = true;
      const [status, shortstat, patch] = await Promise.all([
        this.runGit(["status", "--short"]),
        this.runGit(["diff", "--shortstat"]),
        this.runGit(["diff"]),
      ]);

      const statusByPath = parseGitStatus(status.stdout);
      gitStat = parseShortStat(shortstat.stdout);

      let budget = MAX_PATCH_LINES;
      for (const file of parseGitDiff(patch.stdout)) {
        const rel = relativePath(cwd, file.path);
        const displayPath = rel && !rel.startsWith("..") ? rel : file.path;
        if (budget <= 0) {
          truncated = true;
          break;
        }
        const lines = file.lines.slice(0, budget);
        if (lines.length < file.lines.length) truncated = true;
        budget -= lines.length;
        files.push({
          path: displayPath,
          status: statusByPath.get(file.path) ?? "M",
          lines,
        });
      }
    }

    // ── file-history per-turn edits ──
    let fileHistory: DiffViewData["fileHistory"];
    if (!fileHistoryEnabled() || snapshotCount() === 0) {
      fileHistory = !fileHistoryEnabled() ? { state: "disabled" } : { state: "empty" };
    } else {
      const target = getSnapshotByOffset(Math.min(turns, snapshotCount()));
      if (!target) {
        fileHistory = { state: "empty" };
      } else {
        const stats = await fileHistoryGetDiffStats(target.messageId);
        if (stats.filesChanged.length === 0) {
          fileHistory = { state: "empty" };
        } else {
          fileHistory = {
            state: "changes",
            filesChanged: stats.filesChanged.map((f) => {
              const rel = relativePath(cwd, f);
              return rel && !rel.startsWith("..") ? rel : f;
            }),
            insertions: stats.insertions,
            deletions: stats.deletions,
          };
        }
      }
    }

    yield {
      type: "diff_view",
      data: { isRepo, files, gitStat, truncated, turns, fileHistory },
    };
    return { handled: true };
  }

  /** Read one settings layer's allow/deny array (strings only). */
  private readScopeRules(
    sources: { source: SettingSource; raw: Record<string, unknown> | null }[],
    scope: SettingSource,
    key: "allow" | "deny",
  ): string[] {
    const arr = sources.find((s) => s.source === scope)?.raw?.[key];
    return Array.isArray(arr)
      ? arr.filter((x): x is string => typeof x === "string")
      : [];
  }

  /**
   * Build the structured allow/deny rule list for the `/permissions` overlay:
   * every persisted rule tagged with its source layer (user/project/local),
   * plus the in-memory session rules, plus the active mode.
   */
  async getPermissionsView(): Promise<PermissionsViewData> {
    const cwd = this.toolContext.cwd;
    const sources = await loadSettingSources(cwd);
    const settings = this.permissionSettings ?? (await loadPermissionSettings(cwd));

    const allow: PermissionRuleRow[] = [];
    const deny: PermissionRuleRow[] = [];
    for (const scope of ["user", "project", "local"] as const) {
      for (const rule of this.readScopeRules(sources, scope, "allow")) allow.push({ rule, scope });
      for (const rule of this.readScopeRules(sources, scope, "deny")) deny.push({ rule, scope });
    }
    for (const rule of this.sessionPermissionRules.allow) allow.push({ rule, scope: "session" });
    for (const rule of this.sessionPermissionRules.deny) deny.push({ rule, scope: "session" });

    return { mode: settings.mode, allow, deny };
  }

  /**
   * Apply a single allow/deny rule change from the interactive `/permissions`
   * overlay, then hot-reload permission settings and return the fresh view.
   * `scope` must be a persisted layer — "session" rules aren't editable here.
   */
  async mutatePermissionRule(
    op: "allow" | "deny" | "remove",
    rule: string,
    scope: SettingSource,
  ): Promise<PermissionsViewData> {
    const cwd = this.toolContext.cwd;
    const write = async (patch: Record<string, unknown>): Promise<void> => {
      if (scope === "project") await updateProjectSettings(cwd, patch);
      else if (scope === "local") await updateLocalSettings(cwd, patch);
      else await updateUserSettings(patch);
    };

    const sources = await loadSettingSources(cwd);
    if (op === "remove") {
      await write({
        allow: this.readScopeRules(sources, scope, "allow").filter((r) => r !== rule),
        deny: this.readScopeRules(sources, scope, "deny").filter((r) => r !== rule),
      });
    } else {
      const current = this.readScopeRules(sources, scope, op);
      if (!current.includes(rule)) current.push(rule);
      await write({ [op]: current });
    }
    await this.reloadPermissionSettings();
    return this.getPermissionsView();
  }

  /**
   * Stage 33: `/permissions` (alias `/allowed-tools`). A dedicated allow/deny
   * rule manager that mirrors `/config`'s layered-write model but is scoped to
   * permission rules.
   *   - (no args) | list  → every allow/deny rule grouped by source layer
   *                         (user / project / local) + the in-memory session
   *                         rules + the active mode
   *   - allow <rule>      → append to a layer's `allow` array
   *   - deny  <rule>      → append to a layer's `deny` array
   *   - remove <rule>     → drop <rule> from a layer's allow AND deny arrays
   * Scope defaults to --local (this project, gitignored) and can be overridden
   * with --user / --project / --local. Writes hot-reload permission settings so
   * the next tool call sees them — same live-apply contract as `/config set`.
   */
  private async *handlePermissionsCommand(
    args: string[],
  ): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
    const cwd = this.toolContext.cwd;
    const sub = (args[0] ?? "").toLowerCase();

    const readScopeRules = this.readScopeRules.bind(this);

    // `/permissions` (no args) → interactive manager overlay (mirrors source's
    // PermissionRuleList). The UI owns the keyboard and mutates rules directly
    // via mutatePermissionRule(); the text subcommands below remain for headless
    // use and power-users.
    if (sub === "") {
      yield { type: "permissions_view", data: await this.getPermissionsView() };
      return { handled: true };
    }

    if (sub === "list" || sub === "ls") {
      const sources = await loadSettingSources(cwd);
      const settings = this.permissionSettings ?? (await loadPermissionSettings(cwd));
      const lines: string[] = ["Permission rules", `- Mode: ${settings.mode}`, ""];

      const layers: { scope: SettingSource; label: string }[] = [
        { scope: "user", label: "user (~/.easy-agent/settings.json)" },
        { scope: "project", label: "project (.easy-agent/settings.json)" },
        { scope: "local", label: "local (.easy-agent/settings.local.json)" },
      ];
      for (const { scope, label } of layers) {
        const allow = readScopeRules(sources, scope, "allow");
        const deny = readScopeRules(sources, scope, "deny");
        lines.push(`[${label}]`);
        if (allow.length === 0 && deny.length === 0) {
          lines.push("  (none)");
        } else {
          for (const r of allow) lines.push(`  allow  ${r}`);
          for (const r of deny) lines.push(`  deny   ${r}`);
        }
      }

      const session = this.sessionPermissionRules;
      lines.push("[session (this run only, not persisted)]");
      if (session.allow.length === 0 && session.deny.length === 0) {
        lines.push("  (none)");
      } else {
        for (const r of session.allow) lines.push(`  allow  ${r}`);
        for (const r of session.deny) lines.push(`  deny   ${r}`);
      }

      lines.push(
        "",
        "Usage: /permissions allow <rule>  [--user|--project|--local]",
        "Usage: /permissions deny <rule>   [--user|--project|--local]",
        "Usage: /permissions remove <rule> [--user|--project|--local]",
        "Default scope is --local (this project, gitignored).",
        "Rule examples: Read · Bash(git status:*) · WebFetch(domain:example.com)",
      );
      yield { type: "command", kind: "info", message: lines.join("\n") };
      return { handled: true };
    }

    const isRemove = sub === "remove" || sub === "rm";
    if (sub === "allow" || sub === "deny" || isRemove) {
      let scope: SettingSource = "local";
      const positional: string[] = [];
      for (const tok of args.slice(1)) {
        if (tok === "--user") scope = "user";
        else if (tok === "--project") scope = "project";
        else if (tok === "--local") scope = "local";
        else positional.push(tok);
      }
      const rule = positional.join(" ").trim();
      if (!rule) {
        yield {
          type: "command",
          kind: "error",
          message: `Usage: /permissions ${sub} <rule> [--user|--project|--local]`,
        };
        return { handled: true };
      }

      try {
        const sources = await loadSettingSources(cwd);
        const write = async (patch: Record<string, unknown>): Promise<void> => {
          if (scope === "project") await updateProjectSettings(cwd, patch);
          else if (scope === "local") await updateLocalSettings(cwd, patch);
          else await updateUserSettings(patch);
        };

        if (isRemove) {
          const allow = readScopeRules(sources, scope, "allow").filter((r) => r !== rule);
          const deny = readScopeRules(sources, scope, "deny").filter((r) => r !== rule);
          await write({ allow, deny });
        } else {
          const key = sub === "allow" ? "allow" : "deny";
          const current = readScopeRules(sources, scope, key);
          if (!current.includes(rule)) current.push(rule);
          await write({ [key]: current });
        }
        await this.reloadPermissionSettings();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        yield {
          type: "command",
          kind: "error",
          message: `Failed to update permission rules: ${msg}`,
        };
        return { handled: true };
      }

      const verb = isRemove ? "Removed" : sub === "allow" ? "Allowed" : "Denied";
      yield {
        type: "command",
        kind: "info",
        message: [
          `${verb} rule`,
          `- Rule: ${rule}`,
          `- Scope: ${scope}`,
          "- Applied to this session; takes effect on the next tool call.",
        ].join("\n"),
      };
      return { handled: true };
    }

    yield {
      type: "command",
      kind: "error",
      message: `Unknown /permissions subcommand: ${sub}. Use list, allow, deny, or remove.`,
    };
    return { handled: true };
  }

  /**
   * Build the ordered, numbered list of editable memory targets:
   *   - global AGENT.md (always, even if missing — so it can be created)
   *   - any AGENT.md in the cwd→root chain that exists, plus the cwd AGENT.md
   *   - the project memory index (MEMORY.md) + each topic memory file
   * The index is the selector used by `/memory edit <n>`, so it must be stable.
   */
  private async collectMemoryTargets(
    cwd: string,
  ): Promise<{ label: string; path: string; exists: boolean; size: number }[]> {
    const stat = async (fp: string): Promise<{ exists: boolean; size: number }> => {
      try {
        const st = await fsStat(fp);
        return { exists: st.isFile(), size: st.size };
      } catch {
        return { exists: false, size: 0 };
      }
    };

    const targets: { label: string; path: string; exists: boolean; size: number }[] = [];

    const agentFiles = await getAgentMdFiles(cwd);
    const globalPath = getGlobalAgentMdPath();
    const lastIdx = agentFiles.length - 1;
    for (let i = 0; i < agentFiles.length; i++) {
      const fp = agentFiles[i]!;
      const { exists, size } = await stat(fp);
      const isGlobal = fp === globalPath || i === 0;
      const isCwd = i === lastIdx;
      // Skip non-existent intermediate ancestors — only surface the global
      // file, the project (cwd) file, and any ancestor AGENT.md that exists.
      if (!exists && !isGlobal && !isCwd) continue;
      targets.push({
        label: isGlobal ? "global AGENT.md" : isCwd ? "project AGENT.md" : "AGENT.md",
        path: fp,
        exists,
        size,
      });
    }

    // Project memory dir (memdir). Don't create it just to list — only read if
    // it already exists.
    try {
      const memDir = await getProjectMemoryDir(cwd);
      const dirStat = await fsStat(memDir).catch(() => null);
      if (dirStat?.isDirectory()) {
        const entrypoint = joinPath(memDir, MEMORY_ENTRYPOINT);
        const ep = await stat(entrypoint);
        if (ep.exists) {
          targets.push({ label: "memory index (MEMORY.md)", path: entrypoint, ...ep });
        }
        const headers = await loadMemoryHeaders(cwd).catch(() => []);
        for (const h of headers) {
          const s = await stat(h.filePath);
          targets.push({ label: `memory: ${h.title}`, path: h.filePath, ...s });
        }
      }
    } catch {
      // memory dir resolution failed (e.g. no git root) — AGENT.md targets only
    }

    return targets;
  }

  /**
   * Stage 33: `/memory`. Lists the editable memory files (AGENT.md chain +
   * project memdir) and opens one in `$EDITOR`.
   *   - (no args) | list  → numbered list with paths + size/existence
   *   - edit <n> | <n>    → open target #n in $EDITOR (creating it if missing)
   * The actual editor launch happens in the UI layer (it owns the TTY), driven
   * by the `open_editor` event.
   */
  private async *handleMemoryCommand(
    args: string[],
  ): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
    const cwd = this.toolContext.cwd;
    const first = (args[0] ?? "").toLowerCase();

    const formatSize = (n: number): string =>
      n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;

    // Resolve a selection index from either `/memory edit <n>` or `/memory <n>`.
    let editArg: string | undefined;
    if (first === "edit" || first === "open") editArg = args[1]?.trim();
    else if (first && /^\d+$/.test(first)) editArg = first;

    if (editArg !== undefined) {
      const targets = await this.collectMemoryTargets(cwd);
      const idx = Number(editArg);
      if (!Number.isInteger(idx) || idx < 1 || idx > targets.length) {
        yield {
          type: "command",
          kind: "error",
          message: `Invalid selection: ${editArg}. Use /memory to list (1–${targets.length}).`,
        };
        return { handled: true };
      }
      const target = targets[idx - 1]!;
      // Create the file (and parents) if it doesn't exist yet, so $EDITOR opens
      // on a real path. Mirrors source's writeFile({ flag: 'wx' }) priming.
      if (!target.exists) {
        try {
          await mkdir(dirnamePath(target.path), { recursive: true });
          await writeFile(target.path, "", { encoding: "utf-8", flag: "wx" }).catch(
            (e: unknown) => {
              if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
            },
          );
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          yield { type: "command", kind: "error", message: `Cannot create ${target.path}: ${msg}` };
          return { handled: true };
        }
      }
      yield { type: "open_editor", filePath: target.path, label: target.label };
      return { handled: true };
    }

    const targets = await this.collectMemoryTargets(cwd);

    // `/memory list` → static text panel (used in headless / when the user
    // explicitly wants a non-interactive dump).
    if (first === "list") {
      const lines = ["Memory files", ""];
      if (targets.length === 0) {
        lines.push("(no memory files found)");
      } else {
        targets.forEach((t, i) => {
          const rel = relativePath(cwd, t.path);
          const shown = rel && !rel.startsWith("..") ? rel : t.path;
          const meta = t.exists ? formatSize(t.size) : "missing";
          lines.push(`  ${i + 1}. ${t.label}`);
          lines.push(`     ${shown}  (${meta})`);
        });
      }
      lines.push(
        "",
        "Usage: /memory edit <n>   open a file in $EDITOR (set $EDITOR or $VISUAL)",
      );
      yield { type: "command", kind: "info", message: lines.join("\n") };
      return { handled: true };
    }

    // `/memory` (no args) → interactive picker overlay (mirrors source's
    // MemoryFileSelector). The UI owns the keyboard; selecting a row re-invokes
    // `/memory edit <n>` so the $EDITOR launch path is shared.
    yield { type: "memory_picker", items: targets };
    return { handled: true };
  }

  private async *handleConfigCommand(
    args: string[],
  ): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
    const SENSITIVE_KEYS = new Set(["mode"]);
    const cwd = this.toolContext.cwd;
    const sub = (args[0] ?? "list").toLowerCase();

    // Compute the effective value + provenance for a key across sources.
    const resolveKey = (
      sources: { source: SettingSource; raw: Record<string, unknown> | null }[],
      key: string,
    ): { value: unknown; from: string } | null => {
      const sensitive = SENSITIVE_KEYS.has(key);
      const defs = sources.filter(
        (s) =>
          s.raw &&
          s.raw[key] !== undefined &&
          (!sensitive || (s.source !== "project" && s.source !== "local")),
      );
      if (defs.length === 0) return null;
      const allArrays = defs.every((s) => Array.isArray(s.raw![key]));
      if (allArrays) {
        const seen = new Set<string>();
        const merged: unknown[] = [];
        for (const s of defs) {
          for (const item of s.raw![key] as unknown[]) {
            const k = JSON.stringify(item);
            if (seen.has(k)) continue;
            seen.add(k);
            merged.push(item);
          }
        }
        return { value: merged, from: `merged(${defs.map((s) => s.source).join("+")})` };
      }
      const last = defs[defs.length - 1]!;
      return { value: last.raw![key], from: last.source };
    };

    const fmt = (v: unknown): string =>
      typeof v === "string" ? v : JSON.stringify(v);

    if (sub === "list") {
      const sources = await loadSettingSources(cwd);
      const keys = new Set<string>();
      for (const s of sources) if (s.raw) for (const k of Object.keys(s.raw)) keys.add(k);
      const lines = ["Configuration (effective values + source)"];
      if (keys.size === 0) {
        lines.push("", "No settings configured. Use /config set <key> <value> to add one.");
      } else {
        for (const key of [...keys].sort()) {
          const r = resolveKey(sources, key);
          if (!r) continue;
          lines.push(`  ${key} = ${fmt(r.value)}   [${r.from}]`);
        }
      }
      lines.push(
        "",
        "Usage: /config get <key>",
        "Usage: /config set <key> <value> [--user|--project|--local]",
      );
      yield { type: "command", kind: "info", message: lines.join("\n") };
      return { handled: true };
    }

    if (sub === "get") {
      const key = args[1]?.trim();
      if (!key) {
        yield { type: "command", kind: "error", message: "Usage: /config get <key>" };
        return { handled: true };
      }
      const sources = await loadSettingSources(cwd);
      const r = resolveKey(sources, key);
      if (!r) {
        yield { type: "command", kind: "info", message: `${key} is not set.` };
        return { handled: true };
      }
      yield { type: "command", kind: "info", message: `${key} = ${fmt(r.value)}   [${r.from}]` };
      return { handled: true };
    }

    if (sub === "set") {
      // Parse: /config set <key> <value...> [--user|--project|--local]
      const rest = args.slice(1);
      let scope: SettingSource = "user";
      const positional: string[] = [];
      for (const tok of rest) {
        if (tok === "--user") scope = "user";
        else if (tok === "--project") scope = "project";
        else if (tok === "--local") scope = "local";
        else positional.push(tok);
      }
      const key = positional.shift();
      const rawValue = positional.join(" ").trim();
      if (!key || !rawValue) {
        yield {
          type: "command",
          kind: "error",
          message: "Usage: /config set <key> <value> [--user|--project|--local]",
        };
        return { handled: true };
      }

      let value: unknown;
      try {
        value = JSON.parse(rawValue);
      } catch {
        value = rawValue;
      }

      try {
        if (scope === "project") await updateProjectSettings(cwd, { [key]: value });
        else if (scope === "local") await updateLocalSettings(cwd, { [key]: value });
        else await updateUserSettings({ [key]: value });
        // Apply live: permission rules / mode are read fresh into the engine;
        // model / outputStyle / statusLine are re-read on their next use.
        await this.reloadPermissionSettings();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        yield { type: "command", kind: "error", message: `Failed to write setting: ${msg}` };
        return { handled: true };
      }

      yield {
        type: "command",
        kind: "info",
        message: [
          "Setting updated",
          `- ${key} = ${fmt(value)}`,
          `- Scope: ${scope}`,
          "- Applied to this session; permission changes take effect on the next tool call.",
        ].join("\n"),
      };
      return { handled: true };
    }

    yield {
      type: "command",
      kind: "error",
      message: `Unknown /config subcommand: ${sub}. Use list, get, or set.`,
    };
    return { handled: true };
  }

  /**
   * Stage 23: `/output-style [name]`.
   *   - no arg          → list available styles + show the active one
   *   - <name>          → switch the active style and persist it as the
   *                       default (`outputStyle` in ~/.easy-agent/settings.json)
   * The switch takes effect on the NEXT turn because buildSystemPrompt reads
   * the registry fresh each request.
   */
  private async *handleOutputStyleCommand(
    args: string[],
  ): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
    const target = args.join(" ").trim();
    const active = getActiveOutputStyleName();

    if (!target) {
      const all = getAllOutputStyles();
      const lines = ["Output style status", `- Active: ${active}`, "", "Available styles:"];
      for (const style of all) {
        const marker = style.name === active ? "*" : " ";
        lines.push(`  ${marker} ${style.name}    ${style.description} [${style.source}]`);
      }
      lines.push(
        "",
        "Usage: /output-style <name> to switch (e.g. /output-style Explanatory)",
        "Usage: /output-style default to reset",
      );
      yield { type: "command", kind: "info", message: lines.join("\n") };
      return { handled: true };
    }

    const resolved = resolveOutputStyle(target);
    if (!resolved) {
      const names = getAllOutputStyles().map((s) => s.name).join(", ");
      yield {
        type: "command",
        kind: "error",
        message: `Output style not found: ${target}. Available: ${names}.`,
      };
      return { handled: true };
    }

    if (resolved.name === active) {
      yield {
        type: "command",
        kind: "info",
        message: `Output style is already '${resolved.name}'.`,
      };
      return { handled: true };
    }

    setActiveOutputStyle(resolved.name);
    // Persist as the default for future sessions. Best-effort: a write
    // failure (e.g. read-only home) shouldn't break the in-session switch.
    await updateUserSettings({ outputStyle: resolved.name }).catch(() => {});
    yield {
      type: "command",
      kind: "info",
      message: `Output style changed: ${active} → ${resolved.name}. Applies from the next turn.`,
    };
    return { handled: true };
  }

  /**
   * Handle `/skills` — read-only listing of every skill the loader picked
   * up at startup, split by visibility (model-visible vs hidden vs
   * conditionally-latent). No subcommands yet — `/skills reload` is
   * deferred to a later stage; users can restart the CLI to pick up
   * SKILL.md edits.
   */
  private async *handleSkillsCommand(): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
    const all = getAllUserInvocableSkills();
    if (all.length === 0) {
      yield {
        type: "command",
        kind: "info",
        message:
          "Skills (0 loaded)\n\n" +
          "No skills found. Add a directory containing SKILL.md to:\n" +
          "  ~/.easy-agent/skills/<name>/SKILL.md   (user-wide)\n" +
          "  .easy-agent/skills/<name>/SKILL.md     (project-only)",
      };
      return { handled: true };
    }
    const lines = [`Skills (${all.length} loaded)`, ""];
    for (const skill of all) {
      const meta: string[] = [skill.source];
      if (skill.frontmatter.disableModelInvocation) meta.push("hidden-from-model");
      if (skill.frontmatter.paths) meta.push(`conditional: ${skill.frontmatter.paths.join(",")}`);
      if (skill.frontmatter.allowedTools.length > 0) {
        meta.push(`allowed-tools: ${skill.frontmatter.allowedTools.join(",")}`);
      }
      lines.push(`  /${skill.name} — ${skill.description}`);
      lines.push(`    ${meta.join(" · ")}`);
    }
    lines.push("", "Invoke a skill with /<name> [args], or let the model call it via the Skill tool.");
    yield { type: "command", kind: "info", message: lines.join("\n") };
    return { handled: true };
  }

  /**
   * Handle `/agents` — read-only listing of every Agent definition the
   * loader picked up at startup, grouped by source. Mirrors the source's
   * `claude agents` CLI handler (claude-code-source-code/src/tools/
   * AgentTool/agentDisplay.ts) but stripped to a text-only listing — no
   * interactive AgentsMenu yet.
   *
   * The model only sees the agents in the system-prompt <system-reminder>;
   * this command is the human-side answer to "what sub-agent types are
   * available right now?"
   */
  private async *handleAgentsCommand(): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
    const all = getAllAgents();
    if (all.length === 0) {
      yield {
        type: "command",
        kind: "info",
        message:
          "Agents (0 loaded)\n\n" +
          "No agents registered. Built-ins should always be present — if you see\n" +
          "this, the bootstrap may have failed; check the startup logs.\n" +
          "Add custom agents under:\n" +
          "  ~/.easy-agent/agents/<name>.md   (user-wide)\n" +
          "  .easy-agent/agents/<name>.md     (project-only)",
      };
      return { handled: true };
    }

    // Group by source so a project override is visually adjacent to
    // (and shadowing) its built-in. Order: built-in → user → project.
    const SOURCE_ORDER: Record<string, number> = { "built-in": 0, user: 1, project: 2 };
    const sorted = [...all].sort((a, b) => {
      const cmp = (SOURCE_ORDER[a.source] ?? 99) - (SOURCE_ORDER[b.source] ?? 99);
      if (cmp !== 0) return cmp;
      return a.agentType.localeCompare(b.agentType);
    });

    const lines = [`Agents (${all.length} loaded)`, ""];
    for (const agent of sorted) {
      const tags: string[] = [agent.source];
      if (agent.tools && agent.tools.length > 0) {
        tags.push(`tools: ${agent.tools.join(",")}`);
      } else {
        tags.push("tools: *");
      }
      if (agent.disallowedTools && agent.disallowedTools.length > 0) {
        tags.push(`disallowed: ${agent.disallowedTools.join(",")}`);
      }
      if (agent.model) tags.push(`model: ${agent.model}`);
      if (agent.maxTurns !== undefined) tags.push(`maxTurns: ${agent.maxTurns}`);
      if (agent.permissionMode) tags.push(`mode: ${agent.permissionMode}`);

      const desc = agent.whenToUse.length > 200
        ? `${agent.whenToUse.slice(0, 197)}…`
        : agent.whenToUse;
      lines.push(`  ${agent.agentType} — ${desc}`);
      lines.push(`    ${tags.join(" · ")}`);
      if (agent.filePath) {
        lines.push(`    ${agent.filePath}`);
      }
    }
    lines.push(
      "",
      "Sub-agents are spawned by the model via the `Agent` tool —",
      "you cannot invoke them directly. The model picks `subagent_type` from",
      "the names listed above, based on the task.",
    );
    yield { type: "command", kind: "info", message: lines.join("\n") };
    return { handled: true };
  }

  /**
   * Handle `/hooks` — read-only listing of every configured hook the
   * loader picked up at startup, grouped by event + source. Mirrors
   * source's `commands/hooks/index.ts` + `HooksConfigMenu`, stripped
   * to a text-only listing (no interactive TUI) — Easy Agent
   * deliberately keeps the teaching version's slash UX dead simple.
   *
   * Shows:
   *   - which file path was read for each scope (user / project)
   *   - the kill switch state (EASY_AGENT_DISABLE_HOOKS)
   *   - per-event matcher groups + the command + timeout
   *
   * The model never sees this output — it's a human-side answer to
   * "what hooks are running right now?".
   */
  private async *handleHooksCommand(): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
    const report = await loadHooksDiagnosticReport(this.toolContext.cwd);
    const lines: string[] = [];

    lines.push("Hooks configuration");
    lines.push("");
    if (report.globallyDisabled) {
      lines.push("⚠ EASY_AGENT_DISABLE_HOOKS is set — all hooks are disabled this session.");
      lines.push("");
    }
    lines.push(`User-scope file:    ${report.userPath}`);
    lines.push(`Project-scope file: ${report.projectPath}`);
    lines.push("");

    const totalHookCount = (scope: HooksSettings): number =>
      HOOK_EVENTS.reduce(
        (sum, ev) =>
          sum +
          (scope[ev] ?? []).reduce((s, g) => s + g.hooks.length, 0),
        0,
      );
    const userTotal = totalHookCount(report.userHooks);
    const projectTotal = totalHookCount(report.projectHooks);

    if (userTotal === 0 && projectTotal === 0) {
      lines.push("No hooks configured. To add one, edit the user or project file above:");
      lines.push("");
      lines.push("  {");
      lines.push('    "hooks": {');
      lines.push('      "PreToolUse": [');
      lines.push('        { "matcher": "Bash", "hooks": [');
      lines.push('          { "type": "command", "command": "./safety-check.sh", "timeout": 10 }');
      lines.push("        ] }");
      lines.push("      ]");
      lines.push("    }");
      lines.push("  }");
      lines.push("");
      lines.push("Six events are supported: " + HOOK_EVENTS.join(", "));
      lines.push("");
      lines.push("Hook contract:");
      lines.push("  - stdin = JSON event payload");
      lines.push("  - exit 0 + stdout text   → injected as additionalContext (for some events)");
      lines.push("  - exit 2 + stderr text   → block the action; stderr fed back to the model");
      lines.push("  - JSON stdout            → richer control (decision / permissionDecision / additionalContext)");
      yield { type: "command", kind: "info", message: lines.join("\n") };
      return { handled: true };
    }

    lines.push(`Loaded ${userTotal + projectTotal} hook command(s) — ${userTotal} user, ${projectTotal} project.`);
    lines.push("");

    const renderScope = (scopeLabel: string, scope: HooksSettings): void => {
      let anyForScope = false;
      for (const event of HOOK_EVENTS) {
        const groups = scope[event] ?? [];
        if (groups.length === 0) continue;
        if (!anyForScope) {
          lines.push(`[${scopeLabel}]`);
          anyForScope = true;
        }
        for (const group of groups) {
          const matcher = group.matcher && group.matcher !== "*" ? group.matcher : "*";
          lines.push(`  ${event}  matcher=${matcher}`);
          for (const hook of group.hooks) {
            const cmdPreview = hook.command.length > 80
              ? `${hook.command.slice(0, 77)}...`
              : hook.command;
            lines.push(`    - $ ${cmdPreview}    (timeout: ${hook.timeout ?? 60}s)`);
          }
        }
      }
      if (anyForScope) lines.push("");
    };

    renderScope("user", report.userHooks);
    renderScope("project", report.projectHooks);

    lines.push("Order of execution: all user groups, then all project groups (in file order).");
    lines.push("Run results aggregate as: deny > ask > allow.");
    lines.push("Set EASY_AGENT_DISABLE_HOOKS=1 to disable every hook for one session.");

    // Re-cast HookEvent to satisfy the unused-import check after type
    // narrowing eliminates the value usage at runtime. (Compile-only;
    // no runtime cost.)
    void ({} as HookEvent);

    yield { type: "command", kind: "info", message: lines.join("\n") };
    return { handled: true };
  }

  /**
   * Handle the `/mcp` slash command family.
   *
   *   /mcp                       — list every configured server + status + tool count
   *   /mcp tools <name>          — show all tools exposed by one server
   *   /mcp reconnect <name>      — drop cache + retry connection
   *
   * The output is rendered as a system notice (info/error tone), never sent
   * to the model. Mirrors the source's `mcp.tsx` panel content but stripped
   * to a text-only listing — Easy Agent doesn't need a full TUI panel for it.
   */
  private async *handleMcpCommand(args: string[]): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
    const describeTransport = (config: import("../types/mcp.js").ScopedMcpServerConfig): string => {
      if (config.type === "http") return `http: ${config.url}`;
      if (config.type === "sse") return `sse: ${config.url}`;
      return `stdio: ${config.command} ${(config.args ?? []).join(" ")}`.trim();
    };

    const [sub, ...rest] = args;

    if (!sub) {
      const entries = getMcpRegistry();
      if (entries.length === 0) {
        yield {
          type: "command",
          kind: "info",
          message:
            "MCP Servers (0 configured)\n\n" +
            "No MCP servers configured. Add them under \"mcpServers\" in:\n" +
            "  ~/.easy-agent/settings.json   (user-wide)\n" +
            "  .easy-agent/settings.json      (project-only)",
        };
        return { handled: true };
      }
      const lines = [`MCP Servers (${entries.length} configured)`, ""];
      for (const { connection, tools } of entries) {
        const transport = describeTransport(connection.config);
        if (connection.type === "connected") {
          lines.push(`  ✓ ${connection.name}    connected   ${tools.length} tool(s)   (${transport})`);
        } else if (connection.type === "failed") {
          lines.push(`  ✗ ${connection.name}    failed      ${connection.error}`);
        } else if (connection.type === "pending") {
          const elapsedSec = Math.floor((Date.now() - connection.startedAt) / 1000);
          lines.push(`  … ${connection.name}    connecting  (${elapsedSec}s elapsed; ${transport})`);
        } else {
          lines.push(`  - ${connection.name}    disabled`);
        }
      }
      lines.push("", "Subcommands: /mcp tools <name> | /mcp reconnect <name>");
      yield { type: "command", kind: "info", message: lines.join("\n") };
      return { handled: true };
    }

    if (sub === "tools") {
      const target = rest[0];
      if (!target) {
        yield { type: "command", kind: "error", message: "Usage: /mcp tools <serverName>" };
        return { handled: true };
      }
      const entry = getMcpRegistryEntry(target);
      if (!entry) {
        yield { type: "command", kind: "error", message: `MCP server '${target}' is not configured.` };
        return { handled: true };
      }
      if (entry.connection.type !== "connected") {
        yield {
          type: "command",
          kind: "error",
          message: `MCP server '${target}' is ${entry.connection.type}; cannot list tools.`,
        };
        return { handled: true };
      }
      if (entry.tools.length === 0) {
        yield {
          type: "command",
          kind: "info",
          message: `MCP server '${target}' exposes no tools (server may not declare the 'tools' capability).`,
        };
        return { handled: true };
      }
      const lines = [`MCP tools from '${target}' (${entry.tools.length})`, ""];
      for (const tool of entry.tools) {
        const ro = tool.isReadOnly() ? "[ro]" : "    ";
        const desc = tool.description.replace(/\s+/g, " ").trim();
        const truncated = desc.length > 100 ? `${desc.slice(0, 100)}…` : desc;
        lines.push(`  ${ro} ${tool.name}`);
        if (truncated) lines.push(`        ${truncated}`);
      }
      yield { type: "command", kind: "info", message: lines.join("\n") };
      return { handled: true };
    }

    if (sub === "reconnect") {
      const target = rest[0];
      if (!target) {
        yield { type: "command", kind: "error", message: "Usage: /mcp reconnect <serverName>" };
        return { handled: true };
      }
      const entry = getMcpRegistryEntry(target);
      if (!entry) {
        yield { type: "command", kind: "error", message: `MCP server '${target}' is not configured.` };
        return { handled: true };
      }
      try {
        const next = await reconnectMcpServer(target);
        if (!next) {
          yield { type: "command", kind: "error", message: `MCP server '${target}' was removed before reconnect completed.` };
          return { handled: true };
        }
        if (next.type === "connected") {
          const newEntry = getMcpRegistryEntry(target);
          yield {
            type: "command",
            kind: "info",
            message: `MCP server '${target}' reconnected (${newEntry?.tools.length ?? 0} tool(s)).`,
          };
        } else if (next.type === "failed") {
          yield {
            type: "command",
            kind: "error",
            message: `MCP server '${target}' reconnect failed: ${next.error}`,
          };
        } else {
          yield {
            type: "command",
            kind: "info",
            message: `MCP server '${target}' is currently disabled.`,
          };
        }
      } catch (error) {
        yield {
          type: "command",
          kind: "error",
          message: `MCP server '${target}' reconnect threw: ${(error as Error).message}`,
        };
      }
      return { handled: true };
    }

    yield {
      type: "command",
      kind: "error",
      message: `Unknown /mcp subcommand: ${sub}. Try /mcp, /mcp tools <name>, or /mcp reconnect <name>.`,
    };
    return { handled: true };
  }
}
