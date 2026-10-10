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

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAllAgents } from "../agents/registry.js";
import { BUILTIN_COMMAND_NAMES } from "../commands/builtinCommandNames.js";
import { getAllUserCommands } from "../commands/userCommands/registry.js";
import { INTERACTIVE_MAX_TOOL_TURNS } from "../core/agenticLoop.js";
import { loadPermissionSettings, type PermissionSettings } from "../permissions/permissions.js";
import { refreshActivePlugins } from "../plugins/runtime.js";
import { getDefaultModel } from "../services/api/client.js";
import { resolveProfile } from "../services/api/providers/profile.js";
import { bootstrapMcp, connectAdditionalMcpServers } from "../services/mcp/bootstrap.js";
import { getAllUserInvocableSkills } from "../services/skills/registry.js";
import {
  appendTranscriptEntry,
  createSessionId,
  deleteSessionTranscript,
  initSessionStorage,
  isSessionPersistenceEnabled,
  isValidSessionId,
  listProjectSessions,
  restoreSession,
  type RestoredSession,
  writeSessionTitle,
} from "../session/storage.js";
import { getTaskListId, getTasksDir } from "../state/taskStore.js";
import { getEasyAgentHome } from "../utils/paths.js";
import { createSessionScope } from "../state/sessionScope.js";
import { getActiveOutputStyleName } from "../styles/registry.js";
import { logWarn } from "../utils/log.js";
import { readMergedStringSetting } from "../utils/settings.js";
import type { McpServerConfig } from "../types/mcp.js";
import { activateWorkspace, consoleLogger, loadWorkspace, type WorkspaceReport } from "./bootstrap.js";
import { checkModel, listModels, readConfig, setWorkspaceTrust, writeConfig } from "./config.js";
import { AgentSdkError } from "./errors.js";
import { approveMcpServer, reconnectMcpServer, reloadExtensions } from "./extensions.js";
import { buildRuntimeInventory } from "./inventory.js";
import { AgentSession, reloadSettingsOf } from "./session.js";
import { SessionController } from "./session/controller.js";
import type {
  AgentRuntimeOptions,
  AgentSessionOptions,
  ConfigScope,
  ConfigSnapshot,
  McpApprovalResult,
  McpReconnectResult,
  ModelCheckResult,
  ReloadResult,
  RuntimeCapabilities,
  RuntimeInventory,
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
    const restored = await this.#restore(sessionId);
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
    const restored = await this.#restore(sessionId);
    return { summary: restored.summary, messages: restored.messages };
  }

  /** Give a saved session a title; an empty title clears it. */
  async renameSession(sessionId: string, title: string): Promise<StoredSessionSummary> {
    this.#assertActive();
    this.#assertSessionId(sessionId);
    try {
      await writeSessionTitle(this.cwd, sessionId, title);
    } catch (error) {
      throw toStorageError(error, sessionId);
    }
    return (await this.readSession(sessionId)).summary;
  }

  /**
   * Delete a saved session: its transcript, title, file checkpoints, and task
   * list. An open session must be closed first.
   */
  async deleteSession(sessionId: string): Promise<void> {
    this.#assertActive();
    this.#assertSessionId(sessionId);
    if (this.#sessions.has(sessionId)) {
      throw new AgentSdkError("already_open", `Close session ${sessionId} before deleting it.`);
    }
    try {
      await deleteSessionTranscript(this.cwd, sessionId);
    } catch (error) {
      throw toStorageError(error, sessionId);
    }
    await Promise.all([
      fs.rm(path.join(getEasyAgentHome(), "file-history", sessionId), { recursive: true, force: true }),
      fs.rm(getTasksDir(getTaskListId(sessionId)), { recursive: true, force: true }),
    ]);
  }

  /**
   * Copy a saved session's conversation into a new session and return the
   * copy. The copy starts without file checkpoints, so `/rewind` cannot go
   * back past the fork.
   */
  async forkSession(sessionId: string, options: { title?: string } = {}): Promise<StoredSessionSummary> {
    this.#assertActive();
    const source = await this.#restore(sessionId);
    if (!isSessionPersistenceEnabled()) {
      throw new AgentSdkError("session_storage", "Session persistence is disabled (cleanupPeriodDays is 0).");
    }
    const forkId = createSessionId();
    const startedAt = new Date().toISOString();
    try {
      await initSessionStorage({
        sessionId: forkId,
        cwd: this.cwd,
        startedAt,
        updatedAt: startedAt,
        model: source.summary.model,
      });
      for (const message of source.messages) {
        await appendTranscriptEntry(this.cwd, forkId, {
          type: "message",
          timestamp: new Date().toISOString(),
          role: message.role === "assistant" ? "assistant" : "user",
          message,
        });
      }
      if (options.title?.trim()) await writeSessionTitle(this.cwd, forkId, options.title);
    } catch (error) {
      throw new AgentSdkError("session_storage", (error as Error).message, { cause: error });
    }
    return (await this.readSession(forkId)).summary;
  }

  /**
   * Connect MCP servers the caller supplies, in addition to the configured
   * ones; their tools are available to every session of the runtime. A name
   * that is already registered keeps its server and is reported as skipped.
   * Call after `startServices()` has finished.
   */
  async connectMcpServers(servers: Record<string, McpServerConfig>): Promise<{ added: string[]; skipped: string[] }> {
    this.#assertActive();
    const scoped = Object.fromEntries(
      Object.entries(servers).map(([name, config]) => [name, { ...config, scope: "flag" as const }]),
    );
    return connectAdditionalMcpServers(scoped);
  }

  /**
   * Whether requests for the model have credentials: an API key or auth
   * header from the model profile or the environment, or a custom endpoint
   * (profile `baseURL` or `ANTHROPIC_BASE_URL`) that may accept none. False
   * means the provider's default endpoint without a key.
   */
  async hasModelCredentials(model?: string): Promise<boolean> {
    const profile = await resolveProfile(model ?? (await this.resolveModel()), this.cwd);
    if (profile.apiKey || profile.baseURL) return true;
    const authHeaders =
      profile.protocol === "gemini" ? ["x-goog-api-key", "authorization"] : ["x-api-key", "authorization"];
    if (
      Object.entries(profile.headers ?? {}).some(
        ([name, value]) => authHeaders.includes(name.toLowerCase()) && value.trim(),
      )
    ) {
      return true;
    }
    const env = process.env;
    return (
      profile.protocol === "anthropic" &&
      Boolean(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || env.ANTHROPIC_BASE_URL)
    );
  }

  // ─── Settings ───────────────────────────────────────────────────────────

  /** Every settings source, the effective value of each key and where it came from, and the model profiles. */
  readConfig(): Promise<ConfigSnapshot> {
    this.#assertActive();
    return readConfig(this.cwd);
  }

  /**
   * Set one top-level setting in a user, project, or local file, or delete it
   * with `null`. Validated before writing; open sessions pick up permission
   * rules and mode right away, other keys per the returned `reload`.
   */
  async writeConfig(scope: ConfigScope, key: string, value: unknown): Promise<{ reload: string }> {
    this.#assertActive();
    const result = await writeConfig(this.cwd, scope, key, value);
    await Promise.all(this.listOpenSessions().map((session) => reloadSettingsOf(session)));
    return result;
  }

  /** Save or revoke workspace trust. Trust is applied when a runtime starts, so restart to use it. */
  setWorkspaceTrust(trusted: boolean): Promise<{ trusted: boolean }> {
    this.#assertActive();
    return setWorkspaceTrust(this.cwd, trusted);
  }

  /** Send the smallest possible request with a model handle and report whether it went through. */
  checkModel(model: string): Promise<ModelCheckResult> {
    this.#assertActive();
    return checkModel(this.cwd, model);
  }

  /** Model ids offered by the provider behind a model handle. */
  listModels(model: string): Promise<{ models: string[] }> {
    this.#assertActive();
    return listModels(this.cwd, model);
  }

  // ─── Extensions ─────────────────────────────────────────────────────────

  /**
   * Skills, commands, sub-agents, output styles, MCP servers, plugins, hooks,
   * rule files, and tools, each with its source, state, and token estimate.
   */
  async getInventory(): Promise<RuntimeInventory> {
    this.#assertActive();
    return buildRuntimeInventory(this.cwd, this.report, await this.resolveModel());
  }

  /** Reload skills, commands, sub-agents, output styles, and plugins; open sessions use them from their next turn. */
  reload(): Promise<ReloadResult> {
    this.#assertActive();
    return reloadExtensions(this.cwd);
  }

  /**
   * Approve or reject a `.mcp.json` server in a trusted workspace. The decision
   * is saved in `scope` (default `local`); an approved server connects now.
   */
  approveMcpServer(name: string, approved: boolean, scope: ConfigScope = "local"): Promise<McpApprovalResult> {
    this.#assertActive();
    return approveMcpServer(this.cwd, name, approved, scope);
  }

  /** Reconnect a registered MCP server and report the new state. */
  reconnectMcpServer(name: string): Promise<McpReconnectResult> {
    this.#assertActive();
    return reconnectMcpServer(name);
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

  async #restore(sessionId?: string): Promise<RestoredSession> {
    if (sessionId !== undefined) this.#assertSessionId(sessionId);
    try {
      return await restoreSession(this.cwd, sessionId);
    } catch (error) {
      throw toStorageError(error, sessionId, "session_restore");
    }
  }

  #assertSessionId(sessionId: string): void {
    if (!isValidSessionId(sessionId)) {
      throw new AgentSdkError("invalid_argument", `Not a session id: ${JSON.stringify(sessionId)}`);
    }
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

/** A missing transcript is `not_found`; anything else keeps the caller's code. */
function toStorageError(
  error: unknown,
  sessionId: string | undefined,
  fallback: "session_restore" | "session_storage" = "session_storage",
): AgentSdkError {
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
    return new AgentSdkError("not_found", `No saved session ${sessionId ?? ""}`.trim() + ".", { cause: error });
  }
  return new AgentSdkError(fallback, (error as Error).message, { cause: error });
}
