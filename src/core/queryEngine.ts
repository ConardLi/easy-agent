import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import {
  query,
  type AgenticLoopEvent,
  type LoopTerminationReason,
} from "./agenticLoop.js";
import {
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
import type { Skill } from "../types/types.js";

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
  private readonly toolContext: ToolContext;
  private currentPermissionMode: PermissionMode;
  private prePlanMode: PermissionMode | null = null;
  private readonly permissionSettings?: PermissionSettings;
  private readonly sessionPermissionRules: PermissionRuleSet;
  private readonly onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionDecision>;
  private abortController: AbortController | null = null;
  private usageAnchorIndex: number = -1;
  private lastCallUsage: Usage = { input_tokens: 0, output_tokens: 0 };
  private modeChangeCallback?: (mode: PermissionMode, previousMode: PermissionMode) => void;
  private needsPlanModeExitAttachment = false;

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
    if (!trimmed) {
      return { handled: false };
    }

    if (trimmed.startsWith("/")) {
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
   * The original `submitMessage` body, factored out so user-invoked skills
   * can re-enter it with their expanded prompt text. Everything below this
   * point is identical to the pre-skills implementation.
   */
  private async *submitInternal(
    trimmed: string,
  ): AsyncGenerator<QueryEngineEvent, { handled: boolean; reason?: LoopTerminationReason }> {

    const previewSystemParts = await buildSystemPrompt({
      cwd: this.toolContext.cwd,
      userQuery: trimmed,
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

    const userMessage: MessageParam = { role: "user", content: trimmed };
    this.messages = [...this.messages, userMessage];
    yield { type: "messages_updated", messages: [...this.messages] };

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
    }
  }

  private invalidateUsageAnchor(): void {
    this.usageAnchorIndex = -1;
    this.lastCallUsage = { input_tokens: 0, output_tokens: 0 };
  }

  private getActiveModel(): string {
    return this.sessionModelOverride ?? this.defaultModel;
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
          message: "Commands: /help /clear /cost /model [name|default] /mode [default|plan|auto] /tasks [task|todo|reset] /mcp [tools <name>|reconnect <name>] /skills /history /compact /<skill-name> [args] /exit /quit /bye",
        };
        return { handled: true };
      case "mcp":
        return yield* this.handleMcpCommand(args);
      case "skills":
        return yield* this.handleSkillsCommand();
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
      const flags: string[] = [skill.source];
      if (skill.frontmatter.disableModelInvocation) flags.push("hidden-from-model");
      if (skill.frontmatter.paths) flags.push(`conditional: ${skill.frontmatter.paths.join(",")}`);
      if (skill.frontmatter.allowedTools.length > 0) {
        flags.push(`allowed-tools: ${skill.frontmatter.allowedTools.join(",")}`);
      }
      lines.push(`  /${skill.name}    ${skill.description}`);
      lines.push(`        [${flags.join("] [")}]`);
    }
    lines.push("", "Invoke a skill with /<name> [args], or let the model call it via the Skill tool.");
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
