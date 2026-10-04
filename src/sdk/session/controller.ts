/**
 * SessionController — the conversation core behind an `AgentSession`.
 *
 * Owns one QueryEngine, the session scope its work runs in, the transcript,
 * pending interaction requests, and the background wake-up. It turns engine
 * events into session events, records them, and runs the follow-up turns a
 * plan decision asks for. Frontends never talk to it directly; they hold an
 * `AgentSession` handle, which can be swapped for a new one when `/resume`
 * moves the conversation to another session id.
 */

import { randomUUID } from "node:crypto";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { classifyUserInput } from "../../commands/inputClassification.js";
import { getPlanFilePath, readPlan } from "../../context/plans.js";
import { QueryEngine, type QueryEngineEvent } from "../../core/queryEngine.js";
import type {
  PermissionDecision,
  PermissionRequest,
  PermissionRuleSet,
  PermissionSettings,
} from "../../permissions/permissions.js";
import { configureFileHistory, restoreFileHistorySnapshots } from "../../session/fileHistory.js";
import type { FileHistorySnapshotRecord } from "../../session/storage.js";
import { getAsyncAgentsForScope, killAsyncAgent, subscribeAsyncAgents } from "../../state/asyncAgentStore.js";
import { clearAllBashProgress, subscribeBashProgress } from "../../state/bashProgressStore.js";
import { clearAllMcpProgress, subscribeMcpProgress } from "../../state/mcpProgressStore.js";
import { pendingNotificationCount, subscribePendingNotifications } from "../../state/notificationStore.js";
import { runInSessionScope, type SessionScope } from "../../state/sessionScope.js";
import {
  clearAllSubAgentProgress,
  getSubAgentProgress,
  subscribeSubAgentProgress,
} from "../../state/subAgentProgressStore.js";
import { getTaskMode, subscribeTaskMode } from "../../state/taskModeStore.js";
import { getTaskListId, getTeamTaskListId, listTasks, subscribeTasks } from "../../state/taskStore.js";
import { getActiveTeam, subscribeActiveTeam } from "../../state/teamContext.js";
import { clearTodos, getTodos, subscribeTodos } from "../../state/todoStore.js";
import { clearAllToolStatus, subscribeToolStatus } from "../../state/toolStatusStore.js";
import { bashTool } from "../../tools/bashTool.js";
import { getToolsApiParams } from "../../tools/index.js";
import {
  toolResultText,
  type ToolContext,
  type UserQuestionRequest,
  type UserQuestionResponse,
} from "../../tools/Tool.js";
import type { Task } from "../../types/task.js";
import type { Usage } from "../../types/message.js";
import { hasPendingLeadMailboxSignal, subscribeMailboxWrites } from "../../utils/teammateMailbox.js";
import { buildDefaultThinkingConfig, getSessionEffortLevel } from "../../utils/thinking.js";
import { buildTokenBudgetSnapshot } from "../../utils/tokens.js";
import { AgentSdkError } from "../errors.js";
import type {
  AgentSessionOptions,
  BackgroundAgentInfo,
  InteractionKind,
  InteractionRequest,
  InterruptOutcome,
  PermissionResponse,
  PlanApprovalResponse,
  SessionEventBody,
  SessionState,
  SessionUsage,
  ShellResult,
  TurnContinuation,
  TurnResult,
  TurnSource,
} from "../types.js";
import { BackgroundWake } from "./backgroundWake.js";
import { EventHub } from "./eventHub.js";
import { InteractionBroker } from "./interactions.js";
import { TranscriptRecorder } from "./transcriptRecorder.js";

/** Rules a plan approval with "accept edits" adds for the rest of the session. */
export const PLAN_ACCEPT_EDITS_RULES = ["Write", "Edit", "Bash(npm *)", "Bash(npx *)"] as const;

const ALL_INTERACTIONS: readonly InteractionKind[] = ["permission", "plan_approval", "question"];
const PERMISSION_KINDS: readonly InteractionKind[] = ["permission", "plan_approval"];

