/**
 * AgentRuntime — the workspace-level entry point of the session SDK.
 *
 * One runtime serves one workspace and may hold several sessions at once.
 * Creating it runs the workspace bootstrap (trust, environment, registries,
 * execution settings); sessions created from it share those registries and
 * keep their conversation state in their own session scopes.
 *
 * Settings layers, the workspace `.env`, and the registries are process-wide,
 * so a process runs one runtime at a time. Frontends that serve several
 * workspaces run one process per workspace.
 */

import * as path from "node:path";
import { getAllAgents } from "../agents/registry.js";
import { BUILTIN_COMMAND_NAMES } from "../commands/builtinCommandNames.js";
import { getAllUserCommands } from "../commands/userCommands/registry.js";
import { INTERACTIVE_MAX_TOOL_TURNS } from "../core/agenticLoop.js";
import { loadPermissionSettings, type PermissionSettings } from "../permissions/permissions.js";
import { refreshActivePlugins } from "../plugins/runtime.js";
import { getDefaultModel } from "../services/api/client.js";
import { bootstrapMcp } from "../services/mcp/bootstrap.js";
import { getAllUserInvocableSkills } from "../services/skills/registry.js";
import {
  createSessionId,
  initSessionStorage,
  listProjectSessions,
  restoreSession,
  type RestoredSession,
} from "../session/storage.js";
import { createSessionScope } from "../state/sessionScope.js";
import { getActiveOutputStyleName } from "../styles/registry.js";
import { logWarn } from "../utils/log.js";
import { readMergedStringSetting } from "../utils/settings.js";
import { activateWorkspace, consoleLogger, loadWorkspace, type WorkspaceReport } from "./bootstrap.js";
import { AgentSdkError } from "./errors.js";
import { AgentSession } from "./session.js";
import { SessionController } from "./session/controller.js";
import type {
  AgentRuntimeOptions,
  AgentSessionOptions,
  RuntimeCapabilities,
  RuntimeLogger,
  StartServicesOptions,
  StoredSession,
  StoredSessionSummary,
} from "./types.js";

/** Tool-turn default interactive frontends use; scripts keep the loop's lower default. */
export const INTERACTIVE_DEFAULT_MAX_TURNS = INTERACTIVE_MAX_TOOL_TURNS;

let activeRuntime: AgentRuntime | null = null;
let bootstrapping = false;

export class AgentRuntime {
  readonly cwd: string;
  readonly report: WorkspaceReport;
  readonly #options: AgentRuntimeOptions;
  readonly #logger: RuntimeLogger;
  readonly #sessions = new Map<string, AgentSession>();
  #disposed = false;

  /** @internal Use `createAgentRuntime()`. */
  constructor(options: AgentRuntimeOptions, report: WorkspaceReport) {
    this.cwd = options.cwd;
    this.report = report;
    this.#options = options;
    this.#logger = options.logger ?? consoleLogger;
  }

  /**
   * Bring up MCP servers and plugin services. Awaited startup reports
   * failures to the logger; background startup reports them as warnings.
   */
  async startServices(options: StartServicesOptions = {}): Promise<void> {
    this.#assertActive();
    const { mcpServers = true, wait = true } = options;
    const pluginDirs = [...(this.#options.pluginDirs ?? [])];
    const message = (error: unknown): string => (error as Error).message;
    if (wait) {
      if (mcpServers) {
        await bootstrapMcp(this.cwd).catch((error) => {
          this.#logger.error(`[easy-agent] MCP bootstrap failed: ${message(error)}`);
        });
      }
      await refreshActivePlugins(this.cwd, { pluginDirs }).catch((error) => {
        this.#logger.error(`[easy-agent] plugin services bootstrap failed: ${message(error)}`);
      });
      return;
    }
    // Slow servers (an `npx` cold start can take tens of seconds) must not
    // block the first frame; their tools appear once they connect.
    if (mcpServers) {
      void bootstrapMcp(this.cwd).catch((error) => {
        logWarn(`MCP bootstrap failed: ${message(error)}`);
      });
    }
    void refreshActivePlugins(this.cwd, { pluginDirs }).catch((error) => {
      logWarn(`plugin MCP bootstrap failed: ${message(error)}`);
    });
  }

  /** The model handle sessions use when none is given: `model`, then `defaultModel`, then the built-in default. */
  async resolveModel(): Promise<string> {
    return (
      (await readMergedStringSetting(this.cwd, "model").catch(() => undefined)) ??
      (await readMergedStringSetting(this.cwd, "defaultModel").catch(() => undefined)) ??
      getDefaultModel()
    );
  }

  async createSession(options: AgentSessionOptions = {}): Promise<AgentSession> {
    this.#assertActive();
    const permissionSettings = await this.#loadPermissionSettings();
    const model = options.model ?? (await this.resolveModel());
    const sessionId = createSessionId();
    if (options.persist !== false) {
      const startedAt = new Date().toISOString();
      try {
        await initSessionStorage({ sessionId, cwd: this.cwd, startedAt, updatedAt: startedAt, model });
      } catch (error) {
        throw new AgentSdkError("session_storage", (error as Error).message, { cause: error });
      }
    }
    return this.#open({
      sessionId,
      model,
      options,
      permissionSettings,
      restored: null,
    });
  }

