/**
 * Context window breakdown of a session — the numbers `/context` prints and
 * `AgentSession.getContext()` returns.
 *
 * Everything is measured on what the next request would carry: the system
 * prompt the session pinned (not a freshly rebuilt one), the tool list after
 * ToolSearch shaping for the active model and mode, and the conversation.
 * Totals use the same character heuristics as the auto-compactor. Each total
 * is then split into items by the size of the text each item contributes, so
 * the items of a category always add up to the category, and the categories
 * add up to the estimated usage.
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
  estimateJsonTokens,
  estimateMessageTokens,
  estimateSystemPromptTokens,
  estimateTextTokens,
  getContextWindowForModel,
  roughTokenCountEstimationForMessages,
} from "../../utils/tokens.js";
import { prepareToolSearchRequest } from "../../utils/toolSearch.js";

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

export interface ContextBreakdown {
  model: string;
  contextWindow: number;
  /** Every figure is an estimate from character counts. */
  estimated: true;
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
}

export interface ContextBreakdownInput {
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  messages: readonly MessageParam[];
  /** The system prompt the next request uses, with its dynamic sections. */
  systemPrompt: { systemParts: string[]; sections: PromptSection[] };
}

/** Split `total` in proportion to `weights`; the parts are integers that add up to `total`. */
export function distributeTokens(total: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((acc, weight) => acc + Math.max(0, weight), 0);
  if (sum === 0) return weights.map((_, index) => (index === 0 ? total : 0));
  const exact = weights.map((weight) => (Math.max(0, weight) / sum) * total);
  const parts = exact.map(Math.floor);
  let rest = total - parts.reduce((acc, part) => acc + part, 0);
  const order = exact.map((value, index) => ({ index, remainder: value - Math.floor(value) }));
  order.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of order) {
    if (rest <= 0) break;
    parts[index]! += 1;
    rest -= 1;
  }
  return parts;
}

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
    pieces.push({ category: "system", item: { id: section.name, label: SECTION_LABELS[section.name] }, weight });
  }
  return pieces;
}

/** Pieces of the tool list: one per tool sent, grouped later by server or plugin. */
function toolPieces(tools: readonly { name: string }[], pluginNames: Map<string, string>): Piece[] {
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
  return tools.map((tool) => {
    const weight = JSON.stringify(tool).length + 1;
    const server = serverOf.get(tool.name);
    if (!server) return { category: "tools", item: { id: tool.name, label: tool.name, source: "built-in" }, weight };
    const pluginId = pluginOfServer.get(server.name);
    if (pluginId) {
      return {
        category: "plugins",
        item: { id: pluginId, label: pluginNames.get(pluginId) ?? pluginId, source: "plugin", pluginId },
        weight,
      };
    }
    return { category: "mcp", item: { id: server.name, label: server.name, source: server.scope }, weight };
  });
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
  const [agentMdFiles, memoryEntry] = await Promise.all([
    listAgentMdFiles(cwd).catch(() => []),
    readMemoryEntrypoint(cwd).catch(() => null),
  ]);
  const loadedAgentMd = agentMdFiles.filter((file) => !file.excluded);
  const agentMd = loadedAgentMd.map(formatAgentMdSection).join("\n\n");

  const memoryTokens = estimateTextTokens(`${agentMd}\n${memoryEntry ?? ""}`);
  const systemTotalTokens = estimateSystemPromptTokens(systemPrompt);
  const systemCoreTokens = Math.max(0, systemTotalTokens - memoryTokens);
  const toolTokens = estimateJsonTokens(JSON.stringify(shaped.tools));
  const historyTokens = roughTokenCountEstimationForMessages(messages);

  const contextWindow = getContextWindowForModel(model);
  const used = systemCoreTokens + memoryTokens + toolTokens + historyTokens;
  const snapshot = buildTokenBudgetSnapshot(messages, { systemPrompt, model });

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
    model,
    contextWindow,
    estimated: true,
    used,
    free: Math.max(0, contextWindow - used),
    conversationTokens: snapshot.estimatedConversationTokens,
    autoCompactThreshold: snapshot.autoCompactThreshold,
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
  };
}
