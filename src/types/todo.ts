/**
 * TodoItem — V1 会话级任务清单的数据结构。
 *
 * 严格对齐 Claude Code 源码 `src/utils/todo/types.ts`：
 *   - 三种状态：pending / in_progress / completed
 *   - 没有 `id` 字段（content 自身即标识）
 *   - 同时要求 `content`（祈使句）和 `activeForm`（现在进行时）
 *     —— 后者是 spinner 文案的关键字段
 */

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  /** 祈使句任务描述，如 "Run the tests"。 */
  content: string;
  /** 任务状态。 */
  status: TodoStatus;
  /** 现在进行时形式，in_progress 时给 spinner 显示，如 "Running the tests"。 */
  activeForm: string;
}
