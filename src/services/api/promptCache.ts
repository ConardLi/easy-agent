/**
 * Prompt caching for Anthropic Messages requests.
 *
 * The API caches the request prefix in the order tools → system → messages
 * and serves it from cache when a later request repeats the prefix up to a
 * block marked with `cache_control`. A request may carry at most four
 * markers; this module places them on:
 *
 *   1. the end of the static system prompt block, which changes only with
 *      the binary or an output style that drops the coding instructions;
 *   2. the end of the dynamic system prompt block, which the session prompt
 *      context keeps fixed for the whole session;
 *   3. the tail of the previous request — the user message right before the
 *      latest assistant message. That request wrote its cache entry there,
 *      so marking it again guarantees a read even when the newest turn added
 *      more content blocks than the API looks back over;
 *   4. the last message, so the next request can read the whole
 *      conversation from cache.
 *
 * A system prompt without the static/dynamic split (custom agent prompts,
 * single-shot callers) is one marked block, and the last loaded tool takes
 * the spare marker so tool schemas stay cached on their own.
 *
 * Inputs are never mutated: marked messages and tools are shallow copies,
 * so session history and tool registries never contain cache markers.
 */

import type { MessageParam, TextBlockParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { ApiToolParam } from "../../tools/Tool.js";
import { SYSTEM_PROMPT_STATIC_END } from "../../constants/systemPromptMarkers.js";

const EPHEMERAL = { type: "ephemeral" } as const;

/** Content block types that accept a `cache_control` marker. */
const MARKABLE_BLOCK_TYPES = new Set(["text", "image", "document", "search_result", "tool_use", "tool_result"]);

/** Compatibility switch for endpoints that reject `cache_control` or `prompt_cache_key`. */
export function isPromptCachingDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.EASY_AGENT_DISABLE_PROMPT_CACHING?.trim() ?? "");
}

/**
 * Split the rendered system prompt after its static block and mark both
 * blocks. Prompts without the static block marker are one marked block.
 */
export function buildCachedSystem(system: string): TextBlockParam[] {
  const end = system.indexOf(SYSTEM_PROMPT_STATIC_END);
  if (end === -1) return [{ type: "text", text: system, cache_control: EPHEMERAL }];
  const split = end + SYSTEM_PROMPT_STATIC_END.length;
  const staticText = system.slice(0, split);
  const dynamicText = system.slice(split).replace(/^\s+/, "");
  const blocks: TextBlockParam[] = [{ type: "text", text: staticText, cache_control: EPHEMERAL }];
  if (dynamicText) blocks.push({ type: "text", text: dynamicText, cache_control: EPHEMERAL });
  return blocks;
}

/**
 * Mark the last tool that is part of the prompt. Deferred tools are not
 * loaded into the prompt until discovered, so they are skipped.
 */
export function withToolsCacheBreakpoint(tools: ApiToolParam[]): ApiToolParam[] {
  for (let index = tools.length - 1; index >= 0; index--) {
    if (tools[index]!.defer_loading) continue;
    return tools.map((tool, i) => (i === index ? { ...tool, cache_control: EPHEMERAL } : tool));
  }
  return tools;
}

/** Mark the last message and the previous request's last message. */
export function withMessageCacheBreakpoints(messages: MessageParam[]): MessageParam[] {
  const last = messages.length - 1;
  if (last < 0) return messages;
  const targets = new Set([last]);
  let latestAssistant = last - 1;
  while (latestAssistant >= 0 && messages[latestAssistant]!.role !== "assistant") latestAssistant--;
  for (let index = latestAssistant - 1; index >= 0; index--) {
    if (messages[index]!.role === "user") {
      targets.add(index);
      break;
    }
  }
  return messages.map((message, index) => (targets.has(index) ? markMessage(message) : message));
}

function markMessage(message: MessageParam): MessageParam {
  if (typeof message.content === "string") {
    if (!message.content) return message;
    return { ...message, content: [{ type: "text", text: message.content, cache_control: EPHEMERAL }] };
  }
  const blocks = message.content;
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index] as { type: string; text?: string };
    if (!MARKABLE_BLOCK_TYPES.has(block.type)) continue;
    if (block.type === "text" && !block.text) continue;
    const content = blocks.slice();
    content[index] = { ...blocks[index], cache_control: EPHEMERAL } as (typeof blocks)[number];
    return { ...message, content };
  }
  return message;
}

/**
 * Anthropic request fields with cache markers applied: the system blocks,
 * the tools (marked only when the system prompt leaves a marker spare), and
 * optionally the messages.
 */
export function applyAnthropicPromptCache(input: {
  system?: string;
  tools?: ApiToolParam[];
  messages: MessageParam[];
  markMessages: boolean;
}): { system?: TextBlockParam[]; tools?: ApiToolParam[]; messages: MessageParam[] } {
  const system = input.system ? buildCachedSystem(input.system) : undefined;
  const markTools = (system?.length ?? 0) < 2;
  return {
    ...(system ? { system } : {}),
    ...(input.tools && input.tools.length > 0
      ? { tools: markTools ? withToolsCacheBreakpoint(input.tools) : input.tools }
      : {}),
    messages: input.markMessages ? withMessageCacheBreakpoints(input.messages) : input.messages,
  };
}
