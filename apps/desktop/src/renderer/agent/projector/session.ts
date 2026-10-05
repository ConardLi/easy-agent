/**
 * Folds the event stream of one session into what the conversation shows.
 * Pure: `applyEvent` returns a new view and never mutates its input, so the
 * same function serves live events, recorded fixtures, and tests.
 *
 * The committed conversation comes from `messages_changed`; the part of the
 * current reply that is still streaming comes from the deltas and tool
 * events, and is dropped once the reply is committed. Notices that are not
 * part of the conversation (mode switches, retries, errors) are pinned to the
 * number of messages that existed when they happened.
 */

import type { BackgroundAgentInfo, InteractionRequest, MessageParam, SessionEvent, SessionState, SessionUsage, Task, TodoItem } from "../../../shared/agent";
import { toolCall } from "../tools";
import type { Block, Effort, NoticeIcon, PermissionMode, SessionStatus } from "../viewModel";
import { CARDLESS_TOOLS, projectMessages, resultText, type ToolLive, thinkingKey } from "./messages";

type NoticeTone = Extract<Block, { kind: "notice" }>["tone"];

export interface StreamState {
  text: string;
  thinking: string | null;
  thinkingStartedAt?: number;
  thinkingDone?: boolean;
  /** Tool calls started in the reply that is still streaming. */
  tools: string[];
}

/** A block outside the committed conversation, shown after message `anchor - 1`. */
export interface Extra {
  anchor: number;
  block: Block;
}

export interface SessionView {
  id: string;
  workspaceId: string;
  seq: number;
  cwd: string;
  busy: boolean;
  model: string;
  permissionMode: PermissionMode;
  effort: Effort;
  usage: SessionUsage | null;
  messages: MessageParam[];
  /** Blocks from before the context was cleared or compacted; still shown, no longer sent to the model. */
  archived: Block[];
  extras: Extra[];
  stream: StreamState;
  tools: Record<string, ToolLive>;
  thinkingMs: Record<string, number>;
  /** The running turn's input and whether it runs the model. */
  turn: { input: string; runsModel: boolean } | null;
  pendingRequests: InteractionRequest[];
  todos: TodoItem[];
  tasks: Task[];
  taskMode: SessionState["taskMode"];
  backgroundAgents: BackgroundAgentInfo[];
  /** Increments for every notice, so notice ids stay unique. */
  counter: number;
}

const EMPTY_STREAM: StreamState = { text: "", thinking: null, tools: [] };

export const MODE_LABEL: Record<PermissionMode, string> = { default: "默认", plan: "计划", auto: "自动" };

/** Commands the composer's pickers run; their text output is replaced by a notice of the change. */
const QUIET_COMMANDS = /^\/(mode|model|effort|think)\b/;

export function effortOf(state: Pick<SessionState, "thinking" | "effort">): Effort {
  if (state.thinking?.type === "disabled") return "off";
  return state.effort ?? "default";
}

/** Pending requests show as cards at the end of the conversation, once each. */
function withRequestBlocks(view: SessionView): SessionView {
  const shown = new Set(view.extras.map((e) => e.block.id));
  const missing = view.pendingRequests.filter((r) => !shown.has(r.id));
  if (missing.length === 0) return view;
  const blocks = missing.map((request): Extra => ({ anchor: view.messages.length, block: { kind: "request", id: request.id, request } }));
  return { ...view, extras: [...view.extras, ...blocks] };
}

export function viewFromState(workspaceId: string, state: SessionState, seq: number, previous?: SessionView): SessionView {
  return withRequestBlocks({
    id: state.sessionId,
    workspaceId,
    seq,
    cwd: state.cwd,
    busy: state.busy,
    model: state.model,
    permissionMode: state.permissionMode,
    effort: effortOf(state),
    usage: state.usage ?? null,
    messages: state.messages,
    archived: previous?.archived ?? [],
    extras: previous && previous.messages.length <= state.messages.length ? previous.extras : [],
    stream: EMPTY_STREAM,
    tools: previous?.tools ?? {},
    thinkingMs: previous?.thinkingMs ?? {},
    turn: null,
    pendingRequests: state.pendingRequests,
    todos: state.todos ?? [],
    tasks: state.tasks ?? [],
    taskMode: state.taskMode,
    backgroundAgents: state.backgroundAgents ?? [],
    counter: previous?.counter ?? 0,
  });
}

export function statusOf(view: SessionView): SessionStatus {
  if (view.pendingRequests.length > 0) return "waiting";
  return view.busy ? "running" : "idle";
}

