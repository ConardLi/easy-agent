/**
 * Workspace state shared by a runtime's sessions. Async work keeps its owner
 * even after that runtime closes. Standalone scripts use a process scope;
 * unscoped legacy callers use the active runtime while one is installed.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface RuntimeScope {
  readonly id: string;
  readonly signal: AbortSignal;
}

class Scope implements RuntimeScope {
  readonly values = new Map<symbol, unknown>();
  readonly cleanups = new Set<() => void | Promise<void>>();
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  disposed = false;
  disposal?: Promise<void>;
  constructor(readonly id: string) {}
}

const storage = new AsyncLocalStorage<Scope>();
const processScope = new Scope("process");
let fallback = processScope;

export function createRuntimeScope(): RuntimeScope {
  return new Scope(randomUUID());
}

function checked(scope: RuntimeScope): Scope {
  if (!(scope instanceof Scope)) throw new TypeError("Not a scope created by createRuntimeScope().");
  return scope;
}

export function currentRuntimeScope(): RuntimeScope {
  return storage.getStore() ?? fallback;
}

/** Compatibility for direct module callers; scoped work never consults this again. */
export function setDefaultRuntimeScope(scope: RuntimeScope | null): void {
  fallback = scope ? checked(scope) : processScope;
}

export function runInRuntimeScope<T>(scope: RuntimeScope, fn: () => T): T {
  return storage.run(checked(scope), fn);
}

/** Event emitters may invoke callbacks in another scope. Capture the owner explicitly. */
export function bindRuntimeScope<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const scope = currentRuntimeScope();
  return (...args) => runInRuntimeScope(scope, () => fn(...args));
}

/** Public module entry points capture the caller's owner before their first await. */
export function withRuntimeScope<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args) => runInRuntimeScope(currentRuntimeScope(), () => fn(...args));
}

export function runtimeScopeClosed(): boolean {
  return currentRuntimeScope().signal.aborted;
}

/**
 * Each module owns a typed cell. Disposed scopes return fresh empty defaults,
 * without storing them, so late reads cannot reach a subsequent runtime.
 */
export function defineRuntimeState<T>(
  name: string,
  init: () => T,
  dispose?: (value: T) => void | Promise<void>,
): () => T {
  const key = Symbol(name);
  return () => {
    const scope = checked(currentRuntimeScope());
    if (scope.disposed || (scope.signal.aborted && !scope.values.has(key))) return init();
    if (!scope.values.has(key)) {
      const value = init();
      scope.values.set(key, value);
      if (dispose) scope.cleanups.add(() => dispose(value));
    }
    return scope.values.get(key) as T;
  };
}

/** Abort new work before releasing resources. Repeated disposal joins the same cleanup. */
export function disposeRuntimeScope(owner: RuntimeScope): Promise<void> {
  const scope = checked(owner);
  if (scope.disposal) return scope.disposal;
  scope.disposal = runInRuntimeScope(scope, async () => {
    scope.controller.abort();
    const results = await Promise.allSettled([...scope.cleanups].map(async (cleanup) => cleanup()));
    scope.cleanups.clear();
    scope.values.clear();
    scope.disposed = true;
    if (fallback === scope) fallback = processScope;
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (errors.length) throw new AggregateError(errors, "Runtime resource cleanup failed.");
  });
  return scope.disposal;
}