export interface SessionControllerInit {
  scope: SessionScope;
  cwd: string;
  sessionId: string;
  model: string;
  options: AgentSessionOptions;
  permissionSettings: PermissionSettings;
  initialMessages: MessageParam[];
  initialUsage: Usage;
  fileHistorySnapshots: FileHistorySnapshotRecord[];
  /** Called after `/resume` switched the conversation to `newSessionId`. */
  onSessionReplaced(previousSessionId: string, newSessionId: string): void;
  onClosed(sessionId: string): void;
}

type PendingContinuation = { kind: "plan_followup" } | { kind: "feedback_followup"; feedback: string };

export class SessionController {
  readonly scope: SessionScope;
  readonly cwd: string;
  readonly hub: EventHub;
  #sessionId: string;
  readonly #persist: boolean;
  readonly #engine: QueryEngine;
  readonly #broker: InteractionBroker;
  readonly #recorder: TranscriptRecorder | null;
  readonly #wake: BackgroundWake | null;
  readonly #sessionRules: PermissionRuleSet = { allow: [], deny: [] };
  readonly #toolContext: ToolContext;
  readonly #init: SessionControllerInit;
  readonly #unsubscribers: Array<() => void> = [];

  #messages: MessageParam[];
  #usage: SessionUsage;
  #model: string;
  #modelSource: "default" | "session" = "default";
  #tasks: Task[] = [];
  #busy = false;
  readonly #idleWaiters: Array<() => void> = [];
  #turnId: string | null = null;
  #continuation: PendingContinuation | null = null;
  #closed = false;

