/**
 * TodoList — V1 会话级任务清单的静态展示。
 *
 * 渲染策略（与 Claude Code 源码 Spinner.tsx 行为一致）：
 *   - pending     → "○" + 暗色文字
 *   - in_progress → "▸" + 黄色 activeForm（不在这里转 spinner）
 *   - completed   → "✓" + 绿色删除线 content
 *
 * **不要在每行放独立的 Spinner**：在终端里每多一个 setInterval 就多一份
 * 80ms 的全树重绘压力，叠加 streamingText 高频更新会出现严重闪屏并导致
 * 终端无法滚动。源码做法是：
 *   - TodoList 行全部静态
 *   - 当前 in_progress 的 `activeForm` 由 **全局 StatusBar 的 spinner**
 *     接管（"leaderVerb = currentTodo?.activeForm ?? randomVerb"）
 *
 * `React.memo` + 自定义比较器进一步避免无关 setState 触发的重渲染。
 */

import React from "react";
import { Box, Text } from "ink";
import type { TodoItem } from "../../types/todo.js";

interface TodoListProps {
  todos: TodoItem[];
}

function TodoListInner({ todos }: TodoListProps): React.ReactNode {
  if (todos.length === 0) return null;

  const doneCount = countBy(todos, "completed");

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box marginLeft={2}>
        <Text bold color="cyan">{"\u25A2 Todos "}</Text>
        <Text dimColor>{`(${doneCount}/${todos.length} done)`}</Text>
      </Box>
      {todos.map((todo, index) => (
        <TodoRow key={`${index}:${todo.content}`} todo={todo} />
      ))}
    </Box>
  );
}

function TodoRow({ todo }: { todo: TodoItem }): React.ReactNode {
  if (todo.status === "in_progress") {
    return (
      <Box marginLeft={4}>
        <Text color="yellow">{"\u25B8 "}</Text>
        <Text color="yellow">{todo.activeForm}</Text>
      </Box>
    );
  }

  if (todo.status === "completed") {
    return (
      <Box marginLeft={4}>
        <Text color="green">{"\u2713 "}</Text>
        <Text strikethrough dimColor>{todo.content}</Text>
      </Box>
    );
  }

  return (
    <Box marginLeft={4}>
      <Text dimColor>{"\u25CB "}{todo.content}</Text>
    </Box>
  );
}

function countBy(todos: TodoItem[], status: TodoItem["status"]): number {
  let count = 0;
  for (const t of todos) if (t.status === status) count += 1;
  return count;
}

/** Shallow-equal comparator on the todo array contents. */
function areTodoListsEqual(prev: TodoListProps, next: TodoListProps): boolean {
  if (prev.todos === next.todos) return true;
  if (prev.todos.length !== next.todos.length) return false;
  for (let i = 0; i < prev.todos.length; i++) {
    const a = prev.todos[i];
    const b = next.todos[i];
    if (a.status !== b.status || a.content !== b.content || a.activeForm !== b.activeForm) {
      return false;
    }
  }
  return true;
}

export const TodoList = React.memo(TodoListInner, areTodoListsEqual);
