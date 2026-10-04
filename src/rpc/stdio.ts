/**
 * Runs the RPC server on this process's stdin and stdout.
 *
 * stdout carries protocol messages only. Anything else that writes to it —
 * a `console.log` deep in a dependency, a library banner — is redirected to
 * stderr, so a stray write can never corrupt the stream a client is parsing.
 *
 * The process exits with 0 after `shutdown` or when stdin closes, once every
 * session is closed. An error that escapes the server exits with 1.
 */

import * as readline from "node:readline";
import { createAgentRuntime } from "../sdk/index.js";
import { RpcServer } from "./server.js";

export interface RunRpcOptions {
  cwd: string;
  pluginDirs: readonly string[];
  version: string;
}

export async function runRpcOverStdio(options: RunRpcOptions): Promise<void> {
  const stdout = claimStdout();
  let exiting = false;
  const exit = async (code: number): Promise<void> => {
    if (exiting) return;
    exiting = true;
    // Closing the sessions ends running turns, so in-flight requests answer promptly.
    await server.dispose().catch(() => {});
    await Promise.allSettled(inFlight);
    // stdout to a pipe is asynchronous; exiting before it drains drops the last messages.
    await stdout.flush();
    process.exit(code);
  };

  const server = new RpcServer({
    ...options,
    send: (line) => stdout.write(`${line}\n`),
    onShutdown: () => void exit(0),
    createRuntime: createAgentRuntime,
    logError: (message) => process.stderr.write(`${message}\n`),
  });

  process.on("uncaughtException", (error) => {
    process.stderr.write(`[easy-agent] rpc fatal: ${error.stack ?? error.message}\n`);
    void exit(1);
  });

  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  const inFlight = new Set<Promise<void>>();
  lines.on("line", (line) => {
    // Requests run concurrently; a long `session/send` must not hold up `session/interrupt`.
    const handled = server.receive(line);
    inFlight.add(handled);
    void handled.finally(() => inFlight.delete(handled));
  });
  lines.on("close", () => void exit(0));
  await new Promise<never>(() => {});
}

/** Take stdout for the protocol and send every other write to stderr. */
function claimStdout(): { write(text: string): void; flush(): Promise<void> } {
  const write = process.stdout.write.bind(process.stdout) as (text: string, callback?: () => void) => boolean;
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) =>
    (process.stderr.write as (...args: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;
  return {
    write: (text) => {
      write(text);
    },
    flush: () => new Promise<void>((resolve) => write("", () => resolve())),
  };
}