  private constructor(init: SessionControllerInit) {
    this.#init = init;
    this.scope = init.scope;
    this.cwd = init.cwd;
    this.#sessionId = init.sessionId;
    this.#persist = init.options.persist !== false;
    this.#messages = [...init.initialMessages];
    this.#model = init.model;
    this.#usage = { total: { ...init.initialUsage }, turn: null, lastCall: null, context: null };
    this.hub = new EventHub(
      () => this.#sessionId,
      () => this.getState(),
    );
    this.#recorder = this.#persist
      ? new TranscriptRecorder(this.cwd, () => this.#sessionId, init.initialMessages)
      : null;
    this.#broker = new InteractionBroker(
      new Set(init.options.interactions ?? ALL_INTERACTIONS),
      init.options.handlers ?? {},
      {
        opened: (request) => this.#emit({ type: "request_opened", request }),
        resolved: (request, resolution) =>
          this.#emit({ type: "request_resolved", requestId: request.id, kind: request.kind, resolution }),
      },
    );
    this.#toolContext = this.#createToolContext();
    this.#engine = new QueryEngine({
      model: init.model,
      toolContext: this.#toolContext,
      initialMessages: init.initialMessages,
      initialUsage: init.initialUsage,
      permissionMode: init.options.permissionMode ?? init.permissionSettings.mode,
      permissionSettings: init.permissionSettings,
      sessionPermissionRules: this.#sessionRules,
      ...(init.options.defaultMaxTurns !== undefined ? { defaultMaxTurns: init.options.defaultMaxTurns } : {}),
      onPermissionRequest: (request) => this.#onPermissionRequest(request),
    });
    this.#engine.onModeChange((mode, previousMode) => this.#emit({ type: "mode_changed", mode, previousMode }));
    this.#wake =
      init.options.autoWake === false
        ? null
        : new BackgroundWake({
            hasQueuedInput: () => this.#hasQueuedBackgroundInput(),
            isIdle: () => !this.#busy && !this.#closed && this.#broker.list().length === 0,
            startTurn: () => this.send(""),
          });
  }

  /** Build a controller inside its scope and bind file history to the session. */
  static async create(init: SessionControllerInit): Promise<SessionController> {
    return runInSessionScope(init.scope, async () => {
      const persist = init.options.persist !== false;
      await configureFileHistory(init.cwd, init.sessionId, { enabled: persist });
      if (persist && init.fileHistorySnapshots.length > 0) restoreFileHistorySnapshots(init.fileHistorySnapshots);
      const controller = new SessionController(init);
      controller.#observeStores();
      return controller;
    });
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get closed(): boolean {
    return this.#closed;
  }

  // ─── State ──────────────────────────────────────────────────────────────

  getState(): SessionState {
    return this.#inScope(() => {
      const effort = getSessionEffortLevel();
      return {
        sessionId: this.#sessionId,
        cwd: this.cwd,
        busy: this.#busy,
        turnId: this.#turnId,
        model: this.#model,
        modelSource: this.#modelSource,
        permissionMode: this.#engine.getPermissionMode(),
        taskMode: getTaskMode(),
        thinking: buildDefaultThinkingConfig(),
        effort: effort ?? null,
        messages: [...this.#messages],
        usage: structuredClone(this.#usage),
        pendingRequests: this.#broker.list(),
        todos: getTodos(this.#sessionId),
        tasks: [...this.#tasks],
        backgroundAgents: this.#backgroundAgents(),
      };
    });
  }

  /** Names of the tools the model is offered in the current mode. */
  getToolNames(): string[] {
    return this.#inScope(() => getToolsApiParams(this.#engine.getPermissionMode()).map((tool) => tool.name));
  }

  // ─── Turns ──────────────────────────────────────────────────────────────

  async send(input: string): Promise<TurnResult> {
    this.#assertOpen();
    const text = input.trim();
    if (!text && !this.#inScope(() => this.#hasQueuedBackgroundInput())) {
      return { turnId: null, handled: false, followUps: [] };
    }
    if (this.#busy) throw new AgentSdkError("busy", "A turn is already running in this session.");
    // Busy spans the follow-up turns a plan decision triggers, so no other
    // input can slip in between a turn and its continuation.
    this.#busy = true;
    try {
      return await this.#inScope(() => this.#runTurn(text, text ? "user" : "background"));
    } finally {
      this.#busy = false;
      for (const resolve of this.#idleWaiters.splice(0)) resolve();
      this.#wake?.poke();
    }
  }

  /** Resolves once no turn is running. */
  waitForIdle(): Promise<void> {
    if (!this.#busy || this.#closed) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  /**
   * Stop the running turn. A pending confirmation is denied (a question is
   * cancelled) first, so the tool call it guards gets a result and the
   * conversation stays well-formed; the turn then ends instead of handing the
   * denial back to the model.
   */
  interrupt(): InterruptOutcome {
    if (this.#closed) return "idle";
    const permission = this.#broker.find(PERMISSION_KINDS);
    const question = permission ? undefined : this.#broker.find(["question"]);
    const pending = permission ?? question;
    if (pending) {
      this.#broker.dismiss(pending.id, "interrupt");
      this.#engine.interrupt();
      return permission ? "permission_denied" : "question_cancelled";
    }
    return this.#engine.interrupt() ? "turn_aborted" : "idle";
  }

  respond(requestId: string, response: Parameters<InteractionBroker["respond"]>[1]) {
    this.#assertOpen();
    return this.#broker.respond(requestId, response);
  }

  /** Run a shell command directly, outside the model, under the normal Bash tool rules. */
  async runShell(command: string): Promise<ShellResult> {
    this.#assertOpen();
    const result = await this.#inScope(() => bashTool.call({ command }, { ...this.#toolContext }));
    return { output: toolResultText(result.content), isError: result.isError === true };
  }

  stopBackgroundAgent(agentId: string): boolean {
    const owned = getAsyncAgentsForScope(this.scope.id).some((agent) => agent.agentId === agentId);
    return owned && killAsyncAgent(agentId);
  }

  /** Engine operations used by the permission and plugin managers. */
  engineCall<T>(fn: (engine: QueryEngine) => Promise<T>): Promise<T> {
    this.#assertOpen();
    return this.#inScope(() => fn(this.#engine));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#wake?.dispose();
    for (const resolve of this.#idleWaiters.splice(0)) resolve();
    this.#broker.dismissAll("closed");
    this.#engine.interrupt();
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
    this.hub.close();
    this.#init.onClosed(this.#sessionId);
  }

  async #runTurn(text: string, source: TurnSource): Promise<TurnResult> {
    const turnId = randomUUID();
    const { isLlmTriggering } = classifyUserInput(text);
    this.#turnId = turnId;
    this.#emit({ type: "turn_started", turnId, input: text, source, runsModel: isLlmTriggering });

    let outcome: { handled: boolean; reason?: TurnResult["reason"] };
    let toolTurns: number | undefined;
    try {
      // Open the turn before the engine adds the prompt, so its messages and
      // file-history snapshot share one id. Background wake-ups have no typed
      // prompt; the engine opens their turn itself.
      if (isLlmTriggering && text.length > 0) this.#engine.beginUserTurn();
      const run = this.#engine.submitMessage(text);
      for (;;) {
        const step = await run.next();
        if (step.done) {
          outcome = step.value;
          break;
        }
        if (step.value.type === "turn_complete") toolTurns = step.value.turnCount;
        await this.#onEngineEvent(step.value);
      }
      await this.#recorder?.flush();
    } catch (error) {
      await this.#recorder?.flush().catch(() => {});
      this.#endTurn();
      this.#continuation = null;
      this.#emit({ type: "turn_failed", turnId, error: serializeError(error) });
      throw error;
    }
    this.#endTurn();

    const continuation = this.#continuation;
    this.#continuation = null;
    this.#emit({
      type: "turn_completed",
      turnId,
      handled: outcome.handled,
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      ...(toolTurns !== undefined ? { toolTurns } : {}),
      ...(continuation ? { continuation: continuation.kind as TurnContinuation } : {}),
    });

    const result: TurnResult = {
      turnId,
      handled: outcome.handled,
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      ...(toolTurns !== undefined ? { toolTurns } : {}),
      followUps: [],
    };
    const followUp = await this.#runContinuation(continuation);
    if (followUp) result.followUps.push(followUp);
    return result;
  }

  /** Settle the turn's leftover requests. */
  #endTurn(): void {
    this.#broker.dismissAll("turn_end");
    this.#turnId = null;
  }

  async #runContinuation(continuation: PendingContinuation | null): Promise<TurnResult | null> {
    if (!continuation || this.#closed) return null;
    if (continuation.kind === "plan_followup") {
      const planContent = await readPlan();
      if (!planContent) return null;
      const prompt = this.#engine.clearContextAndImplement(planContent);
      this.#messages = [];
      await this.#recorder?.cleared();
      clearTodos(this.#sessionId);
      this.#emit({ type: "messages_changed", messages: [] });
      this.#emit({
        type: "notice",
        tone: "info",
        title: "Context cleared",
        body: "Starting fresh with the approved plan. Implementing...",
      });
      // Follow-ups are submitted like typed input, so they are trimmed too.
      return this.#runTurn(prompt.trim(), "plan_followup");
    }
    return this.#runTurn(
      `User rejected the plan. Feedback: ${continuation.feedback}\n\nPlease revise your plan based on this feedback.`.trim(),
      "feedback_followup",
    );
  }

  async #onEngineEvent(event: QueryEngineEvent): Promise<void> {
    switch (event.type) {
      case "text":
        this.#emit({ type: "text_delta", text: event.text });
        return;
      case "thinking_start":
        this.#emit({ type: "thinking_started" });
        return;
      case "thinking_delta":
        this.#emit({ type: "thinking_delta", thinking: event.thinking });
        return;
      case "thinking_done":
        this.#emit({
          type: "thinking_completed",
          thinking: event.thinking,
          ...(event.signature !== undefined ? { signature: event.signature } : {}),
        });
        return;
      case "redacted_thinking":
        this.#emit({ type: "redacted_thinking", data: event.data });
        return;
      case "tool_use_start": {
        const seeded = event.name === "Agent" ? getSubAgentProgress(event.id) : undefined;
        this.#emit({
          type: "tool_started",
          toolUseId: event.id,
          name: event.name,
          ...(seeded ? { subAgentProgress: seeded } : {}),
        });
        await this.#recorder?.toolStarted(event.name);
        return;
      }
      case "permission_request":
        // A record of a confirmation that already happened; the live request
        // went through `#onPermissionRequest`.
        return;
      case "tool_use_done":
        this.#emit({
          type: "tool_completed",
          toolUseId: event.id,
          name: event.name,
          input: event.input,
          result: event.result,
        });
        await this.#recorder?.toolCompleted(
          event.name,
          toolResultText(event.result.content).length,
          event.result.isError,
        );
        return;
      case "assistant_message":
        this.#emit({ type: "assistant_message", message: event.message });
        return;
      case "tool_result_message":
        this.#emit({ type: "tool_results", message: event.message });
        // The committed results replace the live cards; drop their progress.
        this.#clearToolProgress();
        return;
      case "messages_updated":
        this.#messages = event.messages;
        this.#emit({ type: "messages_changed", messages: event.messages });
        await this.#recorder?.sync(event.messages, this.#engine.getCurrentMessageId());
        return;
      case "usage_updated":
        this.#usage = {
          total: { ...event.totalUsage },
          turn: { ...event.turnUsage },
          lastCall: { ...event.lastCallUsage },
          context: this.#contextUsage(event.lastCallUsage),
        };
        this.#emit({ type: "usage_changed", usage: structuredClone(this.#usage) });
        await this.#recorder?.usage(event.turnUsage, event.totalUsage);
        return;
      case "command_progress":
        this.#emit({
          type: "command_progress",
          title: event.title,
          message: event.message,
          spinnerLabel: event.spinnerLabel,
        });
        return;
      case "command":
        this.#emit({ type: "command_output", kind: event.kind, message: event.message });
        await this.#recorder?.system(event.kind, event.message);
        return;
      case "notice":
        this.#emit({ type: "notice", tone: event.tone, title: event.title, body: event.body });
        return;
      case "resume_picker":
        this.#emit({ type: "command_view", view: { type: "resume_picker", sessions: event.sessions } });
        return;
      case "diff_view":
        this.#emit({ type: "command_view", view: { type: "diff", data: event.data } });
        return;
      case "memory_picker":
        this.#emit({ type: "command_view", view: { type: "memory_picker", items: event.items } });
        return;
      case "permissions_view":
        this.#emit({ type: "command_view", view: { type: "permissions", data: event.data } });
        return;
      case "plugin_view":
        this.#emit({ type: "command_view", view: { type: "plugins", data: event.data } });
        return;
      case "open_editor":
        this.#emit({ type: "editor_requested", filePath: event.filePath, label: event.label });
        return;
      case "compacted":
        this.#emit({
          type: "compacted",
          trigger: event.trigger,
          ...(event.summary !== undefined ? { summary: event.summary } : {}),
        });
        await this.#recorder?.compacted(event.trigger, this.#engine.getState().messages);
        return;
      case "model_changed":
        this.#model = event.model;
        this.#modelSource = event.source;
        this.#emit({ type: "model_changed", model: event.model, source: event.source });
        return;
      case "mode_changed":
      case "task_mode_changed":
        // Reported by the engine's mode callback and the task-mode store,
        // which also cover changes made by tools.
        return;
      case "session_cleared":
        this.#clearToolProgress();
        clearTodos(this.#sessionId);
        await this.#recorder?.cleared();
        this.#emit({ type: "session_cleared" });
        return;
      case "session_switched":
        await this.#switchSession(event.sessionId, event.messages, event.totalUsage, event.fileHistorySnapshots);
        return;
      case "token_warning":
        this.#emit({ type: "token_warning", warning: event.warning });
        return;
      case "api_retry":
        this.#emit({
          type: "api_retry",
          attempt: event.attempt,
          maxRetries: event.maxRetries,
          delayMs: event.delayMs,
          message: event.message,
        });
        return;
      case "stream_restart":
        this.#emit({ type: "stream_restart", reason: event.reason });
        return;
      case "error":
        this.#emit({ type: "error", message: event.error.message });
        await this.#recorder?.system("error", event.error.message);
        return;
      case "turn_complete":
      case "turn_usage":
        return;
    }
  }

  /** `/resume <id>` swapped the engine's conversation; rebind the session to it. */
  async #switchSession(
    sessionId: string,
    messages: MessageParam[],
    totalUsage: Usage,
    snapshots: FileHistorySnapshotRecord[],
  ): Promise<void> {
    const previous = this.#sessionId;
    this.#clearToolProgress();
    clearTodos(previous);
    this.#sessionId = sessionId;
    this.#messages = [...messages];
    this.#usage = { total: { ...totalUsage }, turn: null, lastCall: null, context: null };
    // The restored messages are already in the target session's file.
    this.#recorder?.rebase(this.#engine.getState().messages);
    if (this.#persist) {
      try {
        await configureFileHistory(this.cwd, sessionId);
        if (snapshots.length > 0) restoreFileHistorySnapshots(snapshots);
      } catch {
        // Checkpoints are best-effort; the conversation itself is already restored.
      }
    }
    this.#init.onSessionReplaced(previous, sessionId);
    this.#emit({ type: "session_replaced", sessionId, messages: [...messages], totalUsage: { ...totalUsage } });
    this.#emit({ type: "todos_changed", todos: getTodos(sessionId) });
    void this.#refreshTasks();
  }

  // ─── Permission and question bridges ────────────────────────────────────

  async #onPermissionRequest(request: PermissionRequest): Promise<PermissionDecision> {
    if (request.toolName !== "ExitPlanMode") {
      const response: PermissionResponse = await this.#broker.request<"permission">({
        kind: "permission",
        turnId: this.#turnId,
        toolName: request.toolName,
        input: request.input,
        summary: request.summary,
        risk: request.risk,
        ruleHint: request.ruleHint,
      });
      return response.decision;
    }

    const answered = this.#broker.isAnswered("plan_approval");
    const response: PlanApprovalResponse = await this.#broker.request<"plan_approval">({
      kind: "plan_approval",
      turnId: this.#turnId,
      toolName: request.toolName,
      input: request.input,
      summary: request.summary,
      risk: request.risk,
      ruleHint: request.ruleHint,
      planContent: answered ? await readPlan() : null,
      planFilePath: getPlanFilePath(),
    });
    return this.#applyPlanDecision(response);
  }

  #applyPlanDecision(response: PlanApprovalResponse): PermissionDecision {
    if (response.decision === "reject") {
      if (response.feedback) this.#continuation = { kind: "feedback_followup", feedback: response.feedback };
      return "deny";
    }
    // Clearing the context implies accepting edits unless the caller opts out:
    // the fresh implementation turn has no planning history to justify each edit.
    if (response.acceptEdits ?? response.clearContext === true) {
      this.#sessionRules.allow.push(...PLAN_ACCEPT_EDITS_RULES);
    }
    if (response.clearContext) {
      // Stop the loop right after ExitPlanMode runs so the model does not
      // start implementing in the planning context; the follow-up turn starts
      // from a clean conversation with the approved plan.
      this.#continuation = { kind: "plan_followup" };
      this.#engine.interrupt();
    }
    return "allow_once";
  }

  #createToolContext(): ToolContext {
    const controller = this;
    return {
      cwd: this.cwd,
      // A live getter: `/resume` changes the id after tools captured the context.
      get sessionId() {
        return controller.#sessionId;
      },
      requestUserQuestion: async (request: UserQuestionRequest): Promise<UserQuestionResponse | null> => {
        const response = await controller.#broker.request<"question">({
          kind: "question",
          turnId: controller.#turnId,
          questions: request.questions,
        });
        return "answers" in response ? { answers: response.answers } : null;
      },
    };
  }

  // ─── Store observers ────────────────────────────────────────────────────

  /**
   * Translate the stores tools publish into session events. Each listener runs
   * in this session's scope so its reads resolve to this session's state, and
   * global stores are filtered to this session's entries.
   */
  #observeStores(): void {
    const scoped =
      <A extends unknown[]>(fn: (...args: A) => void) =>
      (...args: A): void =>
        this.#inScope(() => fn(...args));
    const track = (unsubscribe: () => void): void => {
      this.#unsubscribers.push(unsubscribe);
    };

    track(
      subscribeToolStatus(
        scoped((toolUseId, status) =>
          this.#emit({ type: "tool_progress", toolUseId, progress: { kind: "status", status } }),
        ),
      ),
    );
    track(
      subscribeBashProgress(
        scoped((toolUseId, progress) =>
          this.#emit({ type: "tool_progress", toolUseId, progress: { kind: "bash", progress } }),
        ),
      ),
    );
    track(
      subscribeMcpProgress(
        scoped((toolUseId, progress) =>
          this.#emit({ type: "tool_progress", toolUseId, progress: { kind: "mcp", progress } }),
        ),
      ),
    );
    track(
      subscribeSubAgentProgress(
        scoped((toolUseId, progress) =>
          this.#emit({ type: "tool_progress", toolUseId, progress: { kind: "subagent", progress } }),
        ),
      ),
    );
    track(subscribeTaskMode(scoped((mode) => this.#emit({ type: "task_mode_changed", mode }))));
    track(
      subscribeTodos((sessionId, todos) => {
        if (sessionId === this.#sessionId) this.#emit({ type: "todos_changed", todos });
      }),
    );
    track(
      subscribeTasks(
        scoped((taskListId) => {
          if (taskListId === this.#taskListId()) void this.#refreshTasks();
        }),
      ),
    );
    track(subscribeActiveTeam(scoped(() => void this.#refreshTasks())));
    track(
      subscribeAsyncAgents((_agentId, snapshot) => {
        if (snapshot === null || snapshot.ownerScopeId === this.scope.id) {
          this.#emit({ type: "background_agents_changed", agents: this.#backgroundAgents() });
        }
      }),
    );
    if (this.#wake) {
      const wake = this.#wake;
      track(subscribePendingNotifications(() => wake.poke()));
      track(
        subscribeMailboxWrites(
          scoped((recipient, teamName) => {
            if (recipient === "team-lead" && getActiveTeam()?.teamName === teamName) wake.poke();
          }),
        ),
      );
    }
    void this.#refreshTasks();
  }

  #taskListId(): string {
    const team = getActiveTeam();
    return team ? getTeamTaskListId(team.teamName) : getTaskListId(this.#sessionId);
  }

  /** Re-read the task list from disk; stale reads are dropped. */
  async #refreshTasks(): Promise<void> {
    await this.#inScope(async () => {
      const taskListId = this.#taskListId();
      try {
        const tasks = await listTasks(taskListId);
        if (this.#closed || taskListId !== this.#taskListId()) return;
        this.#tasks = tasks;
        this.#emit({ type: "tasks_changed", tasks: [...tasks] });
      } catch {
        // A transient read error is retried by the next task mutation.
      }
    });
  }

  #backgroundAgents(): BackgroundAgentInfo[] {
    return getAsyncAgentsForScope(this.scope.id).map(
      ({ abortController: _abort, ownerScopeId: _owner, ...info }) => info,
    );
  }

  #hasQueuedBackgroundInput(): boolean {
    const team = getActiveTeam();
    return pendingNotificationCount() > 0 || (team !== null && hasPendingLeadMailboxSignal(team.teamName));
  }

  #clearToolProgress(): void {
    clearAllSubAgentProgress();
    clearAllBashProgress();
    clearAllMcpProgress();
    clearAllToolStatus();
  }

  #contextUsage(lastCallUsage: Usage): SessionUsage["context"] {
    const messages = this.#engine.getState().messages;
    const snapshot = buildTokenBudgetSnapshot(messages, {
      usage: lastCallUsage,
      usageAnchorIndex: messages.length > 0 ? messages.length - 1 : -1,
    });
    return {
      tokens: snapshot.estimatedConversationTokens,
      window: snapshot.contextWindow,
      percent: Math.round((snapshot.estimatedConversationTokens / snapshot.contextWindow) * 100),
    };
  }

  #emit(body: SessionEventBody): void {
    if (!this.#closed) this.hub.emit(body);
  }

  #inScope<T>(fn: () => T): T {
    return runInSessionScope(this.scope, fn);
  }

  #assertOpen(): void {
    if (this.#closed) throw new AgentSdkError("closed", "The session is closed.");
  }
}

function serializeError(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}

export type { InteractionRequest };
