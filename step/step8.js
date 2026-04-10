/**
 * Step 8 - QueryEngine for multi-turn orchestration
 *
 * Goal:
 * - keep session state outside the UI
 * - rebuild the system prompt each turn
 * - accumulate token usage across the whole session
 * - handle slash commands in one place
 */

import { query } from "./step4.js";
import { buildSystemPrompt } from "./step6.js";

function emptyUsage() {
  return { input_tokens: 0, output_tokens: 0 };
}

export class QueryEngine {
  constructor({ model, toolContext, permissionMode = "default" }) {
    this.messages = [];
    this.totalUsage = emptyUsage();
    this.defaultModel = model;
    this.sessionModelOverride = null;
    this.toolContext = toolContext;
    this.permissionMode = permissionMode;
    this.abortController = null;
  }

  getActiveModel() {
    return this.sessionModelOverride || this.defaultModel;
  }

  interrupt() {
    if (!this.abortController) return false;
    this.abortController.abort();
    this.abortController = null;
    return true;
  }

  async *submitMessage(input) {
    const text = input.trim();
    if (!text) return { handled: false };

    if (text.startsWith("/")) {
      return yield* this.handleCommand(text);
    }

    const userMessage = { role: "user", content: text };
    this.messages.push(userMessage);
    yield { type: "messages_updated", messages: [...this.messages] };

    this.abortController = new AbortController();
    const systemPrompt = await buildSystemPrompt({ cwd: this.toolContext.cwd });

    const loop = query({
      messages: [...this.messages],
      model: this.getActiveModel(),
      systemPrompt,
      toolContext: {
        ...this.toolContext,
        abortSignal: this.abortController.signal,
      },
    });

    while (true) {
      const { value, done } = await loop.next();
      if (done) {
        this.messages = [...value.state.messages];
        this.totalUsage.input_tokens += value.usage.input_tokens;
        this.totalUsage.output_tokens += value.usage.output_tokens;
        yield { type: "usage_updated", totalUsage: { ...this.totalUsage } };
        return { handled: true, reason: value.reason };
      }

      yield value;

      if (value.type === "assistant_message" || value.type === "tool_result_message") {
        this.messages.push(value.message);
        yield { type: "messages_updated", messages: [...this.messages] };
      }
    }
  }

  async *handleCommand(command) {
    if (command === "/clear") {
      this.messages = [];
      yield { type: "messages_updated", messages: [] };
      yield { type: "command", kind: "info", message: "Conversation cleared." };
      return { handled: true };
    }

    if (command === "/cost") {
      yield {
        type: "command",
        kind: "info",
        message: `Input=${this.totalUsage.input_tokens}, Output=${this.totalUsage.output_tokens}`,
      };
      return { handled: true };
    }

    if (command.startsWith("/model ")) {
      const nextModel = command.slice("/model ".length).trim();
      this.sessionModelOverride = nextModel || null;
      yield { type: "command", kind: "info", message: `Active model: ${this.getActiveModel()}` };
      return { handled: true };
    }

    if (command === "/help") {
      yield { type: "command", kind: "info", message: "Commands: /help /clear /cost /model <name>" };
      return { handled: true };
    }

    yield { type: "command", kind: "error", message: `Unknown command: ${command}` };
    return { handled: true };
  }
}
