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
import { tokenCountWithEstimation, buildTokenBudgetSnapshot } from "../utils/tokens.js";
import { formatProjectSessionHistory } from "../session/history.js";
import { getToolsApiParams } from "../tools/index.js";
import type { ToolContext } from "../tools/Tool.js";
import type { Usage } from "../types/message.js";
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

export type QueryEngineEvent =
  | AgenticLoopEvent
  | { type: "messages_updated"; messages: MessageParam[] }
  | { type: "compacted"; summary?: string; trigger: "auto" | "manual" | "micro" }
  | { type: "usage_updated"; totalUsage: Usage; turnUsage: Usage; lastCallUsage: Usage }
  | { type: "token_warning"; warning: TokenWarningResult }
  | { type: "command"; message: string; kind: "info" | "error" }
  | { type: "model_changed"; model: string; source: "default" | "session" }
  | { type: "session_cleared" }
  | { type: "mode_changed"; mode: PermissionMode; previousMode: PermissionMode }
  | { type: "task_mode_changed"; mode: TaskMode; previousMode: TaskMode };

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

    if (trimmed.startsWith("/")) {
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
      const userMessage: MessageParam = { role: "user", content: promptToSubmit };
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
          message: "Commands: /help /clear /config [list|get|set] /cost /model [name|default] /mode [default|plan|auto] /tasks [task|todo|reset] /mcp [tools <name>|reconnect <name>] /skills /agents /hooks /output-style [name] /history /compact /<skill-or-command> [args] /exit /quit /bye",
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

        if (!nextModel) {
          yield {
            type: "command",
            kind: "info",
            message: [
              "Model status",
              `- Active model: ${this.getActiveModel()}`,
              `- Source: ${this.getModelSource()}`,
              `- Default model: ${this.defaultModel}`,
              this.sessionModelOverride ? `- Session override: ${this.sessionModelOverride}` : "- Session override: none",
              "- Usage: /model <name> to override for this session",
              "- Usage: /model default to clear the override",
            ].join("\n"),
          };
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

        this.sessionModelOverride = nextModel;
        yield { type: "model_changed", model: nextModel, source: "session" };
        yield {
          type: "command",
          kind: "info",
          message: [
            "Model updated",
            `- Active model: ${nextModel}`,
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
        const result = await compactMessages(this.messages, focus || undefined, { usage: this.lastCallUsage, usageAnchorIndex: this.usageAnchorIndex, systemPrompt: manualSystemPrompt, force: true });
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
