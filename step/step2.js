/**
 * Step 2 - Minimal interactive REPL
 *
 * Goal:
 * - show how multi-turn chat works in the terminal
 * - keep state in memory
 * - print streaming text incrementally
 *
 * This version uses Node readline for teaching simplicity.
 * The real project uses React/Ink for a richer terminal UI.
 */

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { streamMessage } from "./step1.js";

export async function runRepl({ model, system } = {}) {
  const rl = readline.createInterface({ input, output });
  const messages = [];

  console.log("Easy Agent REPL");
  console.log("Type /exit to quit, /clear to clear history.");

  while (true) {
    const text = (await rl.question("> ")).trim();
    if (!text) continue;

    if (text === "/exit") break;
    if (text === "/clear") {
      messages.length = 0;
      console.log("(history cleared)");
      continue;
    }

    messages.push({ role: "user", content: text });

    const stream = streamMessage({ messages, model, system });
    let finalResult = null;

    process.stdout.write("assistant: ");

    while (true) {
      const { value, done } = await stream.next();
      if (done) {
        finalResult = value;
        break;
      }

      if (value.type === "text") {
        process.stdout.write(value.text);
      }

      if (value.type === "tool_use_start") {
        process.stdout.write("\n[tool: " + value.name + "]\n");
      }
    }

    process.stdout.write("\n\n");
    messages.push(finalResult.assistantMessage);

    console.log(
      "(tokens in/out: " + finalResult.usage.input_tokens + "/" + finalResult.usage.output_tokens + ")",
    );
  }

  rl.close();
}
