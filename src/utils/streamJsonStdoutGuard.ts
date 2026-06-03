/**
 * stdout guard for `--output-format stream-json`.
 *
 * SDK / CI consumers of stream-json parse stdout line-by-line as NDJSON. Any
 * stray write — a console.log from a dependency, a debug print, a library
 * banner — breaks the consumer's parser mid-stream with no recovery path.
 *
 * This guard wraps `process.stdout.write`: writes are buffered until a newline
 * arrives, then each complete line is JSON-parsed. Lines that parse are
 * forwarded to the real stdout; lines that don't are diverted to stderr,
 * tagged with a marker so they stay visible without corrupting the stream.
 *
 * The blessed JSON path (the headless emitter) always writes
 * `JSON.stringify(msg) + "\n"`, so it passes straight through. Only out-of-band
 * writes are diverted.
 *
 * Reference: claude-code-source-code/src/utils/streamJsonStdoutGuard.ts.
 */

/** Written to stderr ahead of any diverted non-JSON line. */
export const STDOUT_GUARD_MARKER = "[stdout-guard]";

let installed = false;
let buffer = "";
let originalWrite: typeof process.stdout.write | null = null;

function isJsonLine(line: string): boolean {
  // Empty lines are tolerated in NDJSON streams.
  if (line.length === 0) return true;
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

/**
 * Install the guard. Idempotent. Registers an `exit` flush so any partial
 * non-newline-terminated buffer left at shutdown is diverted rather than lost.
 */
export function installStreamJsonStdoutGuard(): void {
  if (installed) return;
  installed = true;

  originalWrite = process.stdout.write.bind(process.stdout) as typeof process.stdout.write;

  process.stdout.write = function (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error) => void),
    cb?: (err?: Error) => void,
  ): boolean {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");

    buffer += text;
    let newlineIdx: number;
    let wrote = true;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      if (isJsonLine(line)) {
        wrote = originalWrite!(line + "\n");
      } else {
        process.stderr.write(`${STDOUT_GUARD_MARKER} ${line}\n`);
      }
    }

    const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
    if (callback) queueMicrotask(() => callback());
    return wrote;
  } as typeof process.stdout.write;

  process.on("exit", () => {
    if (buffer.length > 0) {
      if (originalWrite && isJsonLine(buffer)) {
        originalWrite(buffer + "\n");
      } else {
        process.stderr.write(`${STDOUT_GUARD_MARKER} ${buffer}\n`);
      }
      buffer = "";
    }
  });
}
