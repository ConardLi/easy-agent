/**
 * Step 28 - Pipe / headless mode
 *
 * Goal:
 * - treat QueryEngine.submitMessage() as an SDK-style event stream
 * - merge stdin and prompt arguments
 * - render the same events as text, json, or stream-json
 * - avoid interactive permission prompts in non-interactive mode
 */

import { EventEmitter } from "node:events";

// -----------------------------------------------------------------------------
// 1. Input merging
// -----------------------------------------------------------------------------

export function mergePromptInputs(stdinText, promptArg) {
  const stdin = String(stdinText || "").trim();
  const prompt = String(promptArg || "").trim();
  if (stdin && prompt) return `${stdin}\n\n${prompt}`;
  return stdin || prompt;
}

export async function readStdin(stream = process.stdin) {
  if (stream.isTTY) return "";
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export function isPrintMode(argv) {
  return argv.includes("--print") || argv.includes("-p");
}

export function parseOutputFormat(argv) {
  const index = argv.indexOf("--output-format");
  const value = index >= 0 ? argv[index + 1] : "text";
  if (["text", "json", "stream-json"].includes(value)) return value;
  throw new Error(`Unsupported output format: ${value}`);
}

// -----------------------------------------------------------------------------
// 2. Non-interactive permissions
// -----------------------------------------------------------------------------

export function createHeadlessPermissionHandler(options = {}) {
  return async function onPermissionRequest(request) {
    if (options.bypassPermissions) return "allow_once";
    if (request?.decision === "allow") return "allow_once";
    if (request?.decision === "deny") return "deny";
    return "deny";
  };
}

// -----------------------------------------------------------------------------
// 3. Result and stream-json messages
// -----------------------------------------------------------------------------

export function extractAssistantText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text")
    .map((block) => block.text || "")
    .join("");
}

export function subtypeForReason(reason) {
  if (reason === "completed") return "success";
  if (reason === "max_turns") return "error_max_turns";
  return "error_during_execution";
}

export function exitCodeForReason(reason) {
  return reason === "completed" ? 0 : 1;
}

export function buildInitMessage(options) {
  return {
    type: "system",
    subtype: "init",
    cwd: options.cwd,
    session_id: options.sessionId,
    model: options.model,
    permissionMode: options.permissionMode || "default",
    tools: options.tools || [],
    slash_commands: options.slashCommands || [],
    agents: options.agents || [],
    output_style: options.outputStyle || "default",
  };
}

export function buildResultMessage(options) {
  const subtype = subtypeForReason(options.reason);
  return {
    type: "result",
    subtype,
    is_error: subtype !== "success",
    result: options.result || "",
    session_id: options.sessionId,
    num_turns: options.numTurns || 0,
    duration_ms: options.durationMs || 0,
    total_cost_usd: options.totalCostUsd || 0,
    usage: options.usage || { input_tokens: 0, output_tokens: 0 },
  };
}

export function installStreamJsonStdoutGuard(stdout = process.stdout, stderr = process.stderr) {
  const originalWrite = stdout.write.bind(stdout);
  stdout.write = function guardedWrite(chunk, encoding, callback) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const lines = text.split(/\n/).filter(Boolean);
    const allJson = lines.every((line) => {
      try {
        JSON.parse(line);
        return true;
      } catch {
        return false;
      }
    });
    if (allJson) return originalWrite(chunk, encoding, callback);
    return stderr.write(chunk, encoding, callback);
  };
  return () => {
    stdout.write = originalWrite;
  };
}

// -----------------------------------------------------------------------------
// 4. Consume QueryEngine events
// -----------------------------------------------------------------------------

export async function collectHeadlessRun(engine, input) {
  let finalText = "";
  let reason = "completed";
  let numTurns = 0;
  let usage = { input_tokens: 0, output_tokens: 0 };
  const streamEvents = [];

  for await (const event of engine.submitMessage(input)) {
    if (event.type === "assistant_message") {
      finalText = extractAssistantText(event.message) || finalText;
      streamEvents.push({ type: "assistant", message: event.message });
    } else if (event.type === "tool_result_message") {
      streamEvents.push({ type: "user", message: event.message });
    } else if (event.type === "turn_complete") {
      reason = event.reason;
      numTurns = event.turnCount;
    } else if (event.type === "usage_updated") {
      usage = event.totalUsage;
    } else if (event.type === "error") {
      reason = "model_error";
    }
  }

  return { finalText, reason, numTurns, usage, streamEvents };
}

export async function runHeadless(engine, options) {
  const input = mergePromptInputs(options.stdinText, options.promptArg);
  if (!input) {
    return { stdout: "", stderr: "Error: no input\n", exitCode: 1 };
  }

  const started = Date.now();
  const collected = await collectHeadlessRun(engine, input);
  const result = buildResultMessage({
    result: collected.finalText,
    reason: collected.reason,
    sessionId: options.sessionId || "session-demo",
    numTurns: collected.numTurns,
    durationMs: Date.now() - started,
    usage: collected.usage,
  });

  if (options.outputFormat === "json") {
    return { stdout: `${JSON.stringify(result)}\n`, stderr: "", exitCode: exitCodeForReason(collected.reason) };
  }

  if (options.outputFormat === "stream-json") {
    const init = buildInitMessage({
      cwd: options.cwd || process.cwd(),
      sessionId: options.sessionId || "session-demo",
      model: options.model || "default-model",
      permissionMode: options.permissionMode || "default",
      tools: options.tools || [],
    });
    const lines = [init, ...collected.streamEvents, result].map((line) => JSON.stringify(line));
    return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: exitCodeForReason(collected.reason) };
  }

  return {
    stdout: collected.finalText.endsWith("\n") ? collected.finalText : `${collected.finalText}\n`,
    stderr: "",
    exitCode: exitCodeForReason(collected.reason),
  };
}

// -----------------------------------------------------------------------------
// 5. Tiny fake QueryEngine for the demo
// -----------------------------------------------------------------------------

export class FakeQueryEngine extends EventEmitter {
  async *submitMessage(input) {
    yield {
      type: "assistant_message",
      message: { role: "assistant", content: [{ type: "text", text: `processed: ${input}` }] },
    };
    yield { type: "usage_updated", totalUsage: { input_tokens: 10, output_tokens: 5 } };
    yield { type: "turn_complete", reason: "completed", turnCount: 1 };
  }
}

export async function demoStep28() {
  const engine = new FakeQueryEngine();
  const text = await runHeadless(engine, {
    stdinText: "const x = 1;",
    promptArg: "explain this code",
    outputFormat: "text",
  });
  const json = await runHeadless(engine, {
    stdinText: "",
    promptArg: "say hi",
    outputFormat: "json",
    sessionId: "s1",
  });
  const stream = await runHeadless(engine, {
    stdinText: "",
    promptArg: "say hi",
    outputFormat: "stream-json",
    sessionId: "s1",
    tools: ["Read", "Bash"],
  });
  return {
    merged: mergePromptInputs("file contents", "summarize"),
    text: text.stdout.trim(),
    json: JSON.parse(json.stdout),
    streamLines: stream.stdout.trim().split("\n").map((line) => JSON.parse(line).type),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await demoStep28(), null, 2));
}
