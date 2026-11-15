/** MCP transport lifecycle and connection cache. */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  ConnectedMcpServer,
  McpHTTPServerConfig,
  McpSSEServerConfig,
  McpServerConnection,
  ScopedMcpServerConfig,
} from "../../types/mcp.js";
import { debugLog, logWarn } from "../../utils/log.js";
import { CLIENT_NAME, USER_AGENT, VERSION } from "../../version.js";
import { createMcpAuthSession, type McpAuthSession } from "./oauth.js";
import { createMcpFetch } from "./remoteHeaders.js";
import {
  bindRuntimeScope,
  currentRuntimeScope,
  defineRuntimeState,
  runInRuntimeScope,
  runtimeScopeClosed,
} from "../../state/runtimeScope.js";

// ─── Connect timeout ─────────────────────────────────────────────────

const CONNECT_TIMEOUT_MS = 30_000;

function getConnectTimeoutMs(): number {
  const env = parseInt(process.env.MCP_CONNECT_TIMEOUT || "", 10);
  return Number.isFinite(env) && env > 0 ? env : CONNECT_TIMEOUT_MS;
}

// ─── Connection cache ────────────────────────────────────────────────

/** Include every connection-affecting setting in the cache key. */
function getCacheKey(name: string, config: ScopedMcpServerConfig): string {
  if (config.type === "http" || config.type === "sse") {
    return `${name}:${JSON.stringify({
      type: config.type,
      url: config.url,
      headers: config.headers,
      headersEnv: config.headersEnv,
      headersHelper: config.headersHelper,
      oauth: config.oauth,
    })}`;
  }
  return `${name}:${JSON.stringify({
    type: "stdio",
    command: config.command,
    args: config.args,
    env: config.env,
  })}`;
}

interface ConnectionListeners {
  onUnexpectedClose?: (name: string, config: ScopedMcpServerConfig) => void;
  onAuthorized?: (name: string, config: ScopedMcpServerConfig) => void;
  onReconnectRequested?: (name: string) => Promise<McpServerConnection | null>;
}

interface McpClientState {
  connectionCache: Map<string, Promise<McpServerConnection>>;
  activeConnections: Map<string, ConnectedMcpServer>;
  pendingAuthorizations: Map<string, McpAuthSession>;
  attempts: Map<string, AbortController>;
  listeners: ConnectionListeners;
  processCleanup?: () => Promise<void>;
}

const state = defineRuntimeState<McpClientState>(
  "mcpClient",
  () => ({
    connectionCache: new Map<string, Promise<McpServerConnection>>(),
    activeConnections: new Map<string, ConnectedMcpServer>(),
    pendingAuthorizations: new Map<string, McpAuthSession>(),
    attempts: new Map<string, AbortController>(),
    listeners: {} as ConnectionListeners,
    processCleanup: undefined as (() => Promise<void>) | undefined,
  }),
  closeConnections,
);

async function closeConnections(owner: McpClientState): Promise<void> {
  owner.listeners = {};
  for (const attempt of owner.attempts.values()) attempt.abort();
  const pending = [...owner.connectionCache.values()];
  const connected = [...owner.activeConnections.values()];
  owner.connectionCache.clear();
  owner.activeConnections.clear();
  owner.attempts.clear();
  for (const auth of owner.pendingAuthorizations.values()) auth.close();
  owner.pendingAuthorizations.clear();
  if (owner.processCleanup) processCleanups.delete(owner.processCleanup);
  owner.processCleanup = undefined;
  await Promise.allSettled([
    ...connected.map((connection) => connection.cleanup()),
    ...pending.map(async (attempt) => {
      const connection = await attempt;
      if (connection.type === "connected") await connection.cleanup();
    }),
  ]);
}

export function setMcpConnectionListeners(listeners: ConnectionListeners): void {
  state().listeners = {
    onUnexpectedClose: listeners.onUnexpectedClose && bindRuntimeScope(listeners.onUnexpectedClose),
    onAuthorized: listeners.onAuthorized && bindRuntimeScope(listeners.onAuthorized),
    onReconnectRequested: listeners.onReconnectRequested && bindRuntimeScope(listeners.onReconnectRequested),
  };
}

export async function requestMcpReconnect(name: string): Promise<McpServerConnection | null> {
  return runtimeScopeClosed() ? null : (state().listeners.onReconnectRequested?.(name) ?? null);
}

