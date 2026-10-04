#!/usr/bin/env node
/**
 * Minimal Easy Agent RPC client.
 *
 *   node examples/rpc-client.mjs "Explain this repository"
 *   node examples/rpc-client.mjs --yes "Create notes.txt"   # approve every confirmation
 *
 * Starts `eagent --rpc` in the current directory, opens a session, sends one
 * prompt, streams the reply, asks on the terminal when a tool needs
 * confirmation, and shuts the server down. Set EAGENT_COMMAND to run a
 * different binary, e.g. EAGENT_COMMAND="node dist/eagent.js".
 *
 * Uses only Node built-ins; see docs/rpc.md for the protocol.
 */

import { spawn } from "node:child_process";
import * as readline from "node:readline";

const args = process.argv.slice(2);
const approveAll = args.includes("--yes");
const prompt = args.filter((arg) => arg !== "--yes").join(" ") || "Say hello.";
const [command, ...commandArgs] = (process.env.EAGENT_COMMAND ?? "eagent").split(" ");

const server = spawn(command, [...commandArgs, "--rpc"], { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let nextId = 1;

/** Send a request and resolve with its result; reject with its error. */
function call(method, params = {}) {
  const id = nextId++;
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const terminal = readline.createInterface({ input: process.stdin, output: process.stderr });
const ask = (question) => new Promise((resolve) => terminal.question(question, resolve));

async function answer(sessionId, request) {
  if (request.kind === "question") {
    // A fuller client would show the options; this one declines to answer.
    return call("session/respond", { sessionId, requestId: request.id, response: { cancelled: true } });
  }
  const yes = approveAll || /^y/i.test(await ask(`\nAllow ${request.toolName}: ${request.summary}? [y/N] `));
  const response =
    request.kind === "plan_approval"
      ? { decision: yes ? "approve" : "reject" }
      : { decision: yes ? "allow_once" : "deny" };
  return call("session/respond", { sessionId, requestId: request.id, response });
}

readline.createInterface({ input: server.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  if ("id" in message && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
    else resolve(message.result);
    return;
  }
  if (message.method !== "session/event") return;
  const event = message.params;
  if (event.type === "text_delta") process.stdout.write(event.text);
  if (event.type === "tool_started") process.stderr.write(`\n[tool] ${event.name}\n`);
  if (event.type === "request_opened") void answer(event.sessionId, event.request);
});

try {
  const init = await call("initialize", { protocolVersion: 1, clientInfo: { name: "rpc-client-example" } });
  if (!init.workspace.projectTrusted)
    process.stderr.write("[note] workspace not trusted; project settings are ignored\n");
  const { sessionId } = await call("session/create");
  const result = await call("session/send", { sessionId, input: prompt });
  process.stdout.write(`\n[stopped: ${result.reason ?? "local command"}]\n`);
  await call("shutdown");
} catch (error) {
  process.stderr.write(`\n${error.message}\n`);
  process.exitCode = 1;
  server.kill();
} finally {
  terminal.close();
}
