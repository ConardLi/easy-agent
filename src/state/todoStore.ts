/**
 * TodoStore — V1 会话级任务清单的内存存储。
 *
 * 对应 Claude Code 源码中 `appState.todos[todoKey]` 的简化版本：
 *   - 按 sessionId 隔离（与源码用 `agentId ?? sessionId` 作 key 等价）
 *   - 全量替换语义（每次 TodoWrite 都覆盖该 session 的列表）
 *   - 通过 listener 通知订阅者（UI 可在此驱动 React 重渲染）
 *
 * 这是个 V1 的**会话内**存储——进程退出即丢失，跨会话不持续。
 * V2 (阶段 15) 会换成磁盘任务图。
 */

import type { TodoItem } from "../types/todo.js";

type Listener = (sessionId: string, todos: TodoItem[]) => void;

const todosBySession = new Map<string, TodoItem[]>();
const listeners = new Set<Listener>();

/** 读取某 session 当前的 todos（不存在则返回空数组）。 */
export function getTodos(sessionId: string): TodoItem[] {
  return todosBySession.get(sessionId) ?? [];
}

/** 全量替换某 session 的 todos，并通知所有订阅者。 */
export function setTodos(sessionId: string, todos: TodoItem[]): void {
  todosBySession.set(sessionId, todos);
  for (const listener of listeners) {
    listener(sessionId, todos);
  }
}

/**
 * 订阅 todos 变化。返回的函数用于取消订阅。
 *
 * 注意：所有 session 的更新都会推送到 listener，订阅方要自己按
 * sessionId 过滤——这与源码 AppState 的"全局 store + 本地过滤"一致。
 */
export function subscribeTodos(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 测试/重置用：清空某 session 的 todos。 */
export function clearTodos(sessionId: string): void {
  setTodos(sessionId, []);
}
