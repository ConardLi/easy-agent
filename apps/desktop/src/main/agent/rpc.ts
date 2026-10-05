import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { RpcErrorInfo } from "../../shared/agent";

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor({ code, message, data }: RpcErrorInfo) {
    super(message);
    this.code = code;
    this.data = data;
  }
  toInfo(): RpcErrorInfo {
    return { code: this.code, message: this.message, ...(this.data !== undefined ? { data: this.data } : {}) };
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: RpcError): void;
}

/**
 * JSON-RPC 2.0 client over a pair of streams, one message per line. Responses
 * are matched by id because the server answers concurrent requests in any
 * order; notifications go to `onNotification` in the order they arrive.
 */
export class RpcClient {
  readonly #output: Writable;
  readonly #pending = new Map<number, Pending>();
  readonly #onNotification: (method: string, params: unknown) => void;
  #nextId = 1;
  #closed: RpcError | null = null;

  constructor(input: Readable, output: Writable, onNotification: (method: string, params: unknown) => void) {
    this.#output = output;
    this.#onNotification = onNotification;
    createInterface({ input }).on("line", (line) => this.#receive(line));
  }

  request<T>(method: string, params: unknown = {}): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.#output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /** Fail every pending and later request, e.g. when the process exits. */
  close(reason: string): void {
    if (this.#closed) return;
    this.#closed = new RpcError({ code: 0, message: reason });
    for (const pending of this.#pending.values()) pending.reject(this.#closed);
    this.#pending.clear();
  }

  #receive(line: string): void {
    if (!line.trim()) return;
    let message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: RpcErrorInfo };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.method === "string" && message.id === undefined) {
      this.#onNotification(message.method, message.params);
      return;
    }
    const pending = message.id !== undefined ? this.#pending.get(message.id) : undefined;
    if (!pending || message.id === undefined) return;
    this.#pending.delete(message.id);
    if (message.error) pending.reject(new RpcError(message.error));
    else pending.resolve(message.result);
  }
}