function notice(view: SessionView, tone: NoticeTone, icon: NoticeIcon, text: string, detail?: string): SessionView {
  const counter = view.counter + 1;
  const block: Block = { kind: "notice", id: `n${counter}`, tone, icon, text, ...(detail ? { detail } : {}) };
  return { ...view, counter, extras: [...view.extras, { anchor: view.messages.length, block }] };
}

/** Blocks of the committed conversation with the extras pinned between them. */
function committedBlocks(view: SessionView): Block[] {
  const projected = projectMessages(view.messages, { tools: view.tools, busy: view.busy, cwd: view.cwd, thinkingMs: view.thinkingMs });
  const out: Block[] = [];
  let next = 0;
  const extras = [...view.extras].sort((a, b) => a.anchor - b.anchor);
  for (const { at, block } of projected) {
    while (next < extras.length && extras[next]!.anchor <= at) out.push(extras[next++]!.block);
    out.push(block);
  }
  while (next < extras.length) out.push(extras[next++]!.block);
  return out;
}

/** Everything the conversation shows, top to bottom. */
export function blocksOf(view: SessionView): Block[] {
  const blocks = [...view.archived, ...committedBlocks(view)];
  const shown = new Set(blocks.map((b) => b.id));
  const { stream } = view;
  if (stream.thinking !== null && stream.thinking.length > 0) {
    blocks.push({
      kind: "thinking",
      id: "live-thinking",
      text: stream.thinking,
      streaming: !stream.thinkingDone,
      ...(stream.thinkingDone ? { durationMs: view.thinkingMs[thinkingKey(stream.thinking)] ?? 0 } : {}),
    });
  }
  if (stream.text) blocks.push({ kind: "assistant", id: "live-text", text: stream.text, streaming: view.busy });
  for (const id of stream.tools) {
    const live = view.tools[id];
    if (!live || shown.has(id) || CARDLESS_TOOLS.has(live.name)) continue;
    blocks.push({
      kind: "tool",
      id,
      tool: toolCall({
        id,
        name: live.name,
        running: view.busy,
        cwd: view.cwd,
        ...(live.input ? { input: live.input } : {}),
        ...(live.result ? { result: live.result } : {}),
        ...(live.startedAt ? { startedAt: live.startedAt } : {}),
        ...(live.completedAt ? { completedAt: live.completedAt } : {}),
        ...(live.liveOutput ? { liveOutput: live.liveOutput } : {}),
        ...(live.subagent ? { subagent: live.subagent } : {}),
      }),
    });
  }
  return blocks;
}

function patchTool(view: SessionView, id: string, patch: Partial<ToolLive> & { name?: string }): SessionView {
  const current = view.tools[id] ?? { name: patch.name ?? "" };
  return { ...view, tools: { ...view.tools, [id]: { ...current, ...patch } } };
}

/** Text left in the stream when a turn ends without committing it, e.g. after an interrupt. */
function settleStream(view: SessionView): SessionView {
  if (!view.stream.text) return { ...view, stream: EMPTY_STREAM };
  const counter = view.counter + 1;
  const block: Block = { kind: "assistant", id: `n${counter}`, text: view.stream.text };
  return { ...view, counter, stream: EMPTY_STREAM, extras: [...view.extras, { anchor: view.messages.length, block }] };
}

