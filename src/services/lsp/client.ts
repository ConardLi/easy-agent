import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { LspServerConfig } from "./schema.js";

const MAX_FRAME = 8 * 1024 * 1024;
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; cleanup: () => void };

/** Bounded LSP/JSON-RPC stdio session. No shell interpolation or unsolicited edits. */
export class LspClient {
  private child?: ChildProcessWithoutNullStreams;
  private buffer: Buffer = Buffer.alloc(0);
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private stopping = false;
  private startPromise?: Promise<void>;
  private restarts = 0;
  private documents = new Map<string, number>();
  private capabilities: Record<string, unknown> = {};
  status: "stopped" | "starting" | "ready" | "failed" = "stopped";
  error?: string;

  constructor(readonly config: LspServerConfig, readonly cwd: string) {}

  async start(): Promise<void> {
    if (this.status === "ready") return;
    if (this.startPromise) return this.startPromise;
    if (this.stopping) throw new Error("LSP server is stopping");
    this.startPromise = this.initialize();
    try { await this.startPromise; } finally { this.startPromise = undefined; }
  }

  private async initialize(): Promise<void> {
    this.status = "starting";
    this.error = undefined;
    this.buffer = Buffer.alloc(0);
    this.documents.clear();
    const child = spawn(this.config.command, this.config.args, {
      cwd: this.cwd, env: { ...process.env, ...this.config.env },
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32",
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      try { this.consume(chunk); } catch (error) { this.fail(error as Error); this.terminate(child); }
    });
    // Drain stderr without retaining potentially unbounded or sensitive content.
    child.stderr.on("data", () => {});
    child.stdin.on("error", (error) => this.fail(error));
    child.once("error", () => this.fail(new Error("LSP process could not start; check the executable and platform")));
    child.once("close", (code) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.fail(new Error(`LSP process exited (${code ?? "signal"})`));
    });
    try {
      const initialized = await this.requestRaw("initialize", {
        processId: process.pid, rootUri: pathToFileURL(this.cwd).href,
        workspaceFolders: [{ uri: pathToFileURL(this.cwd).href, name: "workspace" }],
        capabilities: { workspace: { configuration: true }, textDocument: { synchronization: { dynamicRegistration: false } } },
        initializationOptions: this.config.initializationOptions,
      }, this.config.startupTimeout);
      this.capabilities = (initialized as { capabilities?: Record<string, unknown> })?.capabilities ?? {};
      this.notify("initialized", {});
      if (this.config.settings) this.notify("workspace/didChangeConfiguration", { settings: this.config.settings });
      this.status = "ready";
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      this.terminate(child);
      throw error;
    }
  }

  private fail(error: Error): void {
    this.status = this.stopping ? "stopped" : "failed";
    this.error = this.stopping ? undefined : error.message;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.cleanup(); item.reject(error); }
    this.pending.clear();
  }

  private send(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    if (body.length > MAX_FRAME) throw new Error("LSP request exceeds size limit");
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) throw new Error("LSP connection is closed");
    if (stdin.writableLength > MAX_FRAME) throw new Error("LSP write queue exceeds size limit");
    stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }

  notify(method: string, params: unknown): void { this.send({ jsonrpc: "2.0", method, params }); }

  private requestRaw(method: string, params: unknown, timeout: number, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new Error("LSP request cancelled"));
    if (this.pending.size >= 64) return Promise.reject(new Error("Too many pending LSP requests"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const cancel = (message: string) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id); clearTimeout(pending.timer); pending.cleanup();
        try { this.notify("$/cancelRequest", { id }); } catch { /* Connection already closed. */ }
        reject(new Error(message));
      };
      const abort = () => cancel("LSP request cancelled");
      const timer = setTimeout(() => cancel(`LSP request timed out: ${method}`), timeout);
      const cleanup = () => signal?.removeEventListener("abort", abort);
      this.pending.set(id, { resolve, reject, timer, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      try { this.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { clearTimeout(timer); cleanup(); this.pending.delete(id); reject(error); }
    });
  }

  async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.status === "failed") {
      if (!this.config.restartOnCrash || this.restarts >= this.config.maxRestarts) throw new Error(this.error ?? "LSP restart budget exhausted");
      this.restarts++;
    }
    await this.start();
    return this.requestRaw(method, params, this.config.requestTimeout, signal);
  }

  async openDocument(uri: string, languageId: string, text: string): Promise<void> {
    if (Buffer.byteLength(text) > MAX_FRAME / 2) throw new Error("LSP document exceeds size limit");
    if (this.status === "failed") {
      if (!this.config.restartOnCrash || this.restarts >= this.config.maxRestarts) throw new Error(this.error ?? "LSP restart budget exhausted");
      this.restarts++;
    }
    await this.start();
    const version = this.documents.get(uri);
    if (version === undefined) {
      this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } });
      this.documents.set(uri, 1);
    } else {
      const sync = this.capabilities.textDocumentSync;
      const kind = typeof sync === "number" ? sync : (sync as { change?: number })?.change;
      if (kind === 2) {
        this.notify("textDocument/didClose", { textDocument: { uri } });
        this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: version + 1, text } });
      } else this.notify("textDocument/didChange", { textDocument: { uri, version: version + 1 }, contentChanges: [{ text }] });
      this.documents.set(uri, version + 1);
    }
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length) {
      const boundary = this.buffer.indexOf("\r\n\r\n");
      if (boundary < 0) { if (this.buffer.length > 8192) throw new Error("Invalid LSP header"); return; }
      const header = this.buffer.subarray(0, boundary).toString("ascii");
      const match = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
      const size = match ? Number(match[1]) : NaN;
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FRAME) throw new Error("Invalid LSP frame size");
      if (this.buffer.length < boundary + 4 + size) return;
      const message = JSON.parse(this.buffer.subarray(boundary + 4, boundary + 4 + size).toString("utf8"));
      this.buffer = this.buffer.subarray(boundary + 4 + size);
      if (message.method && message.id !== undefined) {
        if (message.method === "workspace/configuration") {
          const items = message.params?.items ?? [];
          this.send({ jsonrpc: "2.0", id: message.id, result: items.map((item: { section?: string }) => item.section?.split(".").reduce((v: any, key: string) => v?.[key], this.config.settings) ?? this.config.settings ?? null) });
        } else this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Client request not supported" } });
      } else if (typeof message.id === "number") {
        const item = this.pending.get(message.id);
        if (!item) continue;
        this.pending.delete(message.id); clearTimeout(item.timer); item.cleanup();
        if (message.error) item.reject(new Error(`LSP error ${message.error.code}: request failed`));
        else item.resolve(message.result);
      }
    }
  }

  private terminate(child: ChildProcessWithoutNullStreams): void {
    if (!child.pid) return;
    if (process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.on("error", () => child.kill());
      killer.unref();
    } else { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (child) {
      if (this.status === "ready") {
        try { await this.requestRaw("shutdown", null, 500); this.notify("exit", undefined); } catch { /* Forced cleanup below. */ }
      }
      this.terminate(child);
    }
    this.fail(new Error("LSP stopped"));
    this.child = undefined;
  }

  forceStop(): void { this.stopping = true; if (this.child) this.terminate(this.child); }
}
