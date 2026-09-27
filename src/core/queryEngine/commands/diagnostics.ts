/**
 * Diagnostics command group — `/status`, `/context`, `/doctor`.
 *
 * Extracted verbatim from queryEngine.ts; behavior is unchanged. Each handler
 * is a generator that reads engine state through the supplied CommandContext
 * and yields the same QueryEngineEvent stream the original methods produced.
 */

import { getAllTools, getToolsForMode } from "../../../tools/index.js";
import {
  getProfileBaseURL,
  loadProfiles,
  resolveProfile,
  type LoadedProfiles,
} from "../../../services/api/providers/profile.js";
import { loadTrustedSettingSources } from "../../../config/sources.js";
import { MIN_NODE_MAJOR } from "../../../version.js";
import { hasPendingMcpServers } from "../../../services/mcp/registry.js";
import { prepareToolSearchRequest } from "../../../utils/toolSearch.js";
import { loadFeatureSettings } from "../../../config/features.js";
import { getMcpRegistry } from "../../../services/mcp/registry.js";
import { getTaskMode } from "../../../state/taskModeStore.js";
import { getActiveOutputStyleName } from "../../../styles/registry.js";
import { buildSystemPrompt, renderSystemPrompt } from "../../../context/systemPrompt.js";
import { loadAgentMdContext } from "../../../context/claudeMd.js";
import { readMemoryEntrypoint } from "../../../context/memory/memdir.js";
import {
  buildTokenBudgetSnapshot,
  estimateSystemPromptTokens,
  roughTokenCountEstimationForMessages,
  getContextWindowForModel,
} from "../../../utils/tokens.js";
import {
  isPlatformSupported as isSandboxPlatformSupported,
  isSandboxRuntimeReady,
  getSandboxCapability,
  getSandboxUnavailableReason,
  loadSandboxSettings,
} from "../../../sandbox/index.js";
import { loadSettingsDiagnostics } from "../../../utils/settings.js";
import { getEnvironmentLoadReport } from "../../../config/environment.js";
import {
  getGlobalStateDiagnostics,
  isProjectTrusted,
} from "../../../config/globalState.js";
import { redactUrlForDisplay } from "../../../config/redaction.js";
import {
  getActivePluginErrors,
  getActivePlugins,
} from "../../../plugins/runtime.js";
import { loadPluginStateDiagnostics } from "../../../plugins/state.js";
import {
  getLastPrivateDataSecurityReport,
  inspectPrivateDataSecurity,
} from "../../../utils/privateData.js";
import type { QueryEngineEvent } from "../types.js";
import type { CommandContext } from "./context.js";

export async function* handleStatusCommand(
  ctx: CommandContext,
): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
  const tools = getAllTools();
  const toolNames = tools.map((t) => t.name);
  const mcp = getMcpRegistry();
  const connectedMcp = mcp.filter((e) => e.connection.type === "connected");

  const prePlanMode = ctx.getPrePlanMode();
  const taskMode = getTaskMode();
  const taskModeLabel = taskMode === "task" ? "persistent task list" : "session-only todo list";
  const lines = [
    "Status",
    "",
    `- cwd: ${ctx.cwd}`,
    `- Session id: ${ctx.sessionId ?? "(none)"}`,
    `- Model: ${ctx.getActiveModel()} (source: ${ctx.getModelSource()}; default: ${ctx.defaultModel})`,
    `- Permission mode: ${ctx.getPermissionMode()}` +
      (prePlanMode ? ` (restores to ${prePlanMode} on plan exit)` : ""),
    `- Task system: ${taskModeLabel} (${taskMode})`,
    `- Output style: ${getActiveOutputStyleName()}`,
    `- Messages in context: ${ctx.getMessages().length}`,
    `- Session tokens: in ${ctx.getTotalUsage().input_tokens} / out ${ctx.getTotalUsage().output_tokens}`,
    `- Tools enabled (${tools.length}): ${toolNames.join(", ")}`,
    mcp.length === 0
      ? "- MCP servers: none configured"
      : `- MCP servers: ${connectedMcp.length}/${mcp.length} connected`,
  ];
  yield { type: "command", kind: "info", message: lines.join("\n") };
  return { handled: true };
}

