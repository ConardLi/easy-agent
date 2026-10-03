/**
 * Prompt caching for Anthropic Messages requests.
 *
 * The API caches the request prefix in the order tools → system → messages
 * and serves it from cache when a later request repeats the prefix up to a
 * block marked with `cache_control`. A request may carry at most four
 * markers; this module places them on:
 *
 *   1. the last tool definition that is loaded into the prompt, so tool
 *      schemas stay cached when the system prompt changes;
 *   2. the end of the static system prompt section, which only changes
 *      when the binary or the output-style mode changes;
 *   3. the previous user message, which the preceding request marked as its
 *      last message — marking it again guarantees a cache read even when the
 *      newest turn added more content blocks than the API looks back over;
 *   4. the last message, so the next request of the same tool loop can read
 *      the whole conversation from cache.
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

/** Compatibility switch for Anthropic-compatible endpoints that reject `cache_control`. */
export function isPromptCachingDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.EASY_AGENT_DISABLE_PROMPT_CACHING?.trim() ?? "");
}

/**
 * Split the rendered system prompt after its static section and mark that
 * section for caching. Prompts without the static section marker (custom
 * agent prompts, single-shot callers) are cached as one block.
 */
export function buildCachedSystem(system: string): TextBlockParam[] {
  const end = system.indexOf(SYSTEM_PROMPT_STATIC_END);
  if (end === -1) return [{ type: "text", text: system, cache_control: EPHEMERAL }];
  const split = end + SYSTEM_PROMPT_STATIC_END.length;
  const staticText = system.slice(0, split);
  const dynamicText = system.slice(split).replace(/^\s+/, "");
  const blocks: TextBlockParam[] = [{ type: "text", text: staticText, cache_control: EPHEMERAL }];
  if (dynamicText) blocks.push({ type: "text", text: dynamicText });
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

/** Mark the last message and the user message before it. */
export function withMessageCacheBreakpoints(messages: MessageParam[]): MessageParam[] {
  const last = messages.length - 1;
  if (last < 0) return messages;
  const targets = new Set([last]);
  for (let index = last - 1; index >= 0; index--) {
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
