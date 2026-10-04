/**
 * Session scope — the owner of conversation-level runtime state.
 *
 * Several modules keep state that belongs to one conversation rather than to
 * the process: the file-history snapshot chain, the plan file name, the queue
 * of background-agent notifications, `/think` and `/effort` overrides, the
 * task-tracking mode, compaction and Auto Mode failure counters, and the live
 * progress of in-flight tool calls. Those values are read deep inside tools,
 * permission checks, and the provider layer, far from any object that knows
 * which session is running.
 *
 * A `SessionScope` holds one copy of each such value. A session runs its work
 * inside `runInSessionScope(scope, ...)`, and Node's AsyncLocalStorage carries
 * the scope through every await, timer, and callback that work starts —
 * including background sub-agents that outlive the turn that spawned them.
 * Modules declare their state with `defineSessionState`, which resolves
 * against the active scope, so two sessions in one process never observe each
 * other's values.
 *
 * Code that runs outside any session (tests, one-off scripts, startup) uses
 * the process default scope, which behaves exactly like the module-level
 * state it replaces.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface SessionScope {
  /** Stable identity of the scope. Survives an in-place `/resume` switch. */
  readonly id: string;
}

class Scope implements SessionScope {
  readonly values = new Map<symbol, unknown>();
  constructor(readonly id: string) {}
}

const storage = new AsyncLocalStorage<Scope>();
const defaultScope = new Scope("process");

/** Create an isolated scope. Its state starts from each module's initializer. */
export function createSessionScope(): SessionScope {
  return new Scope(randomUUID());
}

/** The scope used when no session is active. */
export function getDefaultSessionScope(): SessionScope {
  return defaultScope;
}

/** The scope of the code currently running. */
export function currentSessionScope(): SessionScope {
  return storage.getStore() ?? defaultScope;
}

/** Run `fn` with `scope` active for it and everything it schedules. */
export function runInSessionScope<T>(scope: SessionScope, fn: () => T): T {
  if (!(scope instanceof Scope)) throw new TypeError("Not a session scope created by createSessionScope().");
  return storage.run(scope, fn);
}

/**
 * Declare one piece of session-scoped state. The returned accessor yields the
 * active scope's value, creating it with `init` on first access.
 *
 * Accessors must not be cached across awaits by callers that might hop scopes;
 * call the accessor where the value is used.
 */
export function defineSessionState<T>(name: string, init: () => T): () => T {
  const key = Symbol(name);
  return () => {
    const scope = storage.getStore() ?? defaultScope;
    if (!scope.values.has(key)) scope.values.set(key, init());
    return scope.values.get(key) as T;
  };
}
