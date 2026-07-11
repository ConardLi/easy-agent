import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStdout } from "ink";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { QueryEngine } from "../../core/queryEngine.js";
import type {
  ResumeSessionInfo,
  DiffViewData,
  MemoryPickerItem,
  PermissionsViewData,
} from "../../core/queryEngine.js";
import type { SettingSource } from "../../config/sources.js";
import { buildTokenBudgetSnapshot } from "../../utils/tokens.js";
import {
  appendCompactionSnapshot,
  appendTranscriptEntry,
  createSessionId,
  initSessionStorage,
  restoreSession,
  type FileHistorySnapshotRecord,
} from "../../session/storage.js";
import { configureFileHistory, restoreFileHistorySnapshots } from "../../session/fileHistory.js";
import {
  loadPermissionSettings,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRequest,
  type PermissionRuleSet,
  type PermissionSettings,
} from "../../permissions/permissions.js";
import {
  toolResultText,
  type ToolContext,
  type UserQuestionRequest,
  type UserQuestionResponse,
} from "../../tools/Tool.js";
import { readPlan, getPlanFilePath, getPlansDirectory } from "../../context/plans.js";
import type {
  PermissionPromptState,
  SystemNotice,
  ToolCallInfo,
  UsageSummary,
} from "../types.js";
import {
  markToolCallComplete,
  buildCommandNotice,
  CLEAR_TERMINAL,
  tokenWarningNotice,
  turnCompleteNotice,
  compactionNotice,
  apiRetryNotice,
  modeChangeNotice,
} from "./useAgentSession/notices.js";
import { classifyUserInput } from "./useAgentSession/inputClassification.js";
import { formatToolInputPreview, extractBashOutput } from "../utils/toolCardFormat.js";
import { bashTool } from "../../tools/bashTool.js";
import { clearTodos, getTodos, subscribeTodos } from "../../state/todoStore.js";
import type { TodoItem } from "../../types/todo.js";
import { getTaskListId, listTasks, subscribeTasks } from "../../state/taskStore.js";
import {
  clearAllSubAgentProgress,
  getSubAgentProgress,
  subscribeSubAgentProgress,
} from "../../state/subAgentProgressStore.js";
import {
  clearAllBashProgress,
  subscribeBashProgress,
} from "../../state/bashProgressStore.js";
import {
  clearAllToolStatus,
  subscribeToolStatus,
} from "../../state/toolStatusStore.js";
import { clearUiNotices } from "../../state/uiNoticeStore.js";
import {
  getAllAsyncAgents,
  subscribeAsyncAgents,
  type AsyncAgentEntry,
} from "../../state/asyncAgentStore.js";
import {
  pendingNotificationCount,
  subscribePendingNotifications,
} from "../../state/notificationStore.js";
import { loadSettingsDiagnostics } from "../../utils/settings.js";
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
  /**
   * Stage 33: launch `$EDITOR` on a memory file (`/memory edit <n>`). The UI
   * owns the TTY, so the App provides this; the engine only emits the
   * `open_editor` event with the resolved path. Returns whether the editor ran.
   */
  openEditor?: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
}

interface SubmitResult {
  handled: boolean;
}

