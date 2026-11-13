/**
 * Context window breakdown of a session — the numbers `/context` prints and
 * `AgentSession.getContext()` returns.
 *
 * After the session's first model request, the breakdown is read from the
 * record of the latest main-loop request (`basis: "request"`): every system
 * prompt section, rule file, listed skill and sub-agent, tool schema, and
 * message source the request carried is a component with its bytes and
 * estimated tokens, and the bytes add up to the request body. Messages the
 * conversation gained since that request (the reply to it, at least) are
 * added under their sources. When the conversation no longer starts with the
 * request's (after /clear, compaction, rewind, or resume), or before the
 * first request, the breakdown falls back to an estimate of what the next
 * request would carry (`basis: "estimate"`): the system prompt the session
 * pinned, the tool list after ToolSearch shaping, and the conversation, with
 * the same character heuristics as the auto-compactor.
 *
 * Either way the items of a category add up to the category, and the
 * categories add up to `used`.
 */

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { getAllAgents } from "../../agents/registry.js";
import { loadFeatureSettings } from "../../config/features.js";
import { formatAgentMdSection, listAgentMdFiles } from "../../context/claudeMd.js";
import { readMemoryEntrypoint } from "../../context/memory/memdir.js";
import { renderSystemPrompt, type PromptSection, type PromptSectionName } from "../../context/systemPrompt.js";
import { getActivePlugins } from "../../plugins/runtime.js";
import { resolveProfile } from "../../services/api/providers/profile.js";
import { getMcpRegistry, hasPendingMcpServers } from "../../services/mcp/registry.js";
import { findSkill } from "../../services/skills/registry.js";
import { getToolsForMode } from "../../tools/index.js";
import type { PermissionMode } from "../../permissions/permissions.js";
import {
  buildTokenBudgetSnapshot,
  distributeTokens,
  estimateJsonTokens,
  estimateMessageTokens,
  estimateSystemPromptTokens,
  estimateTextTokens,
  getContextWindowForModel,
  roughTokenCountEstimationForMessages,
} from "../../utils/tokens.js";
import { prepareToolSearchRequest } from "../../utils/toolSearch.js";
import { getGlobalAgentMdPath } from "../../utils/paths.js";
import type { MessageSource } from "../messageSources.js";
import { measureMessage, type MessageTraceSegment, type RequestRecord } from "../../trace/requestTrace.js";

export type ContextCategoryId = "system" | "tools" | "mcp" | "skills" | "plugins" | "rules" | "messages";

export interface ContextItem {
  /** Stable within a category, e.g. a tool name, a file path, or a section name. */
  id: string;
  label: string;
  tokens: number;
  /** Where the item is configured: `built-in`, a settings layer, or `plugin`. */
  source?: string;
  pluginId?: string;
}

export interface ContextCategory {
  id: ContextCategoryId;
  tokens: number;
  items: ContextItem[];
}

/** `request`: read from the latest request sent; `estimate`: what the next request would carry, before there is one. */
export type ContextBasis = "request" | "estimate";

/** Which part of the request body a component is in; `request` is the envelope and the JSON around the parts. */
export type ContextPart = "system" | "tools" | "messages" | "request";

export interface ContextComponent {
  /**
   * Component id: `prompt_section:environment`, `rule:<path>`, `rule:memory`,
   * `skill:<source>:<name>`, `agent:<source>:<name>`, `tool:<name>`,
   * `message:<source>`, `prompt:marker`; `request:envelope` (model,
   * parameters, field names) and `request:framing` (the JSON around the system
   * prompt text and between tools and messages) carry no tokens.
   */
  id: string;
  part: ContextPart;
  /** The category and item its tokens count toward; null for the envelope and framing. */
  category: ContextCategoryId | null;
  item: string | null;
  /** UTF-8 bytes: of the text for system prompt parts, of the JSON otherwise. */
  bytes: number;
  /** Estimated from the size. */
  tokens: number;
  /** Messages, or parts of messages, a `message:` component folds; 1 otherwise. */
  count: number;
}