/**
 * `/context` — visualize how the context window is currently split across
 * System prompt / AGENT.md + memory / Tool definitions / Conversation history /
 * Free space, each as a proportional bar. Estimates reuse the same token
 * heuristics the auto-compactor relies on.
 */
export async function* handleContextCommand(
  ctx: CommandContext,
): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
  const cwd = ctx.cwd;
  const model = ctx.getActiveModel();
  const messages = ctx.getMessages();

  const systemParts = await buildSystemPrompt({ cwd });
  const systemPrompt = renderSystemPrompt(systemParts);
  // Mirror the real request: with tool search on, deferred tools that
  // haven't been loaded cost nothing — only the shaped `tools[]` counts.
  const profile = await resolveProfile(model, cwd);
  const shaped = prepareToolSearchRequest({
    tools: getToolsForMode(ctx.getPermissionMode()),
    messages,
    model: profile.model,
    env: { protocol: profile.protocol, baseURL: profile.baseURL ?? process.env.ANTHROPIC_BASE_URL, settings: await loadFeatureSettings(cwd) },
    hasPendingMcpServers: hasPendingMcpServers(),
    source: "context",
  });
  const toolsJson = JSON.stringify(shaped.tools);
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
  const historyTokens = roughTokenCountEstimationForMessages(messages);

  const contextWindow = getContextWindowForModel(model);
  const used = systemCoreTokens + memoryTokens + toolTokens + historyTokens;
  const free = Math.max(0, contextWindow - used);

  const snapshot = buildTokenBudgetSnapshot(messages, { systemPrompt, model });

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
  if (shaped.enabled) {
    const loaded = [...shaped.deferredToolNames].filter((n) => shaped.discoveredToolNames.has(n));
    lines.push(
      "",
      `Tool search: on — ${shaped.deferredToolNames.size} deferred tool(s), ${loaded.length} loaded via ToolSearch` +
        (loaded.length > 0 ? ` (${loaded.join(", ")})` : ""),
      `  Always loaded: ${shaped.tools.length - loaded.length} tool(s), ~${roughJson(JSON.stringify(shaped.tools.filter((t) => !shaped.deferredToolNames.has(t.name))))} tok`,
      `  Deferred loaded: ${loaded.length} tool(s), ~${loaded.length ? roughJson(JSON.stringify(shaped.tools.filter((t) => shaped.deferredToolNames.has(t.name)))) : 0} tok`,
      `  Deferred not loaded: ${shaped.deferredToolNames.size - loaded.length} tool(s), 0 schema tok`,
    );
  }
  if (snapshot.estimatedConversationTokens >= snapshot.autoCompactThreshold) {
    lines.push("", "⚠ Approaching the auto-compact threshold — consider /compact.");
  }
  yield { type: "command", kind: "info", message: lines.join("\n") };
  return { handled: true };
}