export function useAgentSession({
  model,
  onExit,
  permissionMode,
  shouldResume,
  resumeSessionId,
  openEditor,
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
  const [questionPrompt, setQuestionPrompt] = useState<UserQuestionRequest | null>(null);
  const [permissionSettings, setPermissionSettings] = useState<PermissionSettings | null>(null);
  const [currentModel, setCurrentModel] = useState(model);
  const [activePermissionMode, setActivePermissionMode] = useState<string>(permissionMode ?? "default");
  const [todos, setTodosState] = useState<TodoItem[]>([]);
  const [tasks, setTasksState] = useState<Task[]>([]);
  const [taskMode, setTaskModeState] = useState<TaskMode>(getTaskMode());
  // Stage 24.1 — Ctrl+O transcript overlay. Mirrors Claude's
  // `app:toggleTranscript`: the inline conversation stays condensed (one-line
  // `⎿` summaries), and Ctrl+O opens a full-screen, scrollable, verbose
  // transcript rebuilt from the message log — so any past tool call can be
  // expanded retroactively without repainting the <Static> scrollback.
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  // Stage 33 — `/resume` interactive picker + `/diff` colorized panel. Both are
  // live-frame overlays (not <Static>): the picker owns the keyboard while open,
  // the diff panel is dismissed with Esc like any command result.
  const [resumePicker, setResumePicker] = useState<ResumeSessionInfo[] | null>(null);
  const [resumePickerIndex, setResumePickerIndex] = useState(0);
  const [diffView, setDiffView] = useState<DiffViewData | null>(null);
  // Stage 33 — `/memory` picker + `/permissions` manager interactive overlays.
  const [memoryPicker, setMemoryPicker] = useState<MemoryPickerItem[] | null>(null);
  const [memoryPickerIndex, setMemoryPickerIndex] = useState(0);
  const [permissionView, setPermissionView] = useState<PermissionsViewData | null>(null);
  // Stage 20: live snapshot of the asyncAgentStore. The footer
  // BackgroundAgentBar component reads this to show running background
  // sub-agents (count + per-agent token / tool stats). We take a fresh
  // snapshot via getAllAsyncAgents() on every store notification rather
  // than mutating in place — gives us straightforward referential
  // semantics for React to diff against.
  const [asyncAgents, setAsyncAgents] = useState<AsyncAgentEntry[]>(() =>
    getAllAsyncAgents(),
  );

  const permissionResolverRef = useRef<((decision: PermissionDecision) => void) | null>(null);
  // Resolver for the in-flight AskUserQuestion call (mirrors the permission
  // resolver). `null` answers means the user cancelled / declined.
  const questionResolverRef = useRef<((response: UserQuestionResponse | null) => void) | null>(null);
  const pendingClearContextRef = useRef(false);
  const pendingFeedbackRef = useRef<string | null>(null);
  // Stage 20: refs that the notification auto-trigger subscriber reads
  // synchronously. State variables would be stale inside the subscriber
  // closure (it's set up once on mount), so we mirror them into refs
  // and update on every render via the useEffect below.
  const isLoadingRef = useRef(false);
  const permissionPromptRef = useRef<PermissionPromptState | null>(null);
  const submitRef = useRef<((text: string) => Promise<SubmitResult>) | null>(null);
  const sessionRulesRef = useRef<PermissionRuleSet>({ allow: [], deny: [] });
  const engineRef = useRef<QueryEngine | null>(null);
  const sessionIdRef = useRef<string>(createSessionId());

  // Ink's safe stdout writer (clears the live frame, writes, restores it).
  // Mirrored into a ref because the engine-event consumer loop closes over an
  // earlier render scope; the ref always points at the current writer.
  const { write: writeStdout } = useStdout();
  const writeStdoutRef = useRef(writeStdout);
  writeStdoutRef.current = writeStdout;

  // Editor launcher (provided by App, which owns the TTY). Mirrored into a ref
  // for the same reason as writeStdout — the event loop closes over an older
  // render scope.
  const openEditorRef = useRef(openEditor);
  openEditorRef.current = openEditor;

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
      // AskUserQuestion bridge: surface the questions to the UI and return a
      // promise resolved by `resolveQuestion` once the user picks (or null on
      // cancel). Same shape as the permission-prompt bridge above. setState
      // and the resolver ref are stable, so an empty dep array is safe.
      requestUserQuestion: (request: UserQuestionRequest) => {
        setSpinnerLabel("Waiting for your answer");
        setQuestionPrompt(request);
        return new Promise<UserQuestionResponse | null>((resolve) => {
          questionResolverRef.current = resolve;
        });
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

  // Mirror sub-agent progress (published by AgentTool while a sub-agent
  // runs) into the matching ToolCallInfo card. Match is by tool_use id —
  // see subAgentProgressStore.ts for the rationale. Without this bridge
  // the parent's "Using tool: Agent" card would just sit there until the
  // sub-agent finished, with no visibility into what it was doing.
  useEffect(() => {
    const unsubscribe = subscribeSubAgentProgress((toolUseId, snapshot) => {
      setToolCalls((prev) =>
        prev.map((tc) => {
          if (tc.id !== toolUseId) return tc;
          if (snapshot === null) {
            // Entry was cleared — drop the per-card snapshot too so the
            // (rare) re-render after archive doesn't keep stale data.
            const { subAgentProgress: _drop, ...rest } = tc;
            return rest;
          }
          return { ...tc, subAgentProgress: snapshot };
        }),
      );
    });
    return unsubscribe;
  }, []);

  // Mirror live Bash output (published by BashTool while a command runs)
  // into the matching ToolCallInfo card — same id-keyed bridge as the
  // sub-agent progress above. Lets long-running commands show their tail.
  useEffect(() => {
    const unsubscribe = subscribeBashProgress((toolUseId, snapshot) => {
      setToolCalls((prev) =>
        prev.map((tc) => {
          if (tc.id !== toolUseId) return tc;
          if (snapshot === null) {
            const { bashProgress: _drop, ...rest } = tc;
            return rest;
          }
          return { ...tc, bashProgress: snapshot };
        }),
      );
    });
    return unsubscribe;
  }, []);

  // Mirror the live execution phase (queued → classifier → waiting-permission
  // → running), published by the agentic loop's runOneToolBlock, into the
  // matching card so the dot + sub-line reflect "what is this tool doing right
  // now". Same id-keyed bridge as bash/sub-agent progress above.
  useEffect(() => {
    const unsubscribe = subscribeToolStatus((toolUseId, status) => {
      setToolCalls((prev) =>
        prev.map((tc) => {
          if (tc.id !== toolUseId) return tc;
          if (status === null) {
            const { status: _drop, ...rest } = tc;
            return rest;
          }
          return { ...tc, status };
        }),
      );
    });
    return unsubscribe;
  }, []);

  // Stage 20: subscribe to the async-agent store. Every register /
  // progress / complete / fail / kill event fires the listener, and we
  // re-snapshot the full registry to drive the BackgroundAgentBar.
  // Re-snapshotting on every event is cheap — the registry holds at
  // most a handful of agents per session.
  useEffect(() => {
    const unsubscribe = subscribeAsyncAgents(() => {
      setAsyncAgents(getAllAsyncAgents());
    });
    // Pull the current snapshot once on mount so a session resume sees
    // any agents that were already in flight.
    setAsyncAgents(getAllAsyncAgents());
    return unsubscribe;
  }, []);

  // Stage 20: keep the auto-trigger refs in sync with current state.
  // The subscribePendingNotifications listener (set up once on mount)
  // reads these synchronously to decide whether the engine is idle.
  useEffect(() => {
    isLoadingRef.current = isLoading;
  }, [isLoading]);
  useEffect(() => {
    permissionPromptRef.current = permissionPrompt;
  }, [permissionPrompt]);

  // Stage 20: idle auto-resume after a background sub-agent finishes.
  //
  // Source-aligned with `useQueueProcessor` + `processQueueIfReady`
  // (claude-code-source-code/src/hooks/useQueueProcessor.ts:33-61):
  // when the parent loop is idle and the notification queue is
  // non-empty, the source synthesises a submit so the model can
  // react to the finished sub-agent without the user having to type.
  // Without this hook, our notifications would only be drained the
  // next time the user actually typed something — which is exactly
  // what the user noticed: a backgrounded reviewer finishes, the
  // pill disappears, but the conversation stays silent.
  //
  // A subtle detail: when a notification arrives WHILE a turn is
  // active, the listener's `isLoadingRef` check skips. The retry
  // happens via the second useEffect below (depends on isLoading) —
  // when the turn ends, isLoading flips false; if the queue still
  // has entries (drained by the in-flight turn would have been a no-op
  // because submitInternal drains at the *start* of the turn, before
  // the notification arrived), we kick off another auto-trigger.
  useEffect(() => {
    const unsubscribe = subscribePendingNotifications(() => {
      // Defer to a microtask so multiple back-to-back enqueues
      // (e.g. two background agents finishing in the same tick) only
      // trigger one auto-resume — the deferred handler sees the full
      // queue and submitInternal drains it all at once.
      queueMicrotask(() => {
        if (isLoadingRef.current) return;
        if (permissionPromptRef.current) return;
        if (pendingNotificationCount() === 0) return;
        const fn = submitRef.current;
        if (!fn) return;
        void fn("");
      });
    });
    return unsubscribe;
  }, []);

  // Retry-on-idle: if a notification was enqueued while we were busy,
  // the listener above bailed out. As soon as we transition back to
  // idle, sweep the queue. (No-op when queue is empty.)
  useEffect(() => {
    if (isLoading) return;
    if (permissionPrompt) return;
    if (pendingNotificationCount() === 0) return;
    const fn = submitRef.current;
    if (!fn) return;
    void fn("");
  }, [isLoading, permissionPrompt]);

  useEffect(() => {
    const cwd = process.cwd();
    void loadPermissionSettings(cwd)
      .then(setPermissionSettings)
      .catch((error: unknown) => {
        setSystemNotice({
          tone: "error",
          title: "Permission settings error",
          body: error instanceof Error ? error.message : String(error),
        });
      });
    // A malformed settings.json degrades to "ignored" rather than crashing the
    // CLI — surface a single non-fatal notice so the user knows their config
    // isn't being applied and where to fix it.
    void loadSettingsDiagnostics(cwd)
      .then((errors) => {
        if (errors.length === 0) return;
        setSystemNotice({
          tone: "error",
          title: "Some settings were ignored",
          body: [...errors, "", "Fix the file(s) above; the rest of your config still applies."].join("\n"),
        });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!permissionSettings) return;

    let cancelled = false;

    const initialize = async () => {
      try {
        let initialMessages: MessageParam[] = [];
        let initialUsage = { input_tokens: 0, output_tokens: 0 };
        let restoredFileHistory: FileHistorySnapshotRecord[] = [];

        if (shouldResume) {
          const restored = await restoreSession(toolContext.cwd, resumeSessionId ?? undefined);
          if (cancelled) return;
          sessionIdRef.current = restored.summary.sessionId;
          initialMessages = restored.messages;
          initialUsage = restored.summary.totalUsage;
          restoredFileHistory = restored.fileHistorySnapshots;
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

        // Stage 26: bind file-history to this session (reads the
        // checkpointingEnabled setting + sets the backup dir / cwd), then
        // fold any persisted snapshots back in so /rewind survives --resume.
        await configureFileHistory(toolContext.cwd, sessionIdRef.current);
        if (restoredFileHistory.length > 0) {
          restoreFileHistorySnapshots(restoredFileHistory);
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
              input: request.input,
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
          setSystemNotice(modeChangeNotice(newMode));
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

    // An in-flight AskUserQuestion → cancel it (the tool gets a null answer).
    if (questionResolverRef.current) {
      questionResolverRef.current(null);
      questionResolverRef.current = null;
      setQuestionPrompt(null);
      setSystemNotice({
        tone: "info",
        title: "Question cancelled",
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
    }
    return true;
  }, []);

  // Resolve the in-flight AskUserQuestion with the user's selections (or null
  // to cancel). Mirrors resolvePermission — clears the dialog and hands the
  // answers back to the awaiting tool call.
  const resolveQuestion = useCallback((response: UserQuestionResponse | null): boolean => {
    if (!questionResolverRef.current) return false;
    questionResolverRef.current(response);
    questionResolverRef.current = null;
    setQuestionPrompt(null);
    if (response === null) {
      setSpinnerLabel("Thinking");
    }
    return true;
  }, []);

  // Ctrl+O — open/close the full-screen verbose transcript overlay.
  const toggleTranscript = useCallback(() => {
    setTranscriptOpen((v) => !v);
  }, []);
  const closeTranscript = useCallback(() => {
    setTranscriptOpen(false);
  }, []);

  const submit = useCallback(async (text: string): Promise<SubmitResult> => {
    const trimmed = text.trim();
    // Stage 20: empty text is valid when the auto-trigger
    // (subscribePendingNotifications below) wakes us up to drain the
    // notification queue. submitMessage("") routes to submitInternal
    // which prepends the queued <task-notification> blocks as the
    // turn's user content. Reject empty input only when there's also
    // nothing in the queue.
    if (!trimmed && pendingNotificationCount() === 0) {
      return { handled: false };
    }

    if (trimmed === "/exit" || trimmed === "/quit" || trimmed === "/bye") {
      onExit();
      return { handled: true };
    }

    // Bash mode (`!cmd`): run a shell command directly, bypassing the LLM —
    // a quick local escape hatch. Output surfaces in a system notice (capped),
    // and the command still honors the project's sandbox settings via BashTool.
    if (trimmed.startsWith("!")) {
      const command = trimmed.slice(1).trim();
      if (!command) return { handled: true };
      setSystemNotice({ tone: "info", title: `! ${command}`, body: "running…" });
      try {
        const result = await bashTool.call({ command }, { ...toolContext });
        const raw = extractBashOutput(toolResultText(result.content)) || "(no output)";
        const lines = raw.split("\n");
        const MAX = 40;
        const body =
          lines.length > MAX
            ? [...lines.slice(0, MAX), `… +${lines.length - MAX} more lines`].join("\n")
            : raw;
        setSystemNotice({
          tone: result.isError ? "error" : "info",
          title: `! ${command}`,
          body,
        });
      } catch (error) {
        setSystemNotice({
          tone: "error",
          title: `! ${command}`,
          body: error instanceof Error ? error.message : String(error),
        });
      }
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

    // Classify the input: system command (synchronous notice) vs. LLM-
    // triggering (skill / user-defined / built-in prompt command, or plain
    // chat) — the latter engages the full agentic loop. See classifyUserInput.
    const { isLlmTriggering } = classifyUserInput(trimmed);

    cancelPendingText();
    setStreamingText("");
    setToolCalls([]);
    setSystemNotice(null);
    // A new turn (or command) dismisses any open stage-33 overlay.
    setResumePicker(null);
    setDiffView(null);
    setMemoryPicker(null);
    setPermissionView(null);
    if (isLlmTriggering) {
      setLastUsage(null);
      // Persist what the user actually typed (`/hello-world Easy Agent`)
      // rather than the expanded SKILL.md body. The expanded prompt is
      // an internal/wire-only artifact — keeping the transcript clean
      // means /resume replays the same UX the user originally saw.
      //
      // Stage 20: skip this when `trimmed` is empty — that means we're
      // here via the auto-trigger from subscribePendingNotifications,
      // and the queued <task-notification> is itself the user-side
      // transcript entry (added inside submitInternal). Persisting an
      // empty user message would pollute the transcript and confuse
      // /resume.
      if (trimmed.length > 0) {
        // Stage 26: open the file-history turn before persisting, so the
        // user-message entry and any snapshot taken this turn share an id.
        const messageId = engineRef.current.beginUserTurn();
        await appendTranscriptEntry(toolContext.cwd, sessionIdRef.current, {
          type: "message",
          timestamp: new Date().toISOString(),
          role: "user",
          message: { role: "user", content: trimmed },
          messageId,
        });
      }
    }
    setPermissionPrompt(null);
    const needsLoading = isLlmTriggering || trimmed.startsWith("/compact");
    setIsLoading(needsLoading);
    setSpinnerLabel(
      trimmed.startsWith("/compact")
        ? "Compacting"
        : trimmed.length === 0
          ? "Background sub-agent finished — replying"
          : "Thinking",
    );

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
          case "thinking_start":
            // Stage 34: mirror source — during the thinking stream we only
            // surface a spinner ("✻ Thinking…"), not the reasoning text.
            // The finished thinking block lands in the committed assistant
            // message and renders (folded) via ConversationView.
            setSpinnerLabel("Thinking");
            break;
          case "thinking_delta":
          case "thinking_done":
          case "redacted_thinking":
            // No live-text rendering (source shows thinking only once the
            // block completes and is committed to the transcript).
            break;
          case "tool_use_start": {
            // For the Agent tool: by the time tool_use_start fires the
            // agentTool body has either not started yet OR has already
            // pushed the initial snapshot to the store (depends on the
            // event-loop interleave). Pull the current store value so
            // the very first render of the card is rich, not "Using
            // tool: Agent". Subsequent updates flow through the store
            // subscription set up above.
            const seeded =
              value.name === "Agent" ? getSubAgentProgress(value.id) : undefined;
            setToolCalls((prev) => [
              ...prev,
              {
                id: value.id,
                name: value.name,
                ...(seeded ? { subAgentProgress: seeded } : {}),
              },
            ]);
            await appendTranscriptEntry(toolContext.cwd, sessionIdRef.current, {
              type: "tool_event",
              timestamp: new Date().toISOString(),
              name: value.name,
              phase: "start",
            });
            break;
          }
          case "permission_request":
            setSpinnerLabel("Waiting for permission");
            setPermissionPrompt({
              toolName: value.request.toolName,
              summary: value.request.summary,
              risk: value.request.risk,
              ruleHint: value.request.ruleHint,
              input: value.request.input,
            });
            break;
          case "tool_use_done": {
            const resultText = toolResultText(value.result.content);
            const isPlanFileWrite =
              (value.name === "Write" || value.name === "Edit") &&
              resultText.includes(getPlansDirectory());
            const inputPreview = formatToolInputPreview(value.input);
            // Strip the model-only <sandbox_violations> tag from the
            // user-visible error message. The tag stays in the tool
            // result that goes back to the model (so it can interpret
            // sandbox denials), but humans see clean stderr only.
            const rawErrorMessage = value.result.isError ? resultText : undefined;
            const errorMessage = rawErrorMessage
              ? removeSandboxViolationTags(rawErrorMessage)
              : undefined;
            setToolCalls((prev) =>
              markToolCallComplete(prev, value.id, {
                resultLength: resultText.length,
                isError: value.result.isError,
                displayName: isPlanFileWrite ? "Updated plan" : undefined,
                displayHint: isPlanFileWrite ? "/plan to preview" : undefined,
                inputPreview,
                input: value.input,
                errorMessage,
              }),
            );
            await appendTranscriptEntry(toolContext.cwd, sessionIdRef.current, {
              type: "tool_event",
              timestamp: new Date().toISOString(),
              name: value.name,
              phase: "done",
              resultLength: resultText.length,
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
              ...(engineRef.current.getCurrentMessageId()
                ? { messageId: engineRef.current.getCurrentMessageId()! }
                : {}),
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
            // Sub-agent progress entries lived alongside in-flight cards;
            // since we just dropped those cards, drop the matching store
            // entries too. ConversationView renders the historical Agent
            // card from the formatted tool_result text, not the store.
            clearAllSubAgentProgress();
            clearAllBashProgress();
            clearAllToolStatus();
            await appendTranscriptEntry(toolContext.cwd, sessionIdRef.current, {
              type: "message",
              timestamp: new Date().toISOString(),
              role: "user",
              message: value.message,
              ...(engineRef.current.getCurrentMessageId()
                ? { messageId: engineRef.current.getCurrentMessageId()! }
                : {}),
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
            // Slash-command output is a blocking panel: it pins above the
            // input, suppresses typing, and waits for Esc — matching Claude's
            // local-jsx commands. (Skill / user prompt commands never reach
            // here; they expand into a model turn, so they stay non-blocking.)
            setSystemNotice({ ...buildCommandNotice(value.message, value.kind), dismissable: true });
            await appendTranscriptEntry(toolContext.cwd, sessionIdRef.current, {
              type: "system",
              timestamp: new Date().toISOString(),
              level: value.kind,
              message: value.message,
            });
            break;
          case "notice":
            // Transient, non-blocking feedback (e.g. image attached). Unlike a
            // `command` panel it has no `dismissable` flag, so it never hides
            // the input — it just shows above it and is replaced by the next.
            setSystemNotice({ tone: value.tone, title: value.title, body: value.body });
            break;
          case "resume_picker":
            // `/resume` (no arg) → open the interactive session picker.
            // useResumePicker owns the keyboard from here; Enter re-invokes
            // `/resume <id>` to perform the actual in-process switch.
            setResumePicker(value.sessions);
            setResumePickerIndex(0);
            break;
          case "diff_view":
            // `/diff` → colorized panel (dismissed with Esc, like a command).
            setDiffView(value.data);
            break;
          case "memory_picker":
            // `/memory` (no args) → interactive file picker; Enter re-invokes
            // `/memory edit <n>` to launch $EDITOR.
            setMemoryPicker(value.items);
            setMemoryPickerIndex(0);
            break;
          case "permissions_view":
            // `/permissions` (no args) → interactive allow/deny manager. The
            // overlay mutates rules directly via engine.mutatePermissionRule().
            setPermissionView(value.data);
            break;
          case "open_editor": {
            // `/memory edit <n>` → hand the TTY to $EDITOR. The launcher
            // (App, via useStdin) suspends Ink's raw mode, runs the editor with
            // inherited stdio, then restores + repaints. We await it inline so
            // the result notice fires only after the editor exits.
            const launcher = openEditorRef.current;
            if (!launcher) {
              setSystemNotice({
                tone: "error",
                title: "Cannot open editor",
                body: "No editor handler is available in this session.",
              });
              break;
            }
            const result = await launcher(value.filePath);
            if (result.ok) {
              setSystemNotice({
                tone: "info",
                title: "Memory file saved",
                body: `Edited ${value.label}\n${value.filePath}`,
              });
            } else {
              setSystemNotice({
                tone: "error",
                title: "Editor did not complete",
                body: result.error ?? "Unknown error opening the editor.",
              });
            }
            break;
          }
          case "compacted": {
            setSystemNotice(compactionNotice(value.trigger));
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
          case "session_switched": {
            // Stage 33: `/resume <n|id>` swapped the engine's conversation in
            // place. Rebind the UI to the resumed session: new id (so tools
            // and transcript appends target it), restored messages + usage,
            // and the file-history snapshots so /rewind keeps working.
            cancelPendingText();
            setStreamingText("");
            setToolCalls([]);
            clearAllSubAgentProgress();
            clearAllBashProgress();
            clearAllToolStatus();
            clearUiNotices();
            setResumePicker(null);
            setDiffView(null);
            setMemoryPicker(null);
            setPermissionView(null);
            clearTodos(sessionIdRef.current);
            sessionIdRef.current = value.sessionId;
            // Repaint the restored conversation cleanly. Ink's <Static> only
            // resets its print cursor when the item count DROPS, so we blank the
            // list first (commit 1 → Static resets), wipe the terminal, then
            // restore the messages on a later tick (commit 2 → Static reprints
            // from a clean slate). A single setMessages(restored) would leave the
            // cursor past the end and the screen would look empty after the clear
            // — which reads as "/resume didn't switch".
            setMessages([]);
            setTotalUsage({
              input: value.totalUsage.input_tokens,
              output: value.totalUsage.output_tokens,
            });
            setLastUsage(null);
            setTodosState(getTodos(value.sessionId));
            try {
              await configureFileHistory(toolContext.cwd, value.sessionId);
              if (value.fileHistorySnapshots.length > 0) {
                restoreFileHistorySnapshots(value.fileHistorySnapshots);
              }
            } catch {
              // file-history rebind is best-effort
            }
            writeStdoutRef.current?.(CLEAR_TERMINAL);
            {
              const restoredMessages = value.messages;
              setTimeout(() => setMessages(restoredMessages), 0);
            }
            break;
          }
          case "session_cleared":
            cancelPendingText();
            setMessages([]);
            setStreamingText("");
            setToolCalls([]);
            setLastUsage(null);
            clearTodos(sessionIdRef.current);
            clearAllSubAgentProgress();
            clearAllBashProgress();
            clearAllToolStatus();
            clearUiNotices();
            // Wipe the terminal so the previous conversation is gone from the
            // screen and scrollback, matching the user's expectation that
            // /clear starts from a blank slate. React state was just reset
            // above, so the live frame Ink restores after the escape is the
            // empty post-clear UI.
            writeStdoutRef.current?.(CLEAR_TERMINAL);
            break;
          case "token_warning": {
            const notice = tokenWarningNotice(value.warning);
            if (notice) setSystemNotice(notice);
            break;
          }
          case "api_retry": {
            // Stage 27: the API layer is backing off before re-issuing a
            // request after a transient failure. Show a transient notice with
            // the countdown so the user knows we're retrying, not hung.
            setSpinnerLabel("Retrying");
            setSystemNotice(apiRetryNotice(value));
            break;
          }
          case "stream_restart":
            // Stage 27: about to re-run the turn (max_tokens escalation or
            // reactive compact). Drop any partially-streamed text so the
            // re-run renders cleanly instead of concatenating.
            cancelPendingText();
            setStreamingText("");
            if (value.reason === "reactive_compact") {
              setSystemNotice({
                tone: "info",
                title: "Context compacted",
                body: "The prompt exceeded the context window — history was summarized and the request retried.",
              });
            }
            break;
          case "turn_complete": {
            const notice = turnCompleteNotice(value.reason, value.turnCount);
            if (notice) setSystemNotice(notice);
            break;
          }
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
      // A question left hanging (loop aborted mid-ask) → resolve null so the
      // awaiting tool call unblocks instead of leaking a promise.
      if (questionResolverRef.current) {
        questionResolverRef.current(null);
        questionResolverRef.current = null;
      }
      setQuestionPrompt(null);
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

  // Stage 20: expose `submit` to the notification subscriber via a ref.
  // The subscriber is set up once on mount and would otherwise close
  // over a stale `submit` reference. The ref is updated on every render
  // so the subscriber always gets the freshest `submit`.
  useEffect(() => {
    submitRef.current = submit;
  }, [submit]);

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
      questionPrompt,
      permissionMode: activePermissionMode,
      currentModel,
      asyncAgents,
      transcriptOpen,
      resumePicker,
      resumePickerIndex,
      diffView,
      memoryPicker,
      memoryPickerIndex,
      permissionView,
    },
    actions: {
      submit,
      interrupt,
      resolvePermission,
      resolveQuestion,
      toggleTranscript,
      closeTranscript,
      // A command result panel and the /diff panel share one dismiss path.
      dismissNotice: () => {
        setSystemNotice(null);
        setDiffView(null);
      },
      showNotice: (notice: SystemNotice) => setSystemNotice(notice),
      // Resume-picker controls, driven by useResumePicker.
      moveResumePicker: (nextIndex: number) => setResumePickerIndex(nextIndex),
      closeResumePicker: () => setResumePicker(null),
      // Selecting a session closes the picker and re-invokes `/resume <id>`,
      // reusing the engine's in-process switch (session_switched).
      confirmResume: (sessionId: string) => {
        setResumePicker(null);
        void submit(`/resume ${sessionId}`);
      },
      // Memory-picker controls, driven by useMemoryPicker.
      moveMemoryPicker: (nextIndex: number) => setMemoryPickerIndex(nextIndex),
      closeMemoryPicker: () => setMemoryPicker(null),
      // Selecting a file closes the picker and re-invokes `/memory edit <n>`,
      // reusing the engine's $EDITOR launch (open_editor).
      confirmMemoryEdit: (pickIndex: number) => {
        setMemoryPicker(null);
        void submit(`/memory edit ${pickIndex + 1}`);
      },
      // Permission-manager controls. Mutations call the engine directly (write +
      // reload) and feed back the fresh view so the overlay stays open.
      closePermissions: () => setPermissionView(null),
      permissionMutate: (
        op: "allow" | "deny" | "remove",
        rule: string,
        scope: SettingSource,
      ) => {
        const engine = engineRef.current;
        if (!engine) return;
        void engine
          .mutatePermissionRule(op, rule, scope)
          .then((next) => setPermissionView(next))
          .catch((error: unknown) => {
            setSystemNotice({
              tone: "error",
              title: "Permission update failed",
              body: error instanceof Error ? error.message : String(error),
            });
            setPermissionView(null);
          });
      },
    },
  };
}
