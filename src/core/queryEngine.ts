import { randomUUID } from "node:crypto";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import {
  query,
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
import { autoCompactIfNeeded, calculateTokenWarningState } from "../context/autoCompact.js";
import { tokenCountWithEstimation } from "../utils/tokens.js";
import { formatProjectSessionHistory } from "../session/history.js";
import { fileHistoryMakeSnapshot } from "../session/fileHistory.js";
import { getToolsApiParams } from "../tools/index.js";
import { buildUserMessageContent } from "./attachImages.js";
import type { ToolContext } from "../tools/Tool.js";
import type { Usage } from "../types/message.js";
import type { ModelProfile } from "../services/api/providers/profile.js";
import { getPlanFilePath, planExists as checkPlanExists } from "../context/plans.js";
import { getPlanModeAttachment, getPlanModeExitAttachment } from "../context/planAttachments.js";
import { getTaskMode, setTaskMode } from "../state/taskModeStore.js";
import { getTaskListId, resetTaskList } from "../state/taskStore.js";
import { findSkill } from "../services/skills/registry.js";
import {
  drainPendingNotifications,
  pendingNotificationCount,
} from "../state/notificationStore.js";
import type { Skill } from "../types/types.js";
import { findUserCommand } from "../commands/userCommands/registry.js";
import { substituteArguments } from "../commands/userCommands/argumentSubstitution.js";
import { isBuiltinCommandName } from "../commands/builtinCommandNames.js";
import { tryExpandBuiltinPromptCommand } from "../commands/builtinPromptCommands.js";
import { type SettingSource } from "../config/sources.js";
import type { UserCommand } from "../commands/userCommands/types.js";
import {
  runSessionStartHooks,
  runUserPromptSubmitHooks,
} from "../hooks/index.js";
import {
  type ThinkingConfig,
  type EffortLevel,
  hasUltrathinkKeyword,
  modelSupportsAdaptiveThinking,
  setSessionThinkingConfig,
  getSessionThinkingConfig,
  setSessionEffortLevel,
  getSessionEffortLevel,
  ULTRATHINK_META_MESSAGE,
} from "../utils/thinking.js";

// Public types live in ./queryEngine/types.ts — imported for internal use and
// re-exported so existing `from "../core/queryEngine.js"` imports (UI hooks,
// components, headless, scripts) keep working unchanged.
import type {
  ResumeSessionInfo,
  MemoryPickerItem,
  PermissionRuleScope,
  PermissionRuleRow,
  PermissionsViewData,
  DiffFilePatch,
  DiffViewData,
  QueryEngineEvent,
  QueryEngineOptions,
  QueryEngineState,
} from "./queryEngine/types.js";
export type {
  ResumeSessionInfo,
  MemoryPickerItem,
  PermissionRuleScope,
  PermissionRuleRow,
  PermissionsViewData,
  DiffFilePatch,
  DiffViewData,
  QueryEngineEvent,
  QueryEngineOptions,
  QueryEngineState,
};

// Pure, side-effect-free helpers live in ./queryEngine/helpers.ts.
import { createEmptyUsage } from "./queryEngine/helpers.js";

// Extracted slash-command handlers + the context seam they run against.
import type { CommandContext } from "./queryEngine/commands/context.js";
import {
  handleStatusCommand,
  handleContextCommand,
  handleDoctorCommand,
} from "./queryEngine/commands/diagnostics.js";
import { handleDiffCommand } from "./queryEngine/commands/diff.js";
import {
  handleCopyCommand,
  handleExportCommand,
  handleResumeCommand,
} from "./queryEngine/commands/sessionExport.js";
import {
  handlePermissionsCommand,
  buildPermissionsView,
  mutatePermissionRule as mutatePermissionRuleImpl,
} from "./queryEngine/commands/permissions.js";
import { handleMemoryCommand } from "./queryEngine/commands/memory.js";
import {
  handleConfigCommand,
  handleOutputStyleCommand,
} from "./queryEngine/commands/config.js";
import {
  handleSkillsCommand,
  handleAgentsCommand,
  handleHooksCommand,
  handleMcpCommand,
} from "./queryEngine/commands/registry.js";
import { handleRewindCommand } from "./queryEngine/commands/rewind.js";

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

    // Stage 34: a skill can declare a reasoning-effort level; invoking it
    // sets the session effort (maps to output_config.effort on Anthropic).
    if (skill.frontmatter.effort) {
      setSessionEffortLevel(skill.frontmatter.effort);
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

    // ─── Stage 34: ultrathink keyword ──────────────────────────────
    // When the user prompt contains the whole-word keyword "ultrathink",
    // inject a hidden meta user message asking the model for high reasoning
    // effort. Mirrors source's ultrathink_effort branch: it does NOT change
    // the thinking budget — it only nudges effort via a meta message. The
    // marker prefix keeps it out of the human-visible transcript.
    if (promptToSubmit.length > 0 && hasUltrathinkKeyword(promptToSubmit)) {
      const ultrathinkMessage: MessageParam = {
        role: "user",
        content: `[ultrathink]\n${ULTRATHINK_META_MESSAGE}`,
      };
      this.messages = [...this.messages, ultrathinkMessage];
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

  /**
   * Build the CommandContext handed to extracted slash-command handlers.
   * Arrow functions capture `this` so handlers read live engine state at call
   * time; cwd/sessionId/defaultModel are effectively immutable for the session.
   */
  private commandContext(): CommandContext {
    return {
      cwd: this.toolContext.cwd,
      sessionId: this.toolContext.sessionId,
      defaultModel: this.defaultModel,
      getMessages: () => this.messages,
      getTotalUsage: () => this.totalUsage,
      getActiveModel: () => this.getActiveModel(),
      getModelSource: () => this.getModelSource(),
      getPermissionMode: () => this.currentPermissionMode,
      getPrePlanMode: () => this.prePlanMode,
      applyRestoredSession: (messages, totalUsage) => {
        this.messages = [...messages];
        this.totalUsage = { ...totalUsage };
        this.usageAnchorIndex = this.messages.length > 0 ? this.messages.length - 1 : -1;
        this.lastCallUsage = { input_tokens: 0, output_tokens: 0 };
        this.currentMessageId = null;
        // A resumed session is a fresh boot for the SessionStart hook semantics.
        this.sessionStartHooksFired = false;
      },
      getPermissionSettings: () => this.permissionSettings,
      getSessionPermissionRules: () => this.sessionPermissionRules,
      reloadPermissionSettings: () => this.reloadPermissionSettings(),
    };
  }

  private async *handleCommand(command: string): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
    const [name, ...args] = command.slice(1).split(/\s+/).filter(Boolean);

    switch (name) {
      case "help":
        yield {
          type: "command",
          kind: "info",
          message: "Commands: /help /clear /config [list|get|set] /cost /model [name|list|default] /mode [default|plan|auto] /think [on|off|<budget>] /effort [low|medium|high|max] /tasks [task|todo|reset] /mcp [tools <name>|reconnect <name>] /skills /agents /hooks /output-style [name] /history /compact /rewind [n] /status /context /doctor /copy [n] /export [file] /resume [n|id] /diff [n] /init /permissions [allow|deny|remove <rule>] /memory [edit <n>] /<skill-or-command> [args] /exit /quit /bye",
        };
        return { handled: true };
      case "config":
        return yield* handleConfigCommand(this.commandContext(), args);
      case "mcp":
        return yield* handleMcpCommand(args);
      case "output-style":
      case "output_style":
        return yield* handleOutputStyleCommand(args);
      case "skills":
        return yield* handleSkillsCommand();
      case "agents":
        return yield* handleAgentsCommand();
      case "hooks":
      case "hook":
        return yield* handleHooksCommand(this.commandContext());
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
        return yield* handleRewindCommand(this.commandContext(), args);
      case "status":
        return yield* handleStatusCommand(this.commandContext());
      case "context":
        return yield* handleContextCommand(this.commandContext());
      case "doctor":
        return yield* handleDoctorCommand(this.commandContext());
      case "copy":
        return yield* handleCopyCommand(this.commandContext(), args);
      case "export":
        return yield* handleExportCommand(this.commandContext(), args);
      case "resume":
      case "continue":
        return yield* handleResumeCommand(this.commandContext(), args);
      case "diff":
        return yield* handleDiffCommand(this.commandContext(), args);
      case "permissions":
      case "allowed-tools":
      case "allowed_tools":
        return yield* handlePermissionsCommand(this.commandContext(), args);
      case "memory":
        return yield* handleMemoryCommand(this.commandContext(), args);
      case "think": {
        // /think on|off|<budget> — per-session extended-thinking override.
        // Mirrors source's thinking three-state:
        //   on      → adaptive (or enabled+default budget on non-adaptive models)
        //   off     → disabled
        //   <N>     → enabled + budget N
        const arg = args[0]?.trim().toLowerCase();
        if (!arg) {
          const cfg = getSessionThinkingConfig();
          const desc = cfg
            ? cfg.type === "enabled"
              ? `enabled (budget ${cfg.budgetTokens})`
              : cfg.type
            : "default (adaptive unless settings/env disable it)";
          yield {
            type: "command",
            kind: "info",
            message: [
              `Extended thinking: ${desc}`,
              "- Usage: /think on        Enable (adaptive, or budgeted on older models)",
              "- Usage: /think off       Disable thinking for this session",
              "- Usage: /think <tokens>  Enable with an explicit token budget",
            ].join("\n"),
          };
          return { handled: true };
        }
        let next: ThinkingConfig;
        if (arg === "off" || arg === "false" || arg === "0") {
          next = { type: "disabled" };
        } else if (arg === "on" || arg === "true" || arg === "adaptive") {
          next = modelSupportsAdaptiveThinking(this.getActiveModel())
            ? { type: "adaptive" }
            : { type: "enabled", budgetTokens: 10_000 };
        } else {
          const budget = parseInt(arg, 10);
          if (!Number.isFinite(budget) || budget <= 0) {
            yield {
              type: "command",
              kind: "error",
              message: `Invalid /think argument: ${arg}. Use on, off, or a positive token budget.`,
            };
            return { handled: true };
          }
          next = { type: "enabled", budgetTokens: budget };
        }
        setSessionThinkingConfig(next);
        const label =
          next.type === "enabled"
            ? `enabled (budget ${next.budgetTokens})`
            : next.type;
        yield { type: "command", kind: "info", message: `Extended thinking: ${label}` };
        return { handled: true };
      }
      case "effort": {
        // /effort low|medium|high|max — set output_config.effort (Anthropic).
        const arg = args[0]?.trim().toLowerCase();
        if (!arg) {
          const current = getSessionEffortLevel();
          yield {
            type: "command",
            kind: "info",
            message: [
              `Reasoning effort: ${current ?? "default (model decides)"}`,
              "- Usage: /effort low|medium|high|max   Set effort for this session",
              "- Usage: /effort default               Clear the override",
              "- Note: only applies to Anthropic models that support effort.",
            ].join("\n"),
          };
          return { handled: true };
        }
        if (arg === "auto" || arg === "default" || arg === "clear" || arg === "off") {
          setSessionEffortLevel(undefined);
          yield { type: "command", kind: "info", message: "Reasoning effort cleared (model default)." };
          return { handled: true };
        }
        if (arg !== "low" && arg !== "medium" && arg !== "high" && arg !== "max") {
          yield {
            type: "command",
            kind: "error",
            message: `Invalid effort level: ${arg}. Must be low, medium, high, or max.`,
          };
          return { handled: true };
        }
        setSessionEffortLevel(arg as EffortLevel);
        yield { type: "command", kind: "info", message: `Reasoning effort: ${arg}` };
        return { handled: true };
      }
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
   * Build the structured allow/deny rule list for the `/permissions` overlay.
   * Public because the UI overlay calls it directly; the implementation lives
   * in ./queryEngine/commands/permissions.ts.
   */
  async getPermissionsView(): Promise<PermissionsViewData> {
    return buildPermissionsView(this.commandContext());
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
    return mutatePermissionRuleImpl(this.commandContext(), op, rule, scope);
  }

}
