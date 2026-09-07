/**
 * Diagnostics command group — `/status`, `/context`, `/doctor`.
 *
 * Extracted verbatim from queryEngine.ts; behavior is unchanged. Each handler
 * is a generator that reads engine state through the supplied CommandContext
 * and yields the same QueryEngineEvent stream the original methods produced.
 */

import { getAllTools, getToolsForMode } from "../../../tools/index.js";
import { resolveProfile } from "../../../services/api/providers/profile.js";
import { hasPendingMcpServers } from "../../../services/mcp/registry.js";
import { prepareToolSearchRequest } from "../../../utils/toolSearch.js";
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
  getSandboxUnavailableReason,
  loadSandboxSettings,
} from "../../../sandbox/index.js";
import { loadSettingsDiagnostics } from "../../../utils/settings.js";
import { getEnvironmentLoadReport } from "../../../config/environment.js";
import { isProjectTrusted } from "../../../config/globalState.js";
import { redactUrlForDisplay } from "../../../config/redaction.js";
import {
  getActivePluginErrors,
  getActivePlugins,
} from "../../../plugins/runtime.js";
import { loadPluginStateDiagnostics } from "../../../plugins/state.js";
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
  const lines = [
    "Status",
    "",
    `- cwd: ${ctx.cwd}`,
    `- Session id: ${ctx.sessionId ?? "(none)"}`,
    `- Model: ${ctx.getActiveModel()} (source: ${ctx.getModelSource()}; default: ${ctx.defaultModel})`,
    `- Permission mode: ${ctx.getPermissionMode()}` +
      (prePlanMode ? ` (restores to ${prePlanMode} on plan exit)` : ""),
    `- Task system: ${getTaskMode()}`,
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
    env: { protocol: profile.protocol, baseURL: profile.baseURL ?? process.env.ANTHROPIC_BASE_URL },
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
    const res = await fetch(baseURL, { method: "GET", signal: controller.signal });
    return { ok: true, status: res.status };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
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

  // Node version
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor >= 18) lines.push(`${ICON.ok} Node.js ${process.version}`);
  else lines.push(`${ICON.fail} Node.js ${process.version} — upgrade to v18+ (v20+ recommended).`);

  // API auth token (env or a model profile's apiKey)
  const hasEnvToken = !!(process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY);
  let hasProfileKey = false;
  try {
    const { loadProfiles } = await import("../../../services/api/providers/profile.js");
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
  lines.push(`  Endpoint: ${redactUrlForDisplay(baseURL)}`);
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

  yield { type: "command", kind: "info", message: lines.join("\n") };
  return { handled: true };
}
