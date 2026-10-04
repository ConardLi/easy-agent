/**
 * Starts a turn when an idle session has background input waiting.
 *
 * Background agents finish and teammates send mail at arbitrary times. While
 * a turn runs, the engine drains that input at the start of the next turn; an
 * idle session would otherwise stay silent until the user typed. The wake-up
 * is deferred to a microtask so several arrivals in one tick produce a single
 * turn, and it retries once a second while input remains queued (input that
 * arrived mid-turn is not drained by the turn already in flight).
 */

const RETRY_DELAY_MS = 1000;

export interface BackgroundWakeOptions {
  hasQueuedInput(): boolean;
  isIdle(): boolean;
  startTurn(): Promise<unknown>;
}

export class BackgroundWake {
  #inFlight = false;
  #disposed = false;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: BackgroundWakeOptions) {}

  /** Signal that input may be waiting. Safe to call at any time. */
  poke(): void {
    queueMicrotask(() => {
      if (this.#disposed || this.#inFlight) return;
      if (!this.options.isIdle() || !this.options.hasQueuedInput()) return;
      this.#inFlight = true;
      void this.options
        .startTurn()
        .catch(() => {})
        .finally(() => {
          this.#inFlight = false;
          if (!this.#disposed && this.options.hasQueuedInput() && !this.#retryTimer) {
            this.#retryTimer = setTimeout(() => {
              this.#retryTimer = null;
              this.poke();
            }, RETRY_DELAY_MS);
          }
        });
    });
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }
}