/** Best-effort reachability probe for the API endpoint (5s timeout). */
async function probeEndpoint(
  baseURL: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const target = new URL(baseURL);
    if (!["http:", "https:"].includes(target.protocol)) return { ok: false, error: "endpoint must use HTTP or HTTPS" };
    // Never forward embedded credentials or secret query parameters in a probe.
    target.username = "";
    target.password = "";
    target.search = "";
    target.hash = "";
    const res = await fetch(target.href, { method: "GET", redirect: "manual", signal: controller.signal });
    await res.body?.cancel();
    return { ok: true, status: res.status };
  } catch {
    return { ok: false, error: controller.signal.aborted ? "probe timed out after 5s" : "probe failed; check endpoint, network and TLS configuration" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `/doctor` — environment health check. Each line carries a status icon
 * (✓ ok / ⚠ warning / ✗ failure) plus a remediation hint: Node version, API
 * auth token, endpoint reachability, MCP connections, sandbox availability,
 * and settings-file validity.
 */
export async function* handleDoctorCommand(
  ctx: CommandContext,
): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
  const cwd = ctx.cwd;
  const ICON = { ok: "✓", warn: "⚠", fail: "✗" };
  const lines = ["Doctor — environment check", ""];

  // Node version — use the same floor enforced before the CLI starts.
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor >= MIN_NODE_MAJOR) {
    lines.push(`${ICON.ok} Node.js ${process.version} (requires ${MIN_NODE_MAJOR}+)`);
  } else {
    lines.push(`${ICON.fail} Node.js ${process.version} — upgrade to v${MIN_NODE_MAJOR} or newer.`);
  }

  // Resolve exactly the model/profile this session will use. Looking at any
  // configured profile can produce a false-positive auth diagnosis when the
  // active profile is missing its own key.
  const activeHandle = ctx.getActiveModel();
  const loadedProfiles: LoadedProfiles = await loadProfiles(cwd).catch(() => ({
    profiles: {},
    defaultModel: undefined,
    warnings: [],
    provenance: {},
    defaultModelSource: undefined,
  }));
  const declaredProfile = loadedProfiles.profiles[activeHandle];
  const profile = declaredProfile ?? await resolveProfile(activeHandle, cwd);
  const fieldSources = declaredProfile
    ? [...new Set(Object.values(loadedProfiles.provenance[activeHandle] ?? {}))]
    : [];
  const profileSources = await loadTrustedSettingSources(cwd).catch(() => []);
  const effectiveSources = [...profileSources].reverse();
  const modelSource = effectiveSources.find((source) => typeof source.raw?.model === "string");
  const defaultSource = effectiveSources.find((source) => typeof source.raw?.defaultModel === "string");
  const selected = modelSource ?? defaultSource;
  const selectedValue = modelSource?.raw?.model ?? defaultSource?.raw?.defaultModel;
  const selectionSource = ctx.getModelSource() === "session"
    ? "session override"
    : selectedValue === activeHandle
      ? selected!.source
      : process.env.ANTHROPIC_MODEL === activeHandle ? "ANTHROPIC_MODEL" : "runtime default";
  lines.push(
    `${ICON.ok} Active model: ${activeHandle}${profile.model !== activeHandle ? ` → ${profile.model}` : ""}`,
    `  Provider: ${profile.protocol}`,
    declaredProfile
      ? `  Profile: ${activeHandle} (configuration: ${fieldSources.join("+") || "unknown"}; selection: ${selectionSource})`
      : `  Profile: raw model name (source: ${ctx.getModelSource()})`,
  );
  for (const warning of loadedProfiles.warnings) lines.push(`  ${ICON.warn} ${warning}`);

  const profileKeySource = declaredProfile
    ? loadedProfiles.provenance[activeHandle]?.apiKey
    : undefined;
  const envKeyName = process.env.ANTHROPIC_AUTH_TOKEN
    ? "ANTHROPIC_AUTH_TOKEN"
    : !profile.baseURL && process.env.ANTHROPIC_API_KEY
      ? "ANTHROPIC_API_KEY"
      : undefined;
  const usesAnthropicEnvironmentKey = profile.protocol === "anthropic" && !!envKeyName;
  const authHeaderNames = profile.protocol === "gemini"
    ? ["x-goog-api-key", "authorization"]
    : profile.protocol === "anthropic" ? ["x-api-key", "authorization"] : ["authorization"];
  const hasAuthHeader = Object.entries(profile.headers ?? {}).some(([name, value]) =>
    authHeaderNames.includes(name.toLowerCase()) && value.trim().length > 0,
  );
  if (hasAuthHeader) {
    lines.push(`${ICON.ok} API auth configured (active profile headers, source: ${loadedProfiles.provenance[activeHandle]?.headers ?? "unknown"})`);
  } else if (profile.apiKey) {
    lines.push(`${ICON.ok} API auth configured (active profile${profileKeySource ? `, source: ${profileKeySource}` : ""})`);
  } else if (usesAnthropicEnvironmentKey) {
    lines.push(`${ICON.ok} API auth configured (${envKeyName})`);
  } else if (profile.baseURL) {
    lines.push(`${ICON.warn} No API auth configured for the active profile; the custom endpoint must allow keyless access.`);
  } else {
    const hint = profile.protocol === "anthropic"
      ? "set ANTHROPIC_AUTH_TOKEN or configure apiKey on the active profile"
      : `configure apiKey on profile '${activeHandle}'`;
    lines.push(`${ICON.fail} No API auth configured for the active ${profile.protocol} provider — ${hint}.`);
  }

  // Endpoint + reachability. Any HTTP response proves network reachability;
  // provider APIs are not required to accept an unauthenticated GET at root.
  lines.push("  Credential presence only; authentication has not been verified.");
  const baseURL = getProfileBaseURL(profile);
  const endpointSource = profile.baseURL
    ? loadedProfiles.provenance[activeHandle]?.baseURL ?? "profile"
    : profile.protocol === "anthropic" && process.env.ANTHROPIC_BASE_URL ? "ANTHROPIC_BASE_URL" : "provider default";
  lines.push(`  Endpoint: ${redactUrlForDisplay(baseURL)} (source: ${endpointSource})`);
  const reach = await probeEndpoint(baseURL);
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
  let sandboxFailClosed = true;
  let sandboxAllowedDomains = 0;
  let sandboxDeniedDomains = 0;
  let sandboxConfigurationError: string | undefined;
  try {
    const sandboxSettings = await loadSandboxSettings(cwd);
    sandboxEnabled = sandboxSettings.enabled;
    sandboxFailClosed = sandboxSettings.failClosed;
    sandboxAllowedDomains = sandboxSettings.network.allowedDomains.length;
    sandboxDeniedDomains = sandboxSettings.network.deniedDomains.length;
  } catch (error) {
    sandboxConfigurationError = error instanceof Error ? error.message : String(error);
  }
  const sandboxCapability = getSandboxCapability();
  if (sandboxConfigurationError) {
    lines.push(`${ICON.fail} Sandbox: invalid configuration; shell execution is blocked`);
    lines.push(`    ${sandboxConfigurationError.replace(/\n/g, "\n    ")}`);
  } else if (!isSandboxPlatformSupported()) {
    lines.push(
      `${sandboxEnabled ? ICON.warn : ICON.ok} Sandbox: not supported on ${process.platform}` +
        (sandboxEnabled
          ? sandboxFailClosed
            ? " (shell execution is blocked by failClosed)"
            : " (normal permission checks remain active)"
          : ""),
    );
  } else if (isSandboxRuntimeReady()) {
    lines.push(
      `${ICON.ok} Sandbox: ${sandboxCapability.backend} available` +
        `${sandboxEnabled ? ` (enabled, failClosed=${sandboxFailClosed})` : " (disabled in settings)"}`,
    );
    if (sandboxEnabled) {
      lines.push(
        sandboxAllowedDomains > 0
          ? `    Network: strict allowlist (${sandboxAllowedDomains} allowed, ${sandboxDeniedDomains} denied)`
          : `    Network: public destinations allowed through proxy (${sandboxDeniedDomains} denied)`,
      );
    }
    for (const warning of sandboxCapability.warnings) lines.push(`    - ${warning}`);
  } else {
    const reason = getSandboxUnavailableReason(true) ?? "required dependencies are unavailable";
    lines.push(
      `${sandboxEnabled && sandboxFailClosed ? ICON.fail : ICON.warn} Sandbox: ${reason}` +
        (sandboxEnabled && sandboxFailClosed ? " (shell execution is blocked)" : ""),
    );
  }

  // Settings validity
  const settingsErrors = await loadSettingsDiagnostics(cwd).catch(() => [] as string[]);
  if (settingsErrors.length === 0) {
    lines.push(`${ICON.ok} Settings files valid`);
  } else {
    lines.push(`${ICON.fail} Settings problems:`);
    for (const e of settingsErrors) lines.push(`    - ${e}`);
  }

  const stateErrors = getGlobalStateDiagnostics();
  if (stateErrors.length === 0) {
    lines.push(`${ICON.ok} Runtime state valid`);
  } else {
    lines.push(`${ICON.fail} Runtime state problems:`);
    for (const error of stateErrors) lines.push(`    - ${error}`);
  }

  const privateData = await inspectPrivateDataSecurity(cwd);
  const startupPrivateData = getLastPrivateDataSecurityReport();
  const privateDataIssues = [
    ...privateData.issues,
    ...(startupPrivateData?.issues ?? []),
  ].filter(
    (issue, index, all) =>
      all.findIndex((candidate) => candidate.path === issue.path && candidate.message === issue.message) === index,
  );
  if (!privateData.supported) {
    lines.push(
      `${ICON.warn} Local data permissions: Windows uses inherited user-profile ACLs; POSIX 0600/0700 modes are unavailable`,
    );
  } else if (privateDataIssues.length === 0) {
    lines.push(`${ICON.ok} Local data permissions: private (directories 0700, files 0600)`);
  } else {
    lines.push(`${ICON.warn} Local data permissions: ${privateDataIssues.length} issue(s)`);
    for (const issue of privateDataIssues.slice(0, 8)) {
      lines.push(`    - ${issue.path}: ${issue.message}`);
    }
    lines.push(`    Re-run eagent after correcting ownership or filesystem permissions.`);
  }

  const workspaceTrusted = await isProjectTrusted(cwd);
  const environmentReport = getEnvironmentLoadReport();
  lines.push(
    `${workspaceTrusted ? ICON.ok : ICON.warn} Project configuration: ` +
      `${workspaceTrusted ? "trusted" : "untrusted; sensitive project settings are ignored"}`,
  );
  if (environmentReport) {
    const bySource = new Map<string, number>();
    for (const source of Object.values(environmentReport.effectiveSources)) {
      bySource.set(source, (bySource.get(source) ?? 0) + 1);
    }
    const summary = [...bySource.entries()].map(([source, count]) => `${source}:${count}`).join(", ");
    lines.push(`${ICON.ok} Environment configuration sources: ${summary || "parent process only"}`);
  }

  // Plugin loader/reload failures are structured and persistent for the active
  // snapshot, so /doctor is the single place users can inspect them later.
  const plugins = getActivePlugins();
  const pluginErrors = getActivePluginErrors();
  const pluginStateErrors = await loadPluginStateDiagnostics();
  if (pluginErrors.length === 0 && pluginStateErrors.length === 0) {
    lines.push(`${ICON.ok} Plugins: ${plugins.length} active, no load errors`);
  } else {
    lines.push(
      `${ICON.fail} Plugins: ${plugins.length} active, ` +
        `${pluginErrors.length + pluginStateErrors.length} issue(s)`,
    );
    for (const issue of pluginErrors) {
      lines.push(`    - ${issue.pluginId} [${issue.scope}]: ${issue.message}`);
    }
    for (const issue of pluginStateErrors) lines.push(`    - state: ${issue}`);
  }

  const { describeConfiguration } = await import("../../../config/catalog.js");
  lines.push("", ...await describeConfiguration(cwd));
  const { getLspStatus } = await import("../../../services/lsp/runtime.js");
  for (const server of getLspStatus()) lines.push(`LSP ${server.name}: ${server.status}${server.error ? ` (${server.error})` : ""}`);

  yield { type: "command", kind: "info", message: lines.join("\n") };
  return { handled: true };
}
