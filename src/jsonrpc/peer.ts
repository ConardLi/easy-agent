/**
 * One end of a JSON-RPC 2.0 connection, independent of transport and protocol.
 *
 * Both RPC mode and ACP speak JSON-RPC over the same line-delimited stdio
 * stream; they differ in their methods. The peer parses incoming lines,
 * answers requests through a handler, runs notifications, matches responses
 * to the requests it sent, and reports malformed input with the standard
 * error codes. Requests are handled concurrently.
 */

export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export type RequestId = string | number;

export interface JsonRpcPeerOptions {
  /** Writes one serialized message. */
  send(line: string): void;
  /** Answers a request; throw a `JsonRpcError` (or anything `mapError` understands) to fail it. */
  handleRequest(method: string, params: unknown): Promise<unknown>;
  /** Runs a notification. Defaults to `handleRequest` with the result discarded. */
  handleNotification?(method: string, params: unknown): Promise<void>;
  /** Turns a thrown value into an error response. Unrecognized errors become -32603. */
  mapError?(error: unknown): JsonRpcError | undefined;
  /** Diagnostics that must not go to the protocol stream. */
  logError(message: string): void;
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: JsonRpcError): void;
}

export class JsonRpcPeer {
  readonly #options: JsonRpcPeerOptions;
  readonly #pending = new Map<RequestId, Pending>();
  #nextId = 1;

  constructor(options: JsonRpcPeerOptions) {
    this.#options = options;
  }

  /** Handle one incoming line. Never throws; failures become responses or log lines. */
  async receive(line: string): Promise<void> {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.#reply(null, {
        error: new JsonRpcError(JsonRpcErrorCode.ParseError, "Parse error: the line is not valid JSON."),
      });
      return;
    }
    // A response to a request this side sent.
    if (isObject(message) && !("method" in message) && ("result" in message || "error" in message)) {
      this.#settle(message);
      return;
    }
    if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      const id = isObject(message) && isRequestId(message.id) ? message.id : null;
      this.#reply(id, {
        error: new JsonRpcError(JsonRpcErrorCode.InvalidRequest, "Invalid request: expected a JSON-RPC 2.0 request."),
      });
      return;
    }
    const method = message.method;
    if (!("id" in message)) {
      const run = this.#options.handleNotification ?? ((m, p) => this.#options.handleRequest(m, p).then(() => {}));
      await run(method, message.params).catch((error: unknown) => {
        this.#options.logError(`[easy-agent] notification ${method} failed: ${this.#toError(error).message}`);
      });
      return;
    }
    if (!isRequestId(message.id)) {
      this.#reply(null, {
        error: new JsonRpcError(JsonRpcErrorCode.InvalidRequest, "Invalid request: id must be a string or number."),
      });
      return;
    }
    const id = message.id;
    try {
      this.#reply(id, { result: await this.#options.handleRequest(method, message.params) });
    } catch (error) {
      const rpcError = this.#toError(error);
      if (rpcError.code === JsonRpcErrorCode.InternalError && !(error instanceof JsonRpcError)) {
        this.#options.logError(`[easy-agent] ${method}: ${(error as Error)?.stack ?? String(error)}`);
      }
      this.#reply(id, { error: rpcError });
    }
  }

  /** Send a request to the other side; `response` settles with its result or error. */
  request(method: string, params: unknown): { id: RequestId; response: Promise<unknown> } {
    const id = this.#nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#write({ jsonrpc: "2.0", id, method, params });
    return { id, response };
  }

  notify(method: string, params: unknown): void {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  /** Fail every request still waiting for an answer; used on shutdown. */
  rejectPending(error: JsonRpcError): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #settle(message: Record<string, unknown>): void {
    const pending = isRequestId(message.id) ? this.#pending.get(message.id) : undefined;
    if (!pending) return;
    this.#pending.delete(message.id as RequestId);
    if ("error" in message && isObject(message.error)) {
      const { code, message: text, data } = message.error;
      pending.reject(
        new JsonRpcError(
          typeof code === "number" ? code : JsonRpcErrorCode.InternalError,
          String(text ?? "error"),
          data,
        ),
      );
    } else pending.resolve(message.result);
  }

  #toError(error: unknown): JsonRpcError {
    if (error instanceof JsonRpcError) return error;
    return (
      this.#options.mapError?.(error) ??
      new JsonRpcError(JsonRpcErrorCode.InternalError, error instanceof Error ? error.message : String(error))
    );
  }

  #reply(id: RequestId | null, outcome: { result: unknown } | { error: JsonRpcError }): void {
    const body =
      "result" in outcome
        ? { result: outcome.result ?? {} }
        : {
            error: {
              code: outcome.error.code,
              message: outcome.error.message,
              ...(outcome.error.data !== undefined ? { data: outcome.error.data } : {}),
            },
          };
    this.#write({ jsonrpc: "2.0", id, ...body });
  }

  #write(message: unknown): void {
    this.#options.send(JSON.stringify(message));
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}
