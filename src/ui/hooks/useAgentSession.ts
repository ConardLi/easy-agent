import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { QueryEngine } from "../../core/queryEngine.js";
import { buildTokenBudgetSnapshot } from "../../utils/tokens.js";
import {
  appendCompactionSnapshot,
  appendTranscriptEntry,
  createSessionId,
  initSessionStorage,
  restoreSession,
} from "../../session/storage.js";
import {
  loadPermissionSettings,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRequest,
  type PermissionRuleSet,
  type PermissionSettings,
} from "../../permissions/permissions.js";
import type { ToolContext } from "../../tools/Tool.js";
import { readPlan, getPlanFilePath, getPlansDirectory } from "../../context/plans.js";
import type {
  PermissionPromptState,
  SystemNotice,
  ToolCallInfo,
  UsageSummary,
} from "../types.js";
import { formatToolInputPreview } from "../utils/toolCardFormat.js";
import { clearTodos, getTodos, subscribeTodos } from "../../state/todoStore.js";
import type { TodoItem } from "../../types/todo.js";
import { getTaskListId, listTasks, subscribeTasks } from "../../state/taskStore.js";
import { findSkill } from "../../services/skills/registry.js";
import { removeSandboxViolationTags } from "../../sandbox/index.js";
import {
  getTaskMode,
  subscribeTaskMode,
  type TaskMode,
} from "../../state/taskModeStore.js";
import type { Task } from "../../types/task.js";

interface UseAgentSessionOptions {
  model: string;
  onExit: () => void;
  permissionMode?: PermissionMode;
  shouldResume?: boolean;
  resumeSessionId?: string | null;
}

interface SubmitResult {
  handled: boolean;
}

interface ToolCallCompletion {
  resultLength: number;
  isError?: boolean;
  displayName?: string;
  displayHint?: string;
  inputPreview?: string;
  errorMessage?: string;
}

/**
 * Mark a specific tool call card as complete, identified by its unique
 * tool_use id. We must NOT match by `name` alone — when an assistant turn
 * fires several parallel calls of the same tool (e.g. three Reads), a
 * name-based match would either update every pending card with the first
 * result that lands, or silently drop subsequent results.
 */
function markToolCallComplete(
  toolCalls: ToolCallInfo[],
  id: string,
  completion: ToolCallCompletion,
): ToolCallInfo[] {
  return toolCalls.map((toolCall) =>
    toolCall.id === id ? { ...toolCall, ...completion } : toolCall,
  );
}

function buildCommandNotice(message: string, kind: "info" | "error"): SystemNotice {
  if (message.startsWith("Commands:")) {
    return {
      tone: "info",
      title: "Available commands",
      body: [
        "/help  Show available commands",
        "/clear  Clear conversation history",
        "/cost  Show session token usage",
        "/model [name|default]  Inspect or override the session model",
        "/mode [default|plan|auto]  Inspect or switch permission mode",
        "/tasks [task|todo|reset]  Switch task system or reset the task graph",
        "/mcp  Inspect MCP servers and their tools",
        "/skills  List loaded skills (user + project scope)",
        "/<skill-name> [args]  Run a registered skill as a chat turn",
        "/history  Show saved sessions for this project",
        "/compact  Compact conversation context",
        "/exit | /quit | /bye  Exit session",
      ].join("\n"),
    };
  }

  if (message.startsWith("Session usage") || message.startsWith("Recent sessions:")) {
    return {
      tone: kind,
      title: message.startsWith("Recent sessions:") ? "Session history" : "Session usage",
      body: message,
    };
  }

  if (message.startsWith("Model status") || message.startsWith("Model updated")) {
    return {
      tone: kind,
      title: message.startsWith("Model status") ? "Model status" : "Model updated",
      body: message,
    };
  }

  if (message.startsWith("Task system")) {
    return {
      tone: kind,
      title: message.startsWith("Task system status") ? "Task system" : "Task system updated",
      body: message,
    };
  }

  if (
    message.startsWith("MCP Servers") ||
    message.startsWith("MCP tools from") ||
    message.startsWith("MCP server '")
  ) {
    return {
      tone: kind,
      title: "MCP",
      body: message,
    };
  }

  if (message.startsWith("Skills (") || message === "No skills loaded.") {
    return {
      tone: kind,
      title: "Skills",
      body: message,
    };
  }

  if (message.startsWith("Unknown command:")) {
    return {
      tone: "error",
      title: "Unknown command",
      body: message,
    };
  }

  if (message === "Conversation cleared.") {
    return {
      tone: "info",
      title: "Conversation reset",
      body: message,
    };
  }

  return {
    tone: kind,
    title: kind === "error" ? "Command error" : "System message",
    body: message,
  };
}