  /** Reopen a saved session; without an id, the most recent one. */
  async resumeSession(sessionId?: string, options: AgentSessionOptions = {}): Promise<AgentSession> {
    this.#assertActive();
    const permissionSettings = await this.#loadPermissionSettings();
    let restored: RestoredSession;
    try {
      restored = await restoreSession(this.cwd, sessionId);
    } catch (error) {
      throw new AgentSdkError("session_restore", (error as Error).message, { cause: error });
    }
    if (this.#sessions.has(restored.summary.sessionId)) {
      throw new AgentSdkError("already_open", `Session ${restored.summary.sessionId} is already open.`);
    }
    const model = options.model ?? (await this.resolveModel());
    return this.#open({
      sessionId: restored.summary.sessionId,
      model,
      options,
      permissionSettings,
      restored,
    });
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.#sessions.get(sessionId);
  }

  /** Sessions currently open in this runtime. */
  listOpenSessions(): AgentSession[] {
    return [...this.#sessions.values()];
  }

  /** Saved sessions of this workspace, most recent first. */
  listSessions(limit?: number): Promise<StoredSessionSummary[]> {
    return listProjectSessions(this.cwd, limit);
  }

  /** Read a saved session without opening it. */
  async readSession(sessionId: string): Promise<StoredSession> {
    const restored = await restoreSession(this.cwd, sessionId);
    return { summary: restored.summary, messages: restored.messages };
  }

  getCapabilities(): RuntimeCapabilities {
    return {
      builtinCommands: [...BUILTIN_COMMAND_NAMES].sort(),
      skills: getAllUserInvocableSkills().map(({ name, description }) => ({ name, description })),
      userCommands: getAllUserCommands().map(({ name, description }) => ({ name, description })),
      agents: getAllAgents().map((agent) => agent.agentType),
      outputStyle: getActiveOutputStyleName(),
    };
  }

  /** Close every open session and release the process for another runtime. */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    await Promise.all([...this.#sessions.values()].map((session) => session.close()));
    this.#disposed = true;
    if (activeRuntime === this) activeRuntime = null;
  }

  async #loadPermissionSettings(): Promise<PermissionSettings> {
    try {
      return await loadPermissionSettings(this.cwd);
    } catch (error) {
      throw new AgentSdkError("permission_settings", (error as Error).message, { cause: error });
    }
  }

  async #open(params: {
    sessionId: string;
    model: string;
    options: AgentSessionOptions;
    permissionSettings: PermissionSettings;
    restored: RestoredSession | null;
  }): Promise<AgentSession> {
    const controller = await SessionController.create({
      scope: createSessionScope(),
      cwd: this.cwd,
      sessionId: params.sessionId,
      model: params.model,
      options: params.options,
      permissionSettings: params.permissionSettings,
      initialMessages: params.restored?.messages ?? [],
      initialUsage: params.restored?.summary.totalUsage ?? { input_tokens: 0, output_tokens: 0 },
      fileHistorySnapshots: params.restored?.fileHistorySnapshots ?? [],
      onSessionReplaced: (previousId, nextId) => {
        this.#sessions.get(previousId)?.markReplaced(nextId);
        this.#sessions.delete(previousId);
        this.#sessions.set(nextId, new AgentSession(nextId, controller));
      },
      onClosed: (sessionId) => {
        this.#sessions.delete(sessionId);
      },
    });
    const session = new AgentSession(params.sessionId, controller);
    this.#sessions.set(params.sessionId, session);
    return session;
  }

  #assertActive(): void {
    if (this.#disposed) throw new AgentSdkError("closed", "The runtime was disposed.");
  }
}

/**
 * Bootstrap a workspace and return its runtime. Rejects when another runtime
 * is still active in this process.
 */
export async function createAgentRuntime(options: AgentRuntimeOptions): Promise<AgentRuntime> {
  if (!path.isAbsolute(options.cwd)) throw new TypeError("AgentRuntimeOptions.cwd must be an absolute path.");
  if (activeRuntime || bootstrapping) {
    throw new AgentSdkError("runtime_active", "Another runtime is already active in this process.");
  }
  bootstrapping = true;
  let runtime: AgentRuntime;
  try {
    const report = await loadWorkspace(options);
    await activateWorkspace(options);
    runtime = new AgentRuntime(options, report);
    activeRuntime = runtime;
  } finally {
    bootstrapping = false;
  }
  if (options.services !== false) await runtime.startServices(options.services ?? {});
  return runtime;
}