export interface ContextRequest {
  requestId: string;
  startedAt: string;
  turnId?: string;
  protocol: string;
  /** The model the request was sent to. */
  model: string;
  /**
   * Bytes of the body sent. For a protocol translated from the Anthropic
   * shape this is the translated body, and the components measure the
   * request before translation.
   */
  bytes: number;
  /** Input tokens the provider reported for the request: uncached, cache reads, and cache writes. */
  inputTokens: number;
  /** Messages added since the request, counted under their sources; their bytes are not part of `bytes`. */
  unsent: { messages: number; bytes: number; tokens: number };
}

export interface ContextBreakdown {
  model: string;
  contextWindow: number;
  /** Token figures are estimates from sizes; `request.inputTokens` is the provider's count. */
  estimated: true;
  basis: ContextBasis;
  /** Sum of the categories. */
  used: number;
  free: number;
  /** Conversation size the auto-compactor compares with `autoCompactThreshold`. */
  conversationTokens: number;
  autoCompactThreshold: number;
  /** The seven categories, always in this order: system, tools, mcp, skills, plugins, rules, messages. */
  categories: ContextCategory[];
  /** The four totals `/context` prints. */
  totals: { systemPrompt: number; memory: number; tools: number; conversation: number };
  toolSearch: {
    enabled: boolean;
    /** Deferred tools, offered by name until ToolSearch loads them. */
    deferred: string[];
    /** Deferred tools the conversation has loaded. */
    loaded: string[];
    /** Tools whose schema the request carries. */
    sentTools: number;
    alwaysLoadedTokens: number;
    loadedTokens: number;
  };
  /** Every part of the request body in request order, folded by id; empty for an estimate. */
  components: ContextComponent[];
  /** The request the breakdown was read from; absent for an estimate. */
  request?: ContextRequest;
}

export interface ContextBreakdownInput {
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  messages: readonly MessageParam[];
  /** The system prompt the next request uses, with its dynamic sections. */
  systemPrompt: { systemParts: string[]; sections: PromptSection[] };
  /** The latest main-loop request and the conversation it was made from. */
  lastRequest?: { record: RequestRecord; conversation: readonly MessageParam[] } | null;
  /** A turn is running, so `messages` may not hold its requests' messages yet. */
  busy?: boolean;
}

export { distributeTokens };

interface Piece {
  category: ContextCategoryId;
  item: Omit<ContextItem, "tokens">;
  weight: number;
}

const SECTION_LABELS: Record<PromptSectionName, string> = {
  output_style: "Output style",
  language: "Response language",
  environment: "Environment",
  agent_md: "Project memory",
  memory: "Memory instructions",
  session_instructions: "Session instructions",
  skills: "Skill list",
  agents: "Sub-agent list",
  team: "Agent team",
};

const sourceLabel = (source: string): string => (source === "built-in" ? "built-in" : source);

/** Split a listing section into its framing text and its `- name…` lines. */
function listingLines(text: string): { framing: number; lines: string[] } {
  const lines = text.split("\n");
  const entries = lines.filter((line) => line.startsWith("- "));
  return {
    framing: Math.max(0, text.length - entries.reduce((acc, line) => acc + line.length + 1, 0)),
    lines: entries,
  };
}

