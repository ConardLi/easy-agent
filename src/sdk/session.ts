/**
 * AgentSession — the handle frontends use to drive one conversation.
 *
 * A handle's `id` never changes. When `/resume <id>` moves the conversation
 * to another saved session, the runtime hands out a new handle for the new id
 * and this one emits `session_replaced`; existing subscriptions keep
 * receiving events, while calls on the old handle fail with `replaced`.
 */

import type { PermissionsViewData, PluginMutation, PluginViewData } from "../core/queryEngine.js";
import type { SettingSource } from "../config/sources.js";
import type { PluginInstallPreview } from "../plugins/install.js";
import { runInSessionScope } from "../state/sessionScope.js";
import { AgentSdkError } from "./errors.js";
import type { SessionController } from "./session/controller.js";
import type {
  EffortLevel,
  InteractionResponse,
  InterruptOutcome,
  PermissionMode,
  RespondOutcome,
  SendOptions,
  SessionEvent,
  SessionEventListener,
  SessionState,
  ShellResult,
  ThinkingSetting,
  TurnResult,
} from "./types.js";

const controllers = new WeakMap<AgentSession, SessionController>();

/**
 * @internal Run `fn` inside the session's scope, as tools of that session do.
 * Not part of the public SDK surface; used by tests that prepare
 * session-scoped state such as the plan file.
 */
export function runInScopeOf<T>(session: AgentSession, fn: () => T): T {
  const controller = controllers.get(session);
  if (!controller) throw new TypeError("Not an AgentSession.");
  return runInSessionScope(controller.scope, fn);
}

export class AgentSession {
  readonly id: string;
  readonly #controller: SessionController;
  #replacedBy: string | null = null;

  /** @internal Created by AgentRuntime. */
  constructor(id: string, controller: SessionController) {
    this.id = id;
    this.#controller = controller;
    controllers.set(this, controller);
  }

  get cwd(): string {
    return this.#controller.cwd;
  }

  /** Id of the session that replaced this one, if `/resume` switched away. */
  get replacedBy(): string | null {
    return this.#replacedBy;
  }

  get closed(): boolean {
    return this.#controller.closed;
  }

  getState(): SessionState {
    return this.#controller.getState();
  }

  /**
   * Run one turn. Plain text goes to the model; `/command` input runs a local
   * command, a skill, or a user command. Resolves when the turn and any
   * follow-up turns it triggered have finished.
   */
  async send(input: string, options?: SendOptions): Promise<TurnResult> {
    return this.#active().send(input, options);
  }

  /** Resolves once no turn is running; pair with `send()` to queue input. */
  waitForIdle(): Promise<void> {
    return this.#controller.waitForIdle();
  }

  /**
   * Deny the pending permission request, cancel the pending question, or
   * abort the running turn, in that order of precedence.
   */
  interrupt(): InterruptOutcome {
    return this.#active().interrupt();
  }

  respond(requestId: string, response: InteractionResponse): RespondOutcome {
    return this.#active().respond(requestId, response);
  }

  /** Run a local slash command, e.g. `runCommand("compact", ["focus on tests"])`. */
  runCommand(name: string, args: readonly string[] = []): Promise<TurnResult> {
    return this.send(["/" + name, ...args].join(" "));
  }

  /** Switch the permission mode now, also while a turn runs; the next tool call uses it. */
  setPermissionMode(mode: PermissionMode): void {
    this.#active().setPermissionMode(mode);
  }

  /** Switch the model for this session now, also while a turn runs; `"default"` clears the override. */
  setModel(model: string): void {
    this.#active().setModel(model);
  }

  /** Turn extended thinking on (adaptive where the model supports it), off, or to a token budget. */
  setThinking(setting: ThinkingSetting): void {
    this.#active().setThinking(setting);
  }

  /** Set the reasoning effort for this session; null leaves it to the model. */
  setEffort(effort: EffortLevel | null): void {
    this.#active().setEffort(effort);
  }

  /** Run a shell command without the model. Bash permission and sandbox rules still apply. */
  async runShell(command: string): Promise<ShellResult> {
    return this.#active().runShell(command);
  }

  /** Stop a background agent this session launched. */
  stopBackgroundAgent(agentId: string): boolean {
    return this.#active().stopBackgroundAgent(agentId);
  }

  /** Names of the tools the model is offered in the current mode. */
  getToolNames(): string[] {
    return this.#active().getToolNames();
  }

  async getPermissionsView(): Promise<PermissionsViewData> {
    return this.#active().engineCall((engine) => engine.getPermissionsView());
  }

  async mutatePermissionRule(
    op: "allow" | "deny" | "remove",
    rule: string,
    scope: SettingSource,
  ): Promise<PermissionsViewData> {
    return this.#active().engineCall((engine) => engine.mutatePermissionRule(op, rule, scope));
  }

  async mutatePlugin(action: PluginMutation): Promise<PluginViewData> {
    return this.#active().engineCall((engine) => engine.mutatePlugin(action));
  }

  async previewPlugin(pluginId: string): Promise<PluginInstallPreview> {
    return this.#active().engineCall((engine) => engine.previewPlugin(pluginId));
  }

  async refreshPluginView(): Promise<PluginViewData> {
    return this.#active().engineCall((engine) => engine.refreshPluginView());
  }

  /** Receive every event, starting with a `state_snapshot`. Returns an unsubscribe function. */
  subscribe(listener: SessionEventListener): () => void {
    return this.#controller.hub.subscribe(listener);
  }

  /** The event stream as an async iterator; ends when the session closes or `signal` aborts. */
  events(signal?: AbortSignal): AsyncIterableIterator<SessionEvent> {
    return this.#controller.hub.stream(signal);
  }

  /** Stop the running turn, settle pending requests, and release the session. */
  close(): Promise<void> {
    // A replaced handle no longer owns the conversation; its successor does.
    if (this.#replacedBy !== null) return Promise.resolve();
    return this.#controller.close();
  }

  /** @internal */
  markReplaced(sessionId: string): void {
    this.#replacedBy = sessionId;
  }

  #active(): SessionController {
    if (this.#replacedBy !== null) {
      throw new AgentSdkError("replaced", `Session ${this.id} was replaced by ${this.#replacedBy}.`);
    }
    return this.#controller;
  }
}