export function useAgentSession({
  model,
  onExit,
  permissionMode,
  shouldResume,
  resumeSessionId,
}: UseAgentSessionOptions) {
  const [messages, setMessages] = useState<MessageParam[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [spinnerLabel, setSpinnerLabel] = useState("Thinking");
  const [streamingText, setStreamingText] = useState("");
  const [toolCalls, setToolCalls] = useState<ToolCallInfo[]>([]);
  const [lastUsage, setLastUsage] = useState<UsageSummary | null>(null);
  const [totalUsage, setTotalUsage] = useState<UsageSummary | null>(null);
  const [systemNotice, setSystemNotice] = useState<SystemNotice | null>(null);
  const [permissionPrompt, setPermissionPrompt] = useState<PermissionPromptState | null>(null);
  const [permissionSettings, setPermissionSettings] = useState<PermissionSettings | null>(null);
  const [currentModel, setCurrentModel] = useState(model);
  const [activePermissionMode, setActivePermissionMode] = useState<string>(permissionMode ?? "default");
  const [todos, setTodosState] = useState<TodoItem[]>([]);
  const [tasks, setTasksState] = useState<Task[]>([]);
  const [taskMode, setTaskModeState] = useState<TaskMode>(getTaskMode());

  const permissionResolverRef = useRef<((decision: PermissionDecision) => void) | null>(null);
  const pendingClearContextRef = useRef(false);
  const pendingFeedbackRef = useRef<string | null>(null);
  const sessionRulesRef = useRef<PermissionRuleSet>({ allow: [], deny: [] });
  const engineRef = useRef<QueryEngine | null>(null);
  const sessionIdRef = useRef<string>(createSessionId());

  // Streaming-text throttling. SSE chunks can arrive at >100 Hz from fast
  // models, and every setStreamingText forces Ink to repaint the whole
  // frame — combined with the TodoList / ToolCallList that sit above it,
  // the unbatched updates caused visible flicker and "untouchable" terminal
  // scrolling. We coalesce chunks into a 30ms window (≈33 fps) — fast
  // enough to look live, slow enough to keep the UI usable.
  const pendingTextRef = useRef<string>("");
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushPendingText = useCallback(() => {
    flushTimerRef.current = null;
    if (pendingTextRef.current) {
      const chunk = pendingTextRef.current;
      pendingTextRef.current = "";
      setStreamingText((prev) => prev + chunk);
    }
  }, []);
  const cancelPendingText = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    pendingTextRef.current = "";
  }, []);

  // Always release the timer on unmount so we don't leak across hot reloads.
  useEffect(() => () => cancelPendingText(), [cancelPendingText]);
  // `sessionId` is exposed as a live getter so tools always see the
  // current sessionIdRef value. This matters during /resume — the ref is
  // mutated *after* this hook has memoized the toolContext, and a baked-in
  // value would silently route TodoWrite writes to the old (orphan) key
  // while the UI subscriber filters on the new sessionId, leaving the
  // todo panel permanently empty.
  const toolContext = useMemo<ToolContext>(
    () => ({
      cwd: process.cwd(),
      get sessionId() {
        return sessionIdRef.current;
      },
    }),
    [],
  );

  // Subscribe to TodoWrite updates. The store is global (mirrors source's
  // `appState.todos` map), so we filter by our own sessionId. When the
  // session is restored or cleared we also re-pull the snapshot.
  useEffect(() => {
    setTodosState(getTodos(sessionIdRef.current));
    const unsubscribe = subscribeTodos((sid, next) => {
      if (sid === sessionIdRef.current) {
        setTodosState(next);
      }
    });
    return unsubscribe;
  }, []);

  // Subscribe to Task V2 updates. Tasks live on disk, so on mount we do
  // one full listTasks to populate the initial view, then refresh every
  // time the store fires a change event for our task list id. Each
  // mutation already runs through the lock budget on the writer side,
  // so the reader doesn't need its own synchronization.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const taskListId = getTaskListId(sessionIdRef.current);
      try {
        const list = await listTasks(taskListId);
        if (!cancelled) setTasksState(list);
      } catch {
        // Ignore transient read errors — a future mutation will trigger
        // another refresh that can succeed.
      }
    };
    void refresh();
    const unsubscribe = subscribeTasks((taskListId) => {
      if (taskListId === getTaskListId(sessionIdRef.current)) {
        void refresh();
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Mirror the global task-mode store into local state so React re-renders
  // when the user flips `/tasks task|todo`. The global store is still the
  // source of truth — tools and permissions.ts read from it directly.
  useEffect(() => {
    setTaskModeState(getTaskMode());
    return subscribeTaskMode((mode) => setTaskModeState(mode));
  }, []);

  useEffect(() => {
    void loadPermissionSettings(process.cwd())
      .then(setPermissionSettings)
      .catch((error: unknown) => {
        setSystemNotice({
          tone: "error",
          title: "Permission settings error",
          body: error instanceof Error ? error.message : String(error),
        });
      });
  }, []);

  useEffect(() => {
    if (!permissionSettings) return;

    let cancelled = false;

    const initialize = async () => {
      try {
        let initialMessages: MessageParam[] = [];
        let initialUsage = { input_tokens: 0, output_tokens: 0 };

        if (shouldResume) {
          const restored = await restoreSession(toolContext.cwd, resumeSessionId ?? undefined);
          if (cancelled) return;
          sessionIdRef.current = restored.summary.sessionId;
          initialMessages = restored.messages;
          initialUsage = restored.summary.totalUsage;
          setMessages(restored.messages);
          setTotalUsage({
            input: restored.summary.totalUsage.input_tokens,
            output: restored.summary.totalUsage.output_tokens,
          });
          setSystemNotice({
            tone: "info",
            title: "Session restored",
            body: `Resumed session ${restored.summary.sessionId} with ${restored.summary.messageCount} messages.`,
          });
        } else {
          const startedAt = new Date().toISOString();
          await initSessionStorage({
            sessionId: sessionIdRef.current,
            cwd: toolContext.cwd,
            startedAt,
            updatedAt: startedAt,
            model,
          });
        }

        const engine = new QueryEngine({
          model,
          toolContext,
          initialMessages,
          initialUsage,
          permissionMode: permissionMode ?? permissionSettings.mode,
          permissionSettings,
          sessionPermissionRules: sessionRulesRef.current,
          onPermissionRequest: async (request: PermissionRequest) => {
            const isPlanExit = request.toolName === "ExitPlanMode";
            setSpinnerLabel(isPlanExit ? "Waiting for plan approval" : "Waiting for permission");

            let planContent: string | undefined;
            let planFilePath: string | undefined;
            if (isPlanExit) {
              planContent = (await readPlan()) ?? undefined;
              planFilePath = getPlanFilePath();
            }

            setPermissionPrompt({
              toolName: request.toolName,
              summary: request.summary,
              risk: request.risk,
              ruleHint: request.ruleHint,
              isPlanExit,
              planContent,
              planFilePath,
            });
            return new Promise<PermissionDecision>((resolve) => {
              permissionResolverRef.current = resolve;
            });
          },
        });
        engine.onModeChange((newMode, previousMode) => {
          setActivePermissionMode(newMode);
          const label = newMode === "plan" ? "Entered plan mode" : "Exited plan mode";
          const body = newMode === "plan"
            ? "Only read-only tools are available. Explore the codebase and write your plan."
            : `Returned to ${newMode} mode. Full tool access restored.`;
          setSystemNotice({ tone: "info", title: label, body });
        });
        engineRef.current = engine;
        setCurrentModel(model);
      } catch (error: unknown) {
        if (cancelled) return;
        setSystemNotice({
          tone: "error",
          title: "Session restore error",
          body: error instanceof Error ? error.message : String(error),
        });
      }
    };

    void initialize();

    return () => {
      cancelled = true;
    };
  }, [model, permissionMode, permissionSettings, resumeSessionId, shouldResume, toolContext]);

  const interrupt = useCallback(() => {
    if (permissionResolverRef.current) {
      permissionResolverRef.current("deny");
      permissionResolverRef.current = null;
      setPermissionPrompt(null);
      setSystemNotice({
        tone: "info",
        title: "Permission request cancelled",
        body: "Use /exit, /quit, /bye, or Ctrl+D to exit.",
      });
      return true;
    }

    if (!engineRef.current?.interrupt()) {
      setSystemNotice({
        tone: "info",
        title: "Nothing to interrupt",
        body: "Use /exit, /quit, /bye, or Ctrl+D to exit.",
      });
      return true;
    }

    setIsLoading(false);
    cancelPendingText();
    setStreamingText("");
    setSystemNotice({
      tone: "info",
      title: "Interrupted",
      body: "Use /exit, /quit, /bye, or Ctrl+D to exit.",
    });
    return true;
  }, [cancelPendingText]);

  const resolvePermission = useCallback((decision: PermissionDecision, feedback?: string) => {
    if (!permissionResolverRef.current) return false;

    const autoAcceptRules = ["Write", "Edit", "Bash(npm *)","Bash(npx *)"];

    if (decision === "allow_clear_context") {
      pendingClearContextRef.current = true;
      sessionRulesRef.current.allow.push(...autoAcceptRules);
      permissionResolverRef.current("allow_once");
      // Abort the loop immediately after ExitPlanMode runs,
      // so the model doesn't start implementing in the same loop.
      // The clear-context flow will submit a fresh "Implement" message.
      engineRef.current?.interrupt();
    } else if (decision === "allow_accept_edits") {
      sessionRulesRef.current.allow.push(...autoAcceptRules);
      permissionResolverRef.current("allow_once");
    } else if (decision === "deny" && feedback) {
      pendingFeedbackRef.current = feedback;
      permissionResolverRef.current("deny");
    } else {
      permissionResolverRef.current(decision);
    }

    permissionResolverRef.current = null;
    setPermissionPrompt(null);

    if (decision === "deny" && feedback) {
      setSystemNotice({ tone: "info", title: "Plan rejected with feedback", body: `Feedback: ${feedback}` });
    } else if (decision === "deny") {
      setSystemNotice({ tone: "error", title: "Permission denied", body: "Permission denied." });
    } else if (decision === "allow_clear_context") {
      setSystemNotice({ tone: "info", title: "Plan approved", body: "Plan approved. Edits auto-accepted. Context will be cleared for implementation." });
    } else if (decision === "allow_accept_edits") {
      setSystemNotice({ tone: "info", title: "Plan approved", body: "Plan approved. Edits auto-accepted. Continuing with current context." });
    } else if (decision === "allow_always") {
      setSystemNotice({ tone: "info", title: "Permission granted", body: "Permission granted and remembered for this session." });
    } else {
      setSystemNotice({ tone: "info", title: "Permission granted", body: "Permission granted." });
    }
    return true;
  }, []);

  const submit = useCallback(async (text: string): Promise<SubmitResult> => {
    if (!text.trim()) {
      return { handled: false };
    }

    const trimmed = text.trim();
    if (trimmed === "/exit" || trimmed === "/quit" || trimmed === "/bye") {
      onExit();
      return { handled: true };
    }

    if (!engineRef.current) {
      setSystemNotice({
        tone: "error",
        title: "QueryEngine is not ready",
        body: "Please wait for initialization to finish.",
      });
      return { handled: true };
    }

    const isSlashCommand = trimmed.startsWith("/");
    // Slash commands fall into two categories that need different UX:
    //   1. *System* commands (/help, /cost, /model, /skills, /mcp, …) —
    //      synchronous, never call the LLM, just print a notice.
    //   2. *Skill* commands (/<skill-name> [args]) — expand into a real
    //      user prompt and engage the full agentic loop, exactly like a
    //      typed chat message.
    // Without this distinction every `/` input was treated as case (1):
    // no spinner, no streaming, no transcript entry — which made skill
    // invocations feel broken even though events were flowing through
    // the engine. Detect skill commands by peeking at the registry here
    // and treat them as LLM-triggering input below.
    const skillCommandName = isSlashCommand
      ? trimmed.slice(1).split(/\s+/, 1)[0]?.toLowerCase() ?? ""
      : "";
    const isSkillCommand =
      isSlashCommand && !!skillCommandName && !!findSkill(skillCommandName);
    const isLlmTriggering = !isSlashCommand || isSkillCommand;

    cancelPendingText();
    setStreamingText("");
    setToolCalls([]);
    setSystemNotice(null);
    if (isLlmTriggering) {
      setLastUsage(null);
      // Persist what the user actually typed (`/hello-world Easy Agent`)
      // rather than the expanded SKILL.md body. The expanded prompt is
      // an internal/wire-only artifact — keeping the transcript clean
      // means /resume replays the same UX the user originally saw.
      await appendTranscriptEntry(toolContext.cwd, sessionIdRef.current, {
        type: "message",
        timestamp: new Date().toISOString(),
        role: "user",
        message: { role: "user", content: trimmed },
      });
    }
    setPermissionPrompt(null);
    const needsLoading = isLlmTriggering || trimmed.startsWith("/compact");
    setIsLoading(needsLoading);
    setSpinnerLabel(trimmed.startsWith("/compact") ? "Compacting" : "Thinking");

    try {
      const run = engineRef.current.submitMessage(trimmed);

      while (true) {
        const { value, done } = await run.next();
        if (done) {
          if (value.reason === "aborted" && !pendingClearContextRef.current) {
            setSystemNotice({
              tone: "info",
              title: "Interrupted",
              body: "Use /exit, /quit, /bye, or Ctrl+D to exit.",
            });
          }
          break;
        }

        switch (value.type) {
          case "text":
            // Coalesce rapid SSE chunks into a 30ms window. Without this
            // every chunk forces a full Ink frame repaint, and combined
            // with the TodoList / ToolCallList above it the terminal
            // flickers and refuses to scroll.
            pendingTextRef.current += value.text;
            if (!flushTimerRef.current) {
              flushTimerRef.current = setTimeout(flushPendingText, 30);
            }
            break;
          case "tool_use_start":
            setToolCalls((prev) => [...prev, { id: value.id, name: value.name }]);
            await appendTranscriptEntry(toolContext.cwd, sessionIdRef.current, {
              type: "tool_event",
              timestamp: new Date().toISOString(),
              name: value.name,
              phase: "start",
            });
            break;
          case "permission_request":
            setSpinnerLabel("Waiting for permission");
            setPermissionPrompt({
              toolName: value.request.toolName,
              summary: value.request.summary,
              risk: value.request.risk,
              ruleHint: value.request.ruleHint,
            });
            break;
          case "tool_use_done": {
            const isPlanFileWrite =
              (value.name === "Write" || value.name === "Edit") &&
              value.result.content.includes(getPlansDirectory());
            const inputPreview = formatToolInputPreview(value.input);
            // Strip the model-only <sandbox_violations> tag from the
            // user-visible error message. The tag stays in the tool
            // result that goes back to the model (so it can interpret
            // sandbox denials), but humans see clean stderr only.
            const rawErrorMessage = value.result.isError ? value.result.content : undefined;
            const errorMessage = rawErrorMessage
              ? removeSandboxViolationTags(rawErrorMessage)
              : undefined;
            setToolCalls((prev) =>
              markToolCallComplete(prev, value.id, {
                resultLength: value.result.content.length,
                isError: value.result.isError,
                displayName: isPlanFileWrite ? "Updated plan" : undefined,
                displayHint: isPlanFileWrite ? "/plan to preview" : undefined,
                inputPreview,
                errorMessage,
              }),
            );
            await appendTranscriptEntry(toolContext.cwd, sessionIdRef.current, {
              type: "tool_event",
              timestamp: new Date().toISOString(),
              name: value.name,
              phase: "done",
              resultLength: value.result.content.length,
              isError: value.result.isError,
            });
            break;
          }
          case "assistant_message":
            // The full assistant text is committed to `messages` and will
            // render via ConversationView. Drop any unflushed pending
            // chunk so it can't overwrite the cleared streaming line.
            cancelPendingText();
            setStreamingText("");
            await appendTranscriptEntry(toolContext.cwd, sessionIdRef.current, {
              type: "message",
              timestamp: new Date().toISOString(),
              role: "assistant",
              message: value.message,
            });
            break;
          case "tool_result_message":
            setSpinnerLabel("Thinking");
            setPermissionPrompt(null);
            // Tool results are now committed to `messages` — the cards
            // will render inline in ConversationView from here on, so we
            // drop the live in-flight cards to avoid duplication and, more
            // importantly, to keep the final assistant text rendered
            // BELOW its tool calls (not above them).
            setToolCalls([]);
            await appendTranscriptEntry(toolContext.cwd, sessionIdRef.current, {
              type: "message",
              timestamp: new Date().toISOString(),
              role: "user",
              message: value.message,
            });
            break;
          case "messages_updated":
            setMessages(value.messages);
            break;
          case "usage_updated":
            {
              const engineMessages = engineRef.current?.getState().messages ?? [];
              const usageAnchorIndex = engineMessages.length > 0 ? engineMessages.length - 1 : -1;
              const snapshot = buildTokenBudgetSnapshot(engineMessages, {
                usage: value.lastCallUsage,
                usageAnchorIndex,
              });
              const contextPercent = Math.round((snapshot.estimatedConversationTokens / snapshot.contextWindow) * 100);
              const turnInput = value.turnUsage.input_tokens
                + (value.turnUsage.cache_creation_input_tokens ?? 0)
                + (value.turnUsage.cache_read_input_tokens ?? 0);
              const totalInput = value.totalUsage.input_tokens
                + (value.totalUsage.cache_creation_input_tokens ?? 0)
                + (value.totalUsage.cache_read_input_tokens ?? 0);
              setLastUsage({
                input: turnInput,
                output: value.turnUsage.output_tokens,
                contextTokens: snapshot.estimatedConversationTokens,
                contextPercent,
              });
              setTotalUsage({
                input: totalInput,
                output: value.totalUsage.output_tokens,
                contextTokens: snapshot.estimatedConversationTokens,
                contextPercent,
              });
            }
            await appendTranscriptEntry(toolContext.cwd, sessionIdRef.current, {
              type: "usage",
              timestamp: new Date().toISOString(),
              turn: value.turnUsage,
              total: value.totalUsage,
            });
            break;
          case "command":
            setSystemNotice(buildCommandNotice(value.message, value.kind));
            await appendTranscriptEntry(toolContext.cwd, sessionIdRef.current, {
              type: "system",
              timestamp: new Date().toISOString(),
              level: value.kind,
              message: value.message,
            });
            break;
          case "compacted": {
            const compactTitle = value.trigger === "micro"
              ? "Context micro-compacted"
              : value.trigger === "auto"
                ? "Context auto-compacted"
                : "Conversation compacted";
            const compactBody = value.trigger === "micro"
              ? "Old tool results cleared to save context space."
              : "Conversation history has been summarized to free up context window.";
            setSystemNotice({ tone: "info", title: compactTitle, body: compactBody });
            if (value.trigger !== "micro") {
              const compactedMessages = engineRef.current?.getState().messages ?? [];
              await appendCompactionSnapshot(
                toolContext.cwd,
                sessionIdRef.current,
                value.trigger as "auto" | "manual",
                compactedMessages,
              );
            } else {
              await appendTranscriptEntry(toolContext.cwd, sessionIdRef.current, {
                type: "system",
                timestamp: new Date().toISOString(),
                level: "info",
                message: `compaction:${value.trigger}`,
              });
            }
            break;
          }
          case "model_changed":
            setCurrentModel(value.model);
            break;
          case "mode_changed":
            setActivePermissionMode(value.mode);
            break;
          case "task_mode_changed":
            setTaskModeState(value.mode);
            break;
          case "session_cleared":
            cancelPendingText();
            setMessages([]);
            setStreamingText("");
            setToolCalls([]);
            setLastUsage(null);
            clearTodos(sessionIdRef.current);
            break;
          case "token_warning": {
            const w = value.warning;
            const pct = Math.round((w.estimatedTokens / w.contextWindow) * 100);
            if (w.state === "warning") {
              setSystemNotice({
                tone: "info",
                title: "Context window filling up",
                body: `${pct}% used (${w.estimatedTokens} / ${w.contextWindow} tokens). Consider using /compact.`,
              });
            } else if (w.state === "error") {
              setSystemNotice({
                tone: "error",
                title: "Context window nearly full",
                body: `${pct}% used (${w.estimatedTokens} / ${w.contextWindow} tokens). Auto-compaction will trigger.`,
              });
            } else if (w.state === "blocking") {
              setSystemNotice({
                tone: "error",
                title: "Context window limit reached",
                body: `${pct}% used (${w.estimatedTokens} / ${w.contextWindow} tokens). Use /compact to free space.`,
              });
            }
            break;
          }
          case "turn_complete":
            if (value.reason === "max_turns") {
              setSystemNotice({
                tone: "error",
                title: "Maximum tool turns reached",
                body: `Reached maximum tool turns (${value.turnCount}).`,
              });
            } else if (value.reason === "blocking_limit") {
              setSystemNotice({
                tone: "error",
                title: "Context window limit reached",
                body: "Cannot continue — context is full. Use /compact to free space.",
              });
            }
            break;
          case "error":
            setSystemNotice({
              tone: "error",
              title: "Agent error",
              body: value.error.message,
            });
            await appendTranscriptEntry(toolContext.cwd, sessionIdRef.current, {
              type: "system",
              timestamp: new Date().toISOString(),
              level: "error",
              message: value.error.message,
            });
            break;
        }
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        setSystemNotice({
          tone: "info",
          title: "Interrupted",
          body: "Use /exit, /quit, /bye, or Ctrl+D to exit.",
        });
      } else {
        setSystemNotice({
          tone: "error",
          title: "Unhandled error",
          body: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      setIsLoading(false);
      permissionResolverRef.current = null;
      setPermissionPrompt(null);
    }

    // After the loop completes, check if we need to clear context and re-submit
    if (pendingClearContextRef.current && engineRef.current) {
      pendingClearContextRef.current = false;
      const planContent = await readPlan();
      if (planContent) {
        const implementMsg = engineRef.current.clearContextAndImplement(planContent);
        cancelPendingText();
        setMessages([]);
        setStreamingText("");
        setToolCalls([]);
        setLastUsage(null);
        clearTodos(sessionIdRef.current);
        setSystemNotice({
          tone: "info",
          title: "Context cleared",
          body: "Starting fresh with the approved plan. Implementing...",
        });
        return submit(implementMsg);
      }
    }

    // After plan rejection with feedback, re-submit the feedback so the model continues planning
    if (pendingFeedbackRef.current && engineRef.current) {
      const feedback = pendingFeedbackRef.current;
      pendingFeedbackRef.current = null;
      return submit(`User rejected the plan. Feedback: ${feedback}\n\nPlease revise your plan based on this feedback.`);
    }

    return { handled: true };
  }, [onExit, toolContext.cwd, cancelPendingText, flushPendingText]);

  return {
    state: {
      messages,
      isLoading,
      spinnerLabel,
      streamingText,
      toolCalls,
      todos,
      tasks,
      taskMode,
      lastUsage,
      totalUsage,
      systemNotice,
      permissionPrompt,
      permissionMode: activePermissionMode,
      currentModel,
    },
    actions: {
      submit,
      interrupt,
      resolvePermission,
    },
  };
}