/** The name in `- name: description` or `- name [tag]: description`; plugin names contain `:` themselves. */
function listedName(line: string): string {
  const body = line.slice(2);
  const end = body.search(/: | \[/);
  return end === -1 ? body : body.slice(0, end);
}

/** Pieces of the system prompt outside project memory: static instructions, sections, and listing lines. */
function promptPieces(
  input: ContextBreakdownInput,
  memoryEntryLength: number,
  pluginNames: Map<string, string>,
): Piece[] {
  const sectionTexts = new Set(input.systemPrompt.sections.map((section) => section.text).filter(Boolean));
  const staticText = input.systemPrompt.systemParts.filter((part) => !sectionTexts.has(part));
  const pieces: Piece[] = [
    {
      category: "system",
      item: { id: "instructions", label: "Instructions", source: "built-in" },
      weight: renderSystemPrompt(staticText).length,
    },
  ];
  const pluginPiece = (pluginId: string, weight: number): Piece => ({
    category: "plugins",
    item: { id: pluginId, label: pluginNames.get(pluginId) ?? pluginId, source: "plugin", pluginId },
    weight,
  });

  for (const section of input.systemPrompt.sections) {
    if (!section.text || section.name === "agent_md") continue;
    if (section.name === "skills") {
      const { framing, lines } = listingLines(section.text);
      pieces.push({
        category: "system",
        item: { id: "skills", label: SECTION_LABELS.skills, source: "built-in" },
        weight: framing,
      });
      for (const line of lines) {
        const name = listedName(line);
        const skill = findSkill(name);
        pieces.push(
          skill?.source === "plugin" && skill.pluginId
            ? pluginPiece(skill.pluginId, line.length + 1)
            : {
                category: "skills",
                item: { id: name, label: `/${name}`, ...(skill ? { source: sourceLabel(skill.source) } : {}) },
                weight: line.length + 1,
              },
        );
      }
      continue;
    }
    if (section.name === "agents") {
      const agents = new Map(getAllAgents().map((agent) => [agent.agentType, agent]));
      const { framing, lines } = listingLines(section.text);
      let own = framing;
      for (const line of lines) {
        const agent = agents.get(listedName(line));
        if (agent?.source === "plugin" && agent.pluginId) pieces.push(pluginPiece(agent.pluginId, line.length + 1));
        else own += line.length + 1;
      }
      pieces.push({ category: "system", item: { id: "agents", label: SECTION_LABELS.agents }, weight: own });
      continue;
    }
    const weight =
      section.name === "memory" ? Math.max(0, section.text.length - memoryEntryLength) : section.text.length;
    // A section the Agent adds is labelled by its name.
    const label = SECTION_LABELS[section.name as PromptSectionName] ?? section.name;
    pieces.push({ category: "system", item: { id: section.name, label }, weight });
  }
  return pieces;
}

type Placement = Pick<Piece, "category" | "item">;

/** Where a tool is counted: built-in tools by name, MCP tools by server, plugin tools by plugin. */
function toolPlacer(pluginNames: Map<string, string>): (name: string) => Placement {
  const serverOf = new Map<string, { name: string; scope: string }>();
  for (const entry of getMcpRegistry()) {
    for (const tool of entry.tools) {
      serverOf.set(tool.name, { name: entry.connection.name, scope: entry.connection.config.scope });
    }
  }
  const pluginOfServer = new Map<string, string>();
  for (const plugin of getActivePlugins()) {
    for (const server of plugin.mcpServers) pluginOfServer.set(server.namespacedName, plugin.pluginId);
  }
  return (name) => {
    const server = serverOf.get(name);
    if (!server) return { category: "tools", item: { id: name, label: name, source: "built-in" } };
    const pluginId = pluginOfServer.get(server.name);
    if (pluginId) {
      return {
        category: "plugins",
        item: { id: pluginId, label: pluginNames.get(pluginId) ?? pluginId, source: "plugin", pluginId },
      };
    }
    return { category: "mcp", item: { id: server.name, label: server.name, source: server.scope } };
  };
}

/** Pieces of the tool list: one per tool sent, grouped later by server or plugin. */
function toolPieces(tools: readonly { name: string }[], pluginNames: Map<string, string>): Piece[] {
  const place = toolPlacer(pluginNames);
  return tools.map((tool) => ({ ...place(tool.name), weight: JSON.stringify(tool).length + 1 }));
}

function messageKind(message: MessageParam): { id: string; label: string } {
  if (message.role === "assistant") return { id: "assistant", label: "Assistant replies" };
  const hasToolResult = Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result");
  return hasToolResult ? { id: "tool_results", label: "Tool results" } : { id: "user", label: "User messages" };
}

/**
 * Spread each total over its pieces and fold pieces with the same category and
 * id into one item. A total without pieces (the brackets of an empty tool
 * list) goes to its fallback piece, so nothing is dropped.
 */
function assemble(groups: Array<{ total: number; pieces: Piece[]; fallback: Piece }>): ContextCategory[] {
  const order: ContextCategoryId[] = ["system", "tools", "mcp", "skills", "plugins", "rules", "messages"];
  const categories = new Map<ContextCategoryId, ContextCategory>(order.map((id) => [id, { id, tokens: 0, items: [] }]));
  const items = new Map<string, ContextItem>();
  for (const group of groups) {
    const { total } = group;
    const pieces = group.pieces.length > 0 ? group.pieces : [group.fallback];
    const shares = distributeTokens(
      total,
      pieces.map((piece) => piece.weight),
    );
    pieces.forEach((piece, index) => {
      const tokens = shares[index] ?? 0;
      const category = categories.get(piece.category)!;
      category.tokens += tokens;
      const key = `${piece.category}\u0000${piece.item.id}`;
      const existing = items.get(key);
      if (existing) existing.tokens += tokens;
      else {
        const item = { ...piece.item, tokens };
        items.set(key, item);
        category.items.push(item);
      }
    });
  }
  for (const category of categories.values()) {
    category.items = category.items.filter((item) => item.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  }
  return order.map((id) => categories.get(id)!);
}

// ─── From the latest request ────────────────────────────────────────────

/** The item each message source is counted as; one entry per source. */
export const MESSAGE_ITEMS: Readonly<Record<MessageSource, { id: string; label: string }>> = {
  user_input: { id: "user", label: "User messages" },
  assistant: { id: "assistant", label: "Assistant replies" },
  tool_result: { id: "tool_results", label: "Tool results" },
  command: { id: "command", label: "Commands" },
  skill_body: { id: "skill_body", label: "Skill instructions" },
  plan_attachment: { id: "plan_attachment", label: "Plan mode attachments" },
  background_notification: { id: "background_notification", label: "Background notifications" },
  team_message: { id: "team_message", label: "Team messages" },
  context_update: { id: "context_update", label: "Context updates" },
  hook_output: { id: "hook_output", label: "Hook output" },
  compaction_summary: { id: "compaction_summary", label: "Compaction summary" },
  deferred_tools: { id: "deferred_tools", label: "Deferred tool list" },
  meta: { id: "meta", label: "Hidden notes" },
  subagent_prompt: { id: "subagent_prompt", label: "Sub-agent task" },
  classifier_input: { id: "classifier_input", label: "Classifier input" },
  web_page: { id: "web_page", label: "Web page" },
  compaction_input: { id: "compaction_input", label: "Conversation to summarize" },
  search_query: { id: "search_query", label: "Search query" },
};

/** `<kind>:<source>:<name>`, where the name may contain `:` (plugin skills). */
function sourceAndName(id: string, kind: string): { source: string; name: string } {
  const rest = id.slice(kind.length + 1);
  const colon = rest.indexOf(":");
  return colon === -1 ? { source: "", name: rest } : { source: rest.slice(0, colon), name: rest.slice(colon + 1) };
}

/** Where a system prompt component is counted. */
function systemPlacer(pluginNames: Map<string, string>): (component: string) => Placement {
  const globalAgentMd = getGlobalAgentMdPath();
  const agents = new Map(getAllAgents().map((agent) => [agent.agentType, agent]));
  const plugin = (pluginId: string): Placement => ({
    category: "plugins",
    item: { id: pluginId, label: pluginNames.get(pluginId) ?? pluginId, source: "plugin", pluginId },
  });
  return (component) => {
    if (component === "rule:memory") {
      return { category: "rules", item: { id: "memory", label: "MEMORY.md", source: "project" } };
    }
    if (component.startsWith("rule:")) {
      const filePath = component.slice("rule:".length);
      return {
        category: "rules",
        item: { id: filePath, label: filePath, source: filePath === globalAgentMd ? "user" : "project" },
      };
    }
    if (component.startsWith("skill:")) {
      const { source, name } = sourceAndName(component, "skill");
      const skill = findSkill(name);
      if (source === "plugin" && skill?.pluginId) return plugin(skill.pluginId);
      return {
        category: "skills",
        item: { id: name, label: `/${name}`, ...(source ? { source: sourceLabel(source) } : {}) },
      };
    }
    if (component.startsWith("agent:")) {
      const { source, name } = sourceAndName(component, "agent");
      const agent = agents.get(name);
      if (source === "plugin" && agent?.pluginId) return plugin(agent.pluginId);
      return { category: "system", item: { id: "agents", label: SECTION_LABELS.agents } };
    }
    if (component.startsWith("prompt_section:")) {
      const name = component.slice("prompt_section:".length);
      if (name !== "identity" && name !== "instructions") {
        // A section the Agent adds is labelled by its name.
        return { category: "system", item: { id: name, label: SECTION_LABELS[name as PromptSectionName] ?? name } };
      }
    }
    return { category: "system", item: { id: "instructions", label: "Instructions", source: "built-in" } };
  };
}

/**
 * Messages the conversation gained since the request, or null when the
 * conversation no longer starts with the request's. While a turn runs the
 * session's messages can lag behind the turn's requests.
 */
function messagesSince(
  conversation: readonly MessageParam[],
  current: readonly MessageParam[],
  busy: boolean,
): readonly MessageParam[] | null {
  if (current.length === 0) return null;
  const shared = Math.min(conversation.length, current.length);
  for (let index = 0; index < shared; index++) if (conversation[index] !== current[index]) return null;
  if (current.length >= conversation.length) return current.slice(conversation.length);
  return busy ? [] : null;
}

interface RequestComponents {
  components: ContextComponent[];
  pieces: Piece[];
}

/** The components of a request record, with the messages since then added under their sources. */
function requestComponents(
  record: RequestRecord,
  unsent: readonly MessageParam[],
  pluginNames: Map<string, string>,
): RequestComponents {
  const components = new Map<string, ContextComponent>();
  const pieces: Piece[] = [];
  const add = (id: string, part: ContextPart, placement: Placement | null, bytes: number, tokens: number) => {
    const existing = components.get(id);
    if (existing) {
      existing.bytes += bytes;
      existing.tokens += tokens;
      existing.count += 1;
    } else {
      components.set(id, {
        id,
        part,
        category: placement?.category ?? null,
        item: placement?.item.id ?? null,
        bytes,
        tokens,
        count: 1,
      });
    }
    if (placement) pieces.push({ ...placement, weight: tokens });
  };

  const placeSystem = systemPlacer(pluginNames);
  for (const segment of record.system.segments) {
    add(segment.component, "system", placeSystem(segment.component), segment.bytes, segment.tokens);
  }
  const placeTool = toolPlacer(pluginNames);
  for (const segment of record.tools.segments) {
    const name = segment.component.slice("tool:".length);
    add(segment.component, "tools", placeTool(name), segment.bytes, segment.tokens);
  }
  const addMessage = (segment: MessageTraceSegment) => {
    for (const part of segment.parts ?? [segment]) {
      add(
        `message:${part.source}`,
        "messages",
        { category: "messages", item: MESSAGE_ITEMS[part.source] },
        part.bytes,
        part.tokens,
      );
    }
  };
  for (const segment of record.messages.segments) addMessage(segment);
  for (const [index, message] of unsent.entries()) addMessage(measureMessage(message, index).segment);

  const sum = (segments: readonly { bytes: number }[]) => segments.reduce((total, segment) => total + segment.bytes, 0);
  const framing =
    record.system.bytes -
    sum(record.system.segments) +
    record.tools.bytes -
    sum(record.tools.segments) +
    record.messages.bytes -
    sum(record.messages.segments);
  if (record.envelopeBytes !== undefined) add("request:envelope", "request", null, record.envelopeBytes, 0);
  add("request:framing", "request", null, framing, 0);
  return { components: [...components.values()], pieces };
}

function fromRequest(
  base: Omit<ContextBreakdown, "basis" | "categories" | "totals" | "components" | "used" | "free" | "toolSearch">,
  record: RequestRecord,
  unsent: readonly MessageParam[],
  shaped: { enabled: boolean; deferredToolNames: Set<string> },
): ContextBreakdown {
  const pluginNames = new Map(getActivePlugins().map((plugin) => [plugin.pluginId, plugin.name]));
  const { components, pieces } = requestComponents(record, unsent, pluginNames);
  const categories = assemble([
    {
      total: pieces.reduce((sum, piece) => sum + piece.weight, 0),
      pieces,
      fallback: { category: "system", item: { id: "instructions", label: "Instructions" }, weight: 1 },
    },
  ]);
  const tokensOf = (filter: (component: ContextComponent) => boolean) =>
    components.filter(filter).reduce((sum, component) => sum + component.tokens, 0);
  const totals = {
    systemPrompt: tokensOf((c) => c.part === "system" && c.category !== "rules"),
    memory: tokensOf((c) => c.category === "rules"),
    tools: tokensOf((c) => c.part === "tools"),
    conversation: tokensOf((c) => c.part === "messages"),
  };
  const used = totals.systemPrompt + totals.memory + totals.tools + totals.conversation;
  const sentTools = record.tools.segments.map((segment) => ({
    name: segment.component.slice("tool:".length),
    tokens: segment.tokens,
  }));
  const loaded = sentTools.filter((tool) => shaped.deferredToolNames.has(tool.name));
  const usage = record.result?.usage;
  const unsentSegments = unsent.map((message, index) => measureMessage(message, index).segment);
  const partBytes = record.system.bytes + record.tools.bytes + record.messages.bytes;
  return {
    ...base,
    basis: "request",
    used,
    free: Math.max(0, base.contextWindow - used),
    categories,
    totals,
    toolSearch: {
      enabled: record.params.toolSearch,
      deferred: [...shaped.deferredToolNames],
      loaded: loaded.map((tool) => tool.name),
      sentTools: sentTools.length,
      alwaysLoadedTokens: sentTools
        .filter((tool) => !shaped.deferredToolNames.has(tool.name))
        .reduce((sum, tool) => sum + tool.tokens, 0),
      loadedTokens: loaded.reduce((sum, tool) => sum + tool.tokens, 0),
    },
    components,
    request: {
      requestId: record.requestId,
      startedAt: record.startedAt,
      ...(record.turnId ? { turnId: record.turnId } : {}),
      protocol: record.protocol,
      model: record.model.sent,
      bytes: record.wireBytes ?? record.bodyBytes ?? partBytes,
      inputTokens: usage
        ? usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
        : 0,
      unsent: {
        messages: unsent.length,
        bytes: unsentSegments.reduce((sum, segment) => sum + segment.bytes, 0),
        tokens: unsentSegments.reduce((sum, segment) => sum + segment.tokens, 0),
      },
    },
  };
}

// ─── Entry ──────────────────────────────────────────────────────────────

export async function computeContextBreakdown(input: ContextBreakdownInput): Promise<ContextBreakdown> {
  const { cwd, model, messages } = input;
  const systemPrompt = renderSystemPrompt(input.systemPrompt.systemParts);
  // Mirror the real request: with tool search on, deferred tools that
  // haven't been loaded cost nothing — only the shaped `tools[]` counts.
  const profile = await resolveProfile(model, cwd);
  const shaped = prepareToolSearchRequest({
    tools: getToolsForMode(input.permissionMode),
    messages,
    model: profile.model,
    env: {
      protocol: profile.protocol,
      baseURL: profile.baseURL ?? process.env.ANTHROPIC_BASE_URL,
      settings: await loadFeatureSettings(cwd),
    },
    hasPendingMcpServers: hasPendingMcpServers(),
    source: "context",
  });
  const contextWindow = getContextWindowForModel(model);
  const snapshot = buildTokenBudgetSnapshot(messages, { systemPrompt, model });
  const base = {
    model,
    contextWindow,
    estimated: true as const,
    conversationTokens: snapshot.estimatedConversationTokens,
    autoCompactThreshold: snapshot.autoCompactThreshold,
  };
  const last = input.lastRequest;
  const unsent = last && messagesSince(last.conversation, messages, input.busy === true);
  if (last && unsent) return fromRequest(base, last.record, unsent, shaped);

  // Rule files and the memory index count only when the pinned prompt carries
  // them: the Agent can leave either source or its section out.
  const sectionText = (name: PromptSectionName) =>
    input.systemPrompt.sections.find((section) => section.name === name)?.text ?? "";
  const [agentMdFiles, memoryIndex] = await Promise.all([
    sectionText("agent_md") ? listAgentMdFiles(cwd).catch(() => []) : [],
    readMemoryEntrypoint(cwd).catch(() => null),
  ]);
  const memoryEntry =
    memoryIndex && sectionText("memory").includes(`Memory index:\n${memoryIndex}`) ? memoryIndex : null;
  const loadedAgentMd = agentMdFiles.filter((file) => !file.excluded);
  const agentMd = loadedAgentMd.map(formatAgentMdSection).join("\n\n");

  const memoryTokens = estimateTextTokens(`${agentMd}\n${memoryEntry ?? ""}`);
  const systemTotalTokens = estimateSystemPromptTokens(systemPrompt);
  const systemCoreTokens = Math.max(0, systemTotalTokens - memoryTokens);
  const toolTokens = estimateJsonTokens(JSON.stringify(shaped.tools));
  const historyTokens = roughTokenCountEstimationForMessages(messages);

  const used = systemCoreTokens + memoryTokens + toolTokens + historyTokens;

  const pluginNames = new Map(getActivePlugins().map((plugin) => [plugin.pluginId, plugin.name]));
  const rulePieces: Piece[] = [
    ...loadedAgentMd.map(
      (file): Piece => ({
        category: "rules",
        item: { id: file.filePath, label: file.filePath, source: file.scope === "global" ? "user" : "project" },
        weight: formatAgentMdSection(file).length + 2,
      }),
    ),
    ...(memoryEntry
      ? [
          {
            category: "rules",
            item: { id: "memory", label: "MEMORY.md", source: "project" },
            weight: memoryEntry.length + 1,
          } as Piece,
        ]
      : []),
  ];
  const messagePieces = messages.map(
    (message): Piece => ({
      category: "messages",
      item: messageKind(message),
      weight: estimateMessageTokens(message),
    }),
  );

  const loaded = [...shaped.deferredToolNames].filter((name) => shaped.discoveredToolNames.has(name));
  return {
    ...base,
    basis: "estimate",
    used,
    free: Math.max(0, contextWindow - used),
    categories: assemble([
      {
        total: systemCoreTokens,
        pieces: promptPieces(input, memoryEntry?.length ?? 0, pluginNames),
        fallback: { category: "system", item: { id: "instructions", label: "Instructions" }, weight: 1 },
      },
      {
        total: memoryTokens,
        pieces: rulePieces,
        fallback: { category: "rules", item: { id: "memory", label: "Project memory" }, weight: 1 },
      },
      {
        total: toolTokens,
        pieces: toolPieces(shaped.tools, pluginNames),
        fallback: { category: "tools", item: { id: "tools", label: "Tool list" }, weight: 1 },
      },
      {
        total: historyTokens,
        pieces: messagePieces,
        fallback: { category: "messages", item: { id: "user", label: "User messages" }, weight: 1 },
      },
    ]),
    totals: { systemPrompt: systemCoreTokens, memory: memoryTokens, tools: toolTokens, conversation: historyTokens },
    toolSearch: {
      enabled: shaped.enabled,
      deferred: [...shaped.deferredToolNames],
      loaded,
      sentTools: shaped.tools.length,
      alwaysLoadedTokens: estimateJsonTokens(
        JSON.stringify(shaped.tools.filter((tool) => !shaped.deferredToolNames.has(tool.name))),
      ),
      loadedTokens: loaded.length
        ? estimateJsonTokens(JSON.stringify(shaped.tools.filter((tool) => shaped.deferredToolNames.has(tool.name))))
        : 0,
    },
    components: [],
  };
}
