/**
 * Serves a JSON-RPC peer on this process's stdin and stdout.
 *
 * stdout carries protocol messages only. Anything else that writes to it —
 * a `console.log` deep in a dependency, a library banner — is redirected to
 * stderr, so a stray write can never corrupt the stream a client is parsing.
 *
 * The process exits with 0 when the server asks for it or when stdin closes:
 * the server is disposed first (which ends running work), requests still in
 * flight are answered, and stdout is drained. An error that escapes exits
 * with 1.
 */

import * as readline from "node:readline";

export interface StdioServer {
  receive(line: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface StdioConnection {
  /** Write one serialized message. */
  send(line: string): void;
  /** Ask the host to exit with 0 once in-flight work settles. */
  exit(): void;
  logError(message: string): void;
}

export async function serveOverStdio(create: (connection: StdioConnection) => StdioServer): Promise<never> {
  const stdout = claimStdout();
  const inFlight = new Set<Promise<void>>();
  let exiting = false;
  const exit = async (code: number): Promise<void> => {
    if (exiting) return;
    exiting = true;
    await server.dispose().catch(() => {});
    await Promise.allSettled(inFlight);
    // stdout to a pipe is asynchronous; exiting before it drains drops the last messages.
    await stdout.flush();
    process.exit(code);
  };

  const server = create({
    send: (line) => stdout.write(`${line}\n`),
    exit: () => void exit(0),
    logError: (message) => process.stderr.write(`${message}\n`),
  });

  process.on("uncaughtException", (error) => {
    process.stderr.write(`[easy-agent] fatal: ${error.stack ?? error.message}\n`);
    void exit(1);
  });

  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  lines.on("line", (line) => {
    // Requests run concurrently; a long-running request must not hold up a cancel.
    const handled = server.receive(line);
    inFlight.add(handled);
    void handled.finally(() => inFlight.delete(handled));
  });
  lines.on("close", () => void exit(0));
  return new Promise<never>(() => {});
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
