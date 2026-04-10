/**
 * Step 4 - Minimal Agentic Loop
 *
 * Goal:
 * - let the model request tools
 * - execute tools
 * - feed tool results back into the conversation
 * - continue until the model finishes the turn
 */

import { streamMessage } from "./step1.js";
import { findToolByName, getToolsApiParams } from "./step3.js";

export async function runTools(contentBlocks, toolContext) {
  const results = [];

  for (const block of contentBlocks) {
    if (block.type !== "tool_use") continue;

    const tool = findToolByName(block.name);
    if (!tool) {
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: `Error: unknown tool ${block.name}`,
        is_error: true,
      });
      continue;
    }

    const result = await tool.call(block.input, toolContext);
    results.push({
      type: "tool_result",
      tool_use_id: block.id,
      content: result.content,
      ...(result.isError ? { is_error: true } : {}),
    });
  }

  return { role: "user", content: results };
}

export async function* query({ messages, model, systemPrompt, toolContext, maxTurns = 8 }) {
  const state = {
    messages: [...messages],
    turnCount: 0,
  };

  while (state.turnCount < maxTurns) {
    state.turnCount += 1;

    const stream = streamMessage({
      messages: state.messages,
      model,
      system: systemPrompt,
      tools: getToolsApiParams(),
    });

    let result;
    while (true) {
      const { value, done } = await stream.next();
      if (done) {
        result = value;
        break;
      }

      // Re-yield low-level stream events to the UI layer.
      yield value;
    }

    state.messages.push(result.assistantMessage);
    yield { type: "assistant_message", message: result.assistantMessage };

    if (result.stopReason !== "tool_use") {
      return { state, usage: result.usage, reason: "completed" };
    }

    const toolResultMessage = await runTools(result.assistantMessage.content, toolContext);
    state.messages.push(toolResultMessage);

    yield { type: "tool_result_message", message: toolResultMessage };
  }

  return {
    state,
    usage: { input_tokens: 0, output_tokens: 0 },
    reason: "max_turns",
  };
}
