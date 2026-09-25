import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 500;

export type ProcessStopReason = "completed" | "timeout" | "idle_timeout" | "aborted" | "spawn_error";

export interface ControlledProcessOptions {
  executable: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string | Uint8Array;
  signal?: AbortSignal;
  timeoutMs: number;
  idleTimeoutMs?: number;
  maxOutputBytes?: number;
  terminationGraceMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface ControlledProcessResult {
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutOmittedBytes: number;
  stderrOmittedBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  reason: ProcessStopReason;
  spawnError?: Error;
  stdinError?: Error;
  durationMs: number;
}

/** A byte-bounded tail. Retained memory never grows with command output. */
class OutputTail {
  private readonly ring: Buffer;
  private retainedBytes = 0;
  private nextOffset = 0;
  totalBytes = 0;

  constructor(private readonly limitBytes: number) {
    this.ring = Buffer.allocUnsafe(limitBytes);
  }

  append(chunk: Buffer): void {
    this.totalBytes += chunk.byteLength;
    if (chunk.byteLength >= this.limitBytes) {
      chunk.copy(this.ring, 0, chunk.byteLength - this.limitBytes);
      this.retainedBytes = this.limitBytes;
      this.nextOffset = 0;
      return;
    }
    const firstLength = Math.min(chunk.byteLength, this.limitBytes - this.nextOffset);
    chunk.copy(this.ring, this.nextOffset, 0, firstLength);
    if (firstLength < chunk.byteLength) {
      chunk.copy(this.ring, 0, firstLength);
    }
    this.nextOffset = (this.nextOffset + chunk.byteLength) % this.limitBytes;
    this.retainedBytes = Math.min(this.limitBytes, this.retainedBytes + chunk.byteLength);
  }

  get omittedBytes(): number {
    return this.totalBytes - this.retainedBytes;
  }

  get truncated(): boolean {
    return this.omittedBytes > 0;
  }

  text(): string {
    if (this.retainedBytes < this.limitBytes) {
      return this.ring.subarray(0, this.retainedBytes).toString("utf8");
    }
    return Buffer.concat([
      this.ring.subarray(this.nextOffset),
      this.ring.subarray(0, this.nextOffset),
    ], this.limitBytes).toString("utf8");
  }
}

function positiveLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new RangeError(`${label} must be a positive integer no greater than 2147483647`);
  }
  return value;
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): Promise<void> | undefined {
  if (!child.pid) return;
  if (process.platform === "win32") {
    // taskkill /T follows the process tree; /F is needed because Windows
    // has no process-group TERM equivalent. Wait for taskkill to finish
    // before reporting that the command has stopped.
    return new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      let finished = false;
      const finish = (fallback: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(watchdog);
        if (fallback) {
          try { child.kill(); } catch { /* Already exited. */ }
        }
        resolve();
      };
      const watchdog = setTimeout(() => {
        killer.kill();
        finish(true);
      }, 5_000);
      killer.once("error", () => finish(true));
      killer.once("close", (code) => finish(code !== 0));
    });
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      try { child.kill(signal); } catch { /* Already exited. */ }
    }
  }
}

/**
 * Run a subprocess with bounded capture and one shutdown path for timeout,
 * idle timeout and cancellation. Resolves only after stdio has closed.
 */
export async function runControlledProcess(
  options: ControlledProcessOptions,
): Promise<ControlledProcessResult> {
  const timeoutMs = positiveLimit(options.timeoutMs, "timeoutMs");
  const idleTimeoutMs = options.idleTimeoutMs === undefined
    ? undefined
    : positiveLimit(options.idleTimeoutMs, "idleTimeoutMs");
  const maxOutputBytes = positiveLimit(options.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES, "maxOutputBytes");
  const terminationGraceMs = positiveLimit(
    options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
    "terminationGraceMs",
  );
  const startedAt = Date.now();
  const stdout = new OutputTail(maxOutputBytes);
  const stderr = new OutputTail(maxOutputBytes);

  if (options.signal?.aborted) {
    return {
      stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0,
      stdoutOmittedBytes: 0, stderrOmittedBytes: 0,
      stdoutTruncated: false, stderrTruncated: false,
      exitCode: null, signal: null, reason: "aborted", durationMs: 0,
    };
  }

  return new Promise<ControlledProcessResult>((resolve) => {
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    };
    const child = spawn(options.executable, options.args, spawnOptions);
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let reason: ProcessStopReason = "completed";
    let spawnError: Error | undefined;
    let stdinError: Error | undefined;
    let closed = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let treeTermination: Promise<void> | undefined;

    const stop = (why: Exclude<ProcessStopReason, "completed" | "spawn_error">) => {
      if (closed || reason !== "completed") return;
      reason = why;
      treeTermination = signalProcessTree(child, "SIGTERM");
      if (process.platform !== "win32") {
        killTimer = setTimeout(() => signalProcessTree(child, "SIGKILL"), terminationGraceMs);
      }
    };
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (idleTimeoutMs !== undefined && reason === "completed") {
        idleTimer = setTimeout(() => stop("idle_timeout"), idleTimeoutMs);
      }
    };
    const onAbort = () => stop("aborted");
    const wallTimer = setTimeout(() => stop("timeout"), timeoutMs);
    resetIdleTimer();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    const onData = (target: OutputTail, decoder: StringDecoder, observe: ((chunk: string) => void) | undefined) =>
      (chunk: Buffer) => {
        target.append(chunk);
        resetIdleTimer();
        if (observe) {
          const text = decoder.write(chunk);
          if (text) {
            try { observe(text); } catch { /* Observers cannot interrupt cleanup. */ }
          }
        }
      };
    child.stdout?.on("data", onData(stdout, stdoutDecoder, options.onStdout));
    child.stderr?.on("data", onData(stderr, stderrDecoder, options.onStderr));
    child.stdin?.on("error", (error: Error) => {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") stdinError = error;
    });
    child.on("error", (error: Error) => {
      spawnError = error;
      if (reason === "completed") reason = "spawn_error";
    });
    child.once("close", async (exitCode, exitSignal) => {
      closed = true;
      clearTimeout(wallTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (reason === "timeout" || reason === "idle_timeout" || reason === "aborted") {
        // A child can close while a grandchild survives with detached stdio.
        if (treeTermination) await treeTermination;
        if (process.platform !== "win32") signalProcessTree(child, "SIGKILL");
      }
      const remainingStdout = stdoutDecoder.end();
      const remainingStderr = stderrDecoder.end();
      if (remainingStdout) {
        try { options.onStdout?.(remainingStdout); } catch { /* Observer failed. */ }
      }
      if (remainingStderr) {
        try { options.onStderr?.(remainingStderr); } catch { /* Observer failed. */ }
      }
      resolve({
        stdout: stdout.text(), stderr: stderr.text(),
        stdoutBytes: stdout.totalBytes, stderrBytes: stderr.totalBytes,
        stdoutOmittedBytes: stdout.omittedBytes, stderrOmittedBytes: stderr.omittedBytes,
        stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated,
        exitCode, signal: exitSignal, reason,
        ...(spawnError ? { spawnError } : {}),
        ...(stdinError ? { stdinError } : {}),
        durationMs: Date.now() - startedAt,
      });
    });

    try {
      child.stdin?.end(options.stdin);
    } catch (error) {
      stdinError = error instanceof Error ? error : new Error(String(error));
    }
  });
}

export function formatCapturedOutput(value: string, omittedBytes: number): string {
  return omittedBytes > 0 ? `...[truncated ${omittedBytes} bytes]\n${value}` : value;
}
