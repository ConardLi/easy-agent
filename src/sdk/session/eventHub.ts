/**
 * Per-session event fan-out.
 *
 * Stamps every event with the session id and a monotonically increasing
 * sequence number, and greets each new subscriber with a state snapshot so a
 * late subscriber never has to replay history. Listener failures are reported
 * and isolated: one broken consumer cannot stop the session or starve the
 * others.
 */

import { logWarn } from "../../utils/log.js";
import type { SessionEvent, SessionEventBody, SessionEventListener, SessionState } from "../types.js";

export class EventHub {
  #seq = 0;
  readonly #listeners = new Set<SessionEventListener>();
  readonly #streamFinishers = new Set<() => void>();

  constructor(
    private readonly sessionId: () => string,
    private readonly snapshot: () => SessionState,
  ) {}

  emit(body: SessionEventBody): void {
    this.#seq += 1;
    const event = { ...body, sessionId: this.sessionId(), seq: this.#seq } as SessionEvent;
    for (const listener of [...this.#listeners]) this.#deliver(listener, event);
  }

  subscribe(listener: SessionEventListener): () => void {
    this.#listeners.add(listener);
    this.#deliver(listener, {
      type: "state_snapshot",
      state: this.snapshot(),
      sessionId: this.sessionId(),
      seq: this.#seq,
    });
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Async-iterator view of the same stream, starting with a snapshot. */
  stream(signal?: AbortSignal): AsyncIterableIterator<SessionEvent> {
    const queue: SessionEvent[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    const unsubscribe = this.subscribe((event) => {
      queue.push(event);
      wake?.();
    });
    const finish = (): void => {
      if (finished) return;
      finished = true;
      this.#streamFinishers.delete(finish);
      unsubscribe();
      wake?.();
    };
    this.#streamFinishers.add(finish);
    signal?.addEventListener("abort", finish, { once: true });

    const iterator: AsyncIterableIterator<SessionEvent> = {
      [Symbol.asyncIterator]: () => iterator,
      next: async () => {
        while (queue.length === 0 && !finished) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
        const value = queue.shift();
        return value ? { value, done: false } : { value: undefined, done: true };
      },
      return: async () => {
        finish();
        return { value: undefined, done: true };
      },
    };
    return iterator;
  }

  /** Detach every listener and end every stream; used when the session closes. */
  close(): void {
    for (const finish of [...this.#streamFinishers]) finish();
    this.#listeners.clear();
  }

  #deliver(listener: SessionEventListener, event: SessionEvent): void {
    try {
      listener(event);
    } catch (error) {
      logWarn(
        `Session event listener failed on ${event.type}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