// ─── Cleanup helpers ─────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Stop a stdio server without delaying CLI shutdown indefinitely. */
async function escalatedKill(name: string, pid: number | undefined): Promise<void> {
  if (!pid) return;
  const aliveCheck = (): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  try {
    process.kill(pid, "SIGINT");
  } catch (error) {
    debugLog("mcp", `[${name}] SIGINT failed: ${(error as Error).message}`);
    return;
  }
  await sleep(100);
  if (!aliveCheck()) return;

  debugLog("mcp", `[${name}] SIGINT didn't exit; sending SIGTERM`);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  await sleep(400);
  if (!aliveCheck()) return;

  debugLog("mcp", `[${name}] SIGTERM didn't exit; sending SIGKILL`);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already dead */
  }
}

// ─── connectToServer ─────────────────────────────────────────────────

/** Share concurrent connection attempts for the same server configuration. */
export function connectToServer(name: string, config: ScopedMcpServerConfig): Promise<McpServerConnection> {
  if (runtimeScopeClosed()) return Promise.resolve({ name, config, type: "failed", error: "The runtime is closed." });
  registerMcpProcessCleanup();
  const owner = state();
  const { connectionCache, activeConnections } = owner;
  const key = getCacheKey(name, config);
  const cached = connectionCache.get(key);
  if (cached) return cached;

  const abort = new AbortController();
  owner.attempts.set(key, abort);
  const promise = runInRuntimeScope(currentRuntimeScope(), () => doConnect(name, config, abort.signal));
  connectionCache.set(key, promise);

  void promise
    .then(async (conn) => {
      if (owner.attempts.get(key) === abort) owner.attempts.delete(key);
      if (conn.type === "connected" && !abort.signal.aborted && connectionCache.get(key) === promise) {
        activeConnections.set(name, conn);
      } else if (conn.type === "connected") {
        await conn.cleanup();
      }
    })
    .catch((error) => debugLog("mcp", `[${name}] connection cleanup failed: ${(error as Error).message}`));

  return promise;
}

/** Transport and its cleanup action. */
interface TransportBundle {
  transport: Transport;
  /** Diagnostic prefix for this transport (e.g. "stdio: npx -y …"). */
  describe: string;
  /** Buffered stderr — only stdio populates this. */
  collectStderrTail: () => string;
  /** Run before closing the MCP client. */
  preCleanup: () => Promise<void>;
  auth?: McpAuthSession;
}

function createStdioTransport(
  name: string,
  config: import("../../types/mcp.js").McpStdioServerConfig & { scope: string },
): TransportBundle {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: {
      ...(process.env as Record<string, string>),
      ...(config.env ?? {}),
    },
    stderr: "pipe",
  });

  let stderrBuf = "";
  if (transport.stderr) {
    transport.stderr.on("data", (chunk: Buffer) => {
      if (stderrBuf.length < 64 * 1024) {
        stderrBuf += chunk.toString();
      }
    });
  }

  return {
    transport,
    describe: `stdio: ${config.command} ${(config.args ?? []).join(" ")}`.trim(),
    collectStderrTail: () => stderrBuf,
    preCleanup: async () => {
      const pid: number | undefined = (transport as { pid?: number }).pid;
      await escalatedKill(name, pid);
    },
  };
}

async function createHttpTransport(
  name: string,
  config: McpHTTPServerConfig & { scope: string },
): Promise<TransportBundle> {
  const auth = await createMcpAuthSession(name, config.url, config.oauth);
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: { "User-Agent": USER_AGENT } },
    fetch: createMcpFetch(config),
    authProvider: auth?.provider,
  });
  return {
    transport,
    describe: `http: ${config.url}`,
    collectStderrTail: () => "",
    preCleanup: async () => {
      auth?.close();
    },
    auth,
  };
}

async function createSseTransport(
  name: string,
  config: McpSSEServerConfig & { scope: string },
): Promise<TransportBundle> {
  const auth = await createMcpAuthSession(name, config.url, config.oauth);
  const transport = new SSEClientTransport(new URL(config.url), {
    requestInit: { headers: { "User-Agent": USER_AGENT } },
    fetch: createMcpFetch(config),
    authProvider: auth?.provider,
  });
  return {
    transport,
    describe: `sse: ${config.url}`,
    collectStderrTail: () => "",
    preCleanup: async () => {
      auth?.close();
    },
    auth,
  };
}