export function applyEvent(view: SessionView, event: SessionEvent, now = Date.now()): SessionView {
  if (event.type === "state_snapshot") return viewFromState(view.workspaceId, event.state, event.seq, view);
  // Events are numbered per session; anything not newer than the view is already in it.
  if (event.seq <= view.seq) return view;
  const next: SessionView = { ...view, seq: event.seq };

  switch (event.type) {
    case "messages_changed": {
      let out = next;
      // A shorter conversation means it was cleared or compacted; keep showing what came before.
      if (event.messages.length < view.messages.length) out = { ...out, archived: [...out.archived, ...committedBlocks(view)], extras: [] };
      const last = event.messages[event.messages.length - 1];
      if (last?.role === "assistant") out = { ...out, stream: EMPTY_STREAM };
      return { ...out, messages: event.messages };
    }
    case "usage_changed":
      return { ...next, usage: event.usage };
    case "mode_changed":
      return notice({ ...next, permissionMode: event.mode }, "info", "mode", `已切换到${MODE_LABEL[event.mode]}模式`);
    case "model_changed":
      return notice(
        { ...next, model: event.model },
        "info",
        "model",
        event.source === "default" ? `模型已恢复默认：${event.model}` : `模型已切换为 ${event.model}`,
      );
    case "session_cleared":
      return notice(next, "info", "clear", "上下文已清空");
    case "session_replaced":
      return { ...next, id: event.sessionId, messages: event.messages, archived: [], extras: [], stream: EMPTY_STREAM };
    case "notice":
      return notice(next, event.tone === "error" ? "danger" : "info", event.tone === "error" ? "error" : "command", event.title, event.body);
    case "turn_started":
      return { ...next, busy: true, turn: { input: event.input, runsModel: event.runsModel }, stream: EMPTY_STREAM };
    case "turn_completed": {
      let out = settleStream({ ...next, busy: false, turn: null });
      if (event.reason === "aborted") out = notice(out, "warning", "interrupt", "已中断");
      else if (event.reason === "max_turns") out = notice(out, "warning", "interrupt", "达到工具调用轮数上限，这一轮停下了");
      else if (event.reason === "blocking_limit") out = notice(out, "danger", "error", "上下文已满，先压缩或清空上下文再继续");
      return out;
    }
    case "turn_failed":
      return notice(settleStream({ ...next, busy: false, turn: null }), "danger", "error", "这一轮出错了", event.error.message);
    case "text_delta":
      return { ...next, stream: { ...next.stream, text: next.stream.text + event.text } };
    case "thinking_started":
      return { ...next, stream: { ...next.stream, thinking: "", thinkingStartedAt: now, thinkingDone: false } };
    case "thinking_delta":
      return { ...next, stream: { ...next.stream, thinking: (next.stream.thinking ?? "") + event.thinking } };
    case "thinking_completed": {
      const startedAt = next.stream.thinkingStartedAt ?? now;
      return {
        ...next,
        thinkingMs: { ...next.thinkingMs, [thinkingKey(event.thinking)]: now - startedAt },
        stream: { ...next.stream, thinking: event.thinking, thinkingDone: true },
      };
    }
    case "thinking_changed":
      return { ...next, effort: effortOf(event) };
    case "todos_changed":
      return { ...next, todos: event.todos };
    case "tasks_changed":
      return { ...next, tasks: event.tasks };
    case "task_mode_changed":
      return { ...next, taskMode: event.mode };
    case "background_agents_changed":
      return { ...next, backgroundAgents: event.agents };
    case "tool_started": {
      const out = patchTool(next, event.toolUseId, {
        name: event.name,
        startedAt: now,
        ...(event.subAgentProgress ? { subagent: event.subAgentProgress } : {}),
      });
      return { ...out, stream: { ...out.stream, tools: [...out.stream.tools, event.toolUseId] } };
    }
    case "tool_progress":
      if (event.progress.kind === "bash" && event.progress.progress) return patchTool(next, event.toolUseId, { liveOutput: event.progress.progress.output });
      if (event.progress.kind === "subagent" && event.progress.progress) return patchTool(next, event.toolUseId, { subagent: event.progress.progress });
      return next;
    case "tool_completed":
      return patchTool(next, event.toolUseId, {
        name: event.name,
        input: event.input,
        result: { text: resultText(event.result.content), isError: event.result.isError === true },
        completedAt: now,
      });
    case "request_opened":
      return withRequestBlocks({ ...next, pendingRequests: [...next.pendingRequests.filter((r) => r.id !== event.request.id), event.request] });
    case "request_resolved":
      return {
        ...next,
        pendingRequests: next.pendingRequests.filter((r) => r.id !== event.requestId),
        extras: next.extras.map((e) =>
          e.block.kind === "request" && e.block.id === event.requestId ? { ...e, block: { ...e.block, resolution: event.resolution } } : e,
        ),
      };
    case "api_retry": {
      const text = `请求失败，正在重试（第 ${event.attempt}/${event.maxRetries} 次）`;
      const last = next.extras[next.extras.length - 1];
      // Consecutive retries update one notice instead of stacking.
      const base =
        last?.block.kind === "notice" && last.block.text.startsWith("请求失败，正在重试") && last.anchor === next.messages.length
          ? { ...next, extras: next.extras.slice(0, -1) }
          : next;
      return notice(base, "warning", "error", text, event.message);
    }
    case "compacted":
      if (event.trigger === "micro") return next;
      return notice(next, "info", "compact", event.trigger === "auto" ? "上下文已自动压缩" : "上下文已压缩");
    case "error":
      return notice(next, "danger", "error", event.message);
    case "command_output": {
      const input = next.turn?.input ?? "";
      if (QUIET_COMMANDS.test(input)) return event.kind === "error" ? notice(next, "danger", "error", event.message) : next;
      return notice(next, event.kind === "error" ? "danger" : "info", "command", input || "命令输出", event.message);
    }
    default:
      return next;
  }
}