async function doConnect(
  name: string,
  config: ScopedMcpServerConfig,
  signal: AbortSignal,
): Promise<McpServerConnection> {
  const owner = state();
  const { activeConnections, connectionCache, pendingAuthorizations } = owner;
  const summary =
    config.type === "http" || config.type === "sse"
      ? `${config.type} ${config.url}`
      : `stdio ${config.command} ${(config.args ?? []).join(" ")}`.trim();
  debugLog("mcp", `[${name}] connecting (${summary})`);

  let bundle: TransportBundle;
  try {
    if (config.type === "http") {
      bundle = await createHttpTransport(name, config);
    } else if (config.type === "sse") {
      bundle = await createSseTransport(name, config);
    } else {
      bundle = createStdioTransport(name, config);
    }
  } catch (error) {
    const err = (error as Error).message;
    logWarn(`MCP server '${name}' failed to initialize transport: ${err}`);
    return { name, type: "failed", config, error: err };
  }

  const client = new Client({ name: CLIENT_NAME, version: VERSION }, { capabilities: {} });
  const timeoutMs = getConnectTimeoutMs();

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let cancel!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new Error("MCP connection cancelled."));
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
  // A transport may finish initializing after its owner closed.
  const connectPromise = signal.aborted ? cancelled : client.connect(bundle.transport);
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`MCP server '${name}' connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    await Promise.race([connectPromise, timeoutPromise, cancelled]);
  } catch (error) {
    signal.removeEventListener("abort", cancel);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const errMsg = (error as Error).message;
    const interactive = bundle.auth?.interactive;
    const authorizationUrl =
      !signal.aborted && error instanceof UnauthorizedError ? interactive?.pendingAuthorizationUrl : undefined;
    if (authorizationUrl && interactive && "finishAuth" in bundle.transport) {
      const key = getCacheKey(name, config);
      if (bundle.auth) pendingAuthorizations.set(key, bundle.auth);
      logWarn(`MCP server '${name}' requires authorization. Open: ${authorizationUrl}`);
      const transport = bundle.transport as StreamableHTTPClientTransport | SSEClientTransport;
      void interactive
        .waitForCode()
        .then(async (code) => {
          if (pendingAuthorizations.get(key) !== bundle.auth) return;
          await transport.finishAuth(code);
          if (pendingAuthorizations.get(key) !== bundle.auth) return;
          if (pendingAuthorizations.get(key) === bundle.auth) pendingAuthorizations.delete(key);
          bundle.auth?.close();
          owner.listeners.onAuthorized?.(name, config);
        })
        .catch((authError) => {
          logWarn(`MCP server '${name}' authorization failed: ${(authError as Error).message}`);
          if (pendingAuthorizations.get(key) === bundle.auth) pendingAuthorizations.delete(key);
          bundle.auth?.close();
        });
    } else {
      bundle.auth?.close();
    }
    const stderrTail = bundle.collectStderrTail();
    const detail = stderrTail ? `${errMsg} (stderr: ${stderrTail.slice(0, 200).trim()})` : errMsg;
    if (!authorizationUrl && !signal.aborted) logWarn(`MCP server '${name}' failed to connect: ${detail}`);
    try {
      await bundle.transport.close();
    } catch {
      /* best-effort */
    }
    return {
      name,
      type: "failed",
      config,
      error: authorizationUrl ? `Authorization required: ${authorizationUrl}` : detail,
    };
  }
  signal.removeEventListener("abort", cancel);
  if (timeoutHandle) clearTimeout(timeoutHandle);

  const capabilities = client.getServerCapabilities();
  const serverVersion = client.getServerVersion();
  debugLog(
    "mcp",
    `[${name}] connected via ${bundle.describe} (server=${serverVersion?.name ?? "?"} v${serverVersion?.version ?? "?"} caps=${JSON.stringify(
      {
        tools: !!capabilities?.tools,
        resources: !!capabilities?.resources,
        prompts: !!capabilities?.prompts,
      },
    )})`,
  );

  let cleaned = false;
  const interactive = bundle.auth?.interactive;
  if (interactive && "finishAuth" in bundle.transport) {
    const transport = bundle.transport as StreamableHTTPClientTransport | SSEClientTransport;
    void interactive
      .waitForCode()
      .then(async (code) => {
        if (cleaned) return;
        await transport.finishAuth(code);
        if (!cleaned) owner.listeners.onAuthorized?.(name, config);
      })
      .catch((error) => {
        logWarn(`MCP server '${name}' authorization failed: ${(error as Error).message}`);
      });
  }
  client.onclose = bindRuntimeScope(() => {
    if (cleaned) return;
    if (activeConnections.get(name)?.client !== client) return;
    connectionCache.delete(getCacheKey(name, config));
    activeConnections.delete(name);
    void cleanup().catch((error) =>
      debugLog("mcp", `[${name}] cleanup after disconnect failed: ${(error as Error).message}`),
    );
    owner.listeners.onUnexpectedClose?.(name, config);
  });
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    // A stale connection must not unregister its replacement.
    if (activeConnections.get(name)?.client === client) {
      activeConnections.delete(name);
      connectionCache.delete(getCacheKey(name, config));
    }
    await bundle.preCleanup();
    try {
      await client.close();
    } catch (error) {
      debugLog("mcp", `[${name}] client.close error: ${(error as Error).message}`);
    }
  };

  return {
    name,
    type: "connected",
    client,
    capabilities,
    serverInfo: serverVersion ? { name: serverVersion.name ?? name, version: serverVersion.version ?? "?" } : undefined,
    config,
    sessionId: config.type === "http" ? () => (bundle.transport as StreamableHTTPClientTransport).sessionId : undefined,
    authorizationUrl: interactive ? () => interactive.pendingAuthorizationUrl : undefined,
    cleanup,
  };
}

// ─── Reconnect / disconnect ─────────────────────────────────────────

/**
 * Drop the cache entry and (if connected) clean up the existing connection,
 * so the next `connectToServer` call re-spawns. Used by `/mcp reconnect`.
 */
export async function clearServerCache(name: string, config: ScopedMcpServerConfig): Promise<void> {
  const { connectionCache, activeConnections, pendingAuthorizations, attempts } = state();
  const key = getCacheKey(name, config);
  const pending = connectionCache.get(key);
  connectionCache.delete(key);
  attempts.get(key)?.abort();
  attempts.delete(key);
  pendingAuthorizations.get(key)?.close();
  pendingAuthorizations.delete(key);
  const existing = activeConnections.get(name);
  if (existing) {
    if (activeConnections.get(name) === existing) activeConnections.delete(name);
    try {
      await existing.cleanup();
    } catch (error) {
      debugLog("mcp", `[${name}] cleanup during reconnect failed: ${(error as Error).message}`);
    }
  }

  // Deleting the cache alone is insufficient when the connection handshake is
  // still in flight: its completion callback would otherwise register a child
  // process after the plugin was disabled. Await and dispose that exact stale
  // instance without touching a newer connection with the same server name.
  if (pending) {
    const resolved = await pending.catch(() => undefined);
    if (resolved?.type === "connected" && resolved !== existing) {
      if (activeConnections.get(name) === resolved) activeConnections.delete(name);
      try {
        await resolved.cleanup();
      } catch (error) {
        debugLog("mcp", `[${name}] cleanup of in-flight connection failed: ${(error as Error).message}`);
      }
    }
  }
}

// ─── Process-level cleanup ──────────────────────────────────────────

let cleanupRegistered = false;
const processCleanups = new Set<() => Promise<void>>();

/**
 * Register a single SIGINT/SIGTERM/exit handler that cleans up every MCP
 * stdio child process. Without this, a Ctrl+C on the CLI leaves zombie
 * `npx @mcp/server-foo` processes running.
 */
export function registerMcpProcessCleanup(): void {
  if (runtimeScopeClosed()) return;
  const owner = state();
  if (!owner.processCleanup) {
    owner.processCleanup = () => closeConnections(owner);
    processCleanups.add(owner.processCleanup);
  }
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  const runCleanup = async (): Promise<void> => {
    await Promise.allSettled([...processCleanups].map((cleanup) => cleanup()));
  };

  // Fire-and-forget: SIGINT/SIGTERM listeners must be sync, but we still
  // want our async cleanup to start running. Worst case the process exits
  // before SIGKILL arrives (which is fine — that's the point).
  const onSignal = (signal: NodeJS.Signals) => {
    debugLog("mcp", `received ${signal}, cleaning up MCP servers`);
    void runCleanup();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("beforeExit", () => {
    void runCleanup();
  });
}

/** Public for tests + `/mcp` command. */
export function getActiveMcpConnections(): readonly ConnectedMcpServer[] {
  return Array.from(state().activeConnections.values());
}

/**
 * Test-only: blow away the connection Promise cache and the active-connection
 * map. Used by hermetic smoke tests so one test's leftover Promise doesn't
 * fast-path another test's `connectToServer`.
 *
 * NOT exposed to the runtime UI — the user-facing equivalent is
 * `clearServerCache(name, config)` per server.
 */
export function _resetMcpClientForTesting(): void {
  const owner = state();
  const { connectionCache, activeConnections, pendingAuthorizations } = owner;
  for (const attempt of owner.attempts.values()) attempt.abort();
  owner.attempts.clear();
  connectionCache.clear();
  activeConnections.clear();
  for (const auth of pendingAuthorizations.values()) auth.close();
  pendingAuthorizations.clear();
  owner.listeners = {};
}

// (Batch-connect helper removed — bootstrap.ts now drives parallelism
// directly so it can update the registry incrementally as each connection
// resolves, instead of waiting for the whole batch to settle.)
