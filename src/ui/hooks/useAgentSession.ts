/**
 * useAgentSession — binds the terminal UI to one SDK session.
 *
 * The session (src/sdk) owns the conversation: turns, transcript, permission
 * and question requests, plan follow-ups, and background wake-ups. This hook
 * opens it, translates its events into React state, and turns key presses
 * into session calls. What stays here is terminal presentation: streaming
 * text throttling, tool cards, notices, overlays, screen clearing, and the
 * `$EDITOR` hand-off.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useStdout } from "ink";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import type {
  DiffViewData,
  MemoryPickerItem,
  PermissionsViewData,
  PluginViewData,
  ResumeSessionInfo,
} from "../../core/queryEngine/types.js";
import type { PluginMutation } from "../../core/queryEngine/commands/plugin.js";
import type { SettingSource } from "../../config/sources.js";
import type { PermissionDecision, PermissionMode } from "../../permissions/permissions.js";
import type { PluginInstallPreview } from "../../plugins/install.js";
import {
  type AgentRuntime,
  type AgentSession,
  type BackgroundAgentInfo,
  INTERACTIVE_DEFAULT_MAX_TURNS,
  type InteractionRequest,
  isAgentSdkError,
  type PlanApprovalResponse,
  type PermissionResponse,
  type SessionEvent,
  type Task,
  type TaskMode,
  type TodoItem,
  type ToolProgress,
  type Usage,
  type UserQuestion,
} from "../../sdk/index.js";
import { clearUiNotices } from "../../state/uiNoticeStore.js";
import { toolResultText, type UserQuestionResponse } from "../../tools/Tool.js";
import { loadSettingsDiagnostics } from "../../utils/settings.js";
import { removeSandboxViolationTags } from "../../sandbox/index.js";
import { getPlansRoot } from "../../utils/paths.js";
import type { PermissionPromptState, SystemNotice, ToolCallInfo, UsageSummary } from "../types.js";
import {
  apiRetryNotice,
  buildCommandNotice,
  CLEAR_TERMINAL,
  compactionNotice,
  markToolCallComplete,
  modeChangeNotice,
  tokenWarningNotice,
  turnCompleteNotice,
} from "./useAgentSession/notices.js";
import { extractBashOutput, formatToolInputPreview } from "../utils/toolCardFormat.js";

interface UseAgentSessionOptions {
  runtime: AgentRuntime;
  model: string;
  onExit: () => void;
  permissionMode?: PermissionMode;
  shouldResume?: boolean;
  resumeSessionId?: string | null;
  /**
   * Launch `$EDITOR` on a memory file (`/memory edit <n>`). The UI
   * owns the TTY, so the App provides this; the session only emits the
   * `editor_requested` event with the resolved path. Returns whether the editor ran.
   */
  openEditor?: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
}

interface SubmitResult {
  handled: boolean;
}

const EXIT_HINT = "Use /exit, /quit, /bye, or Ctrl+D to exit.";
const INTERRUPTED_NOTICE: SystemNotice = { tone: "info", title: "Interrupted", body: EXIT_HINT };
/** Live output shown for a `!command`, in lines. */
const SHELL_OUTPUT_LINES = 40;

/** Card field each live progress kind is mirrored into. */
const PROGRESS_FIELD = {
  status: "status",
  bash: "bashProgress",
  mcp: "mcpProgress",
  subagent: "subAgentProgress",
} as const satisfies Record<ToolProgress["kind"], keyof ToolCallInfo>;

function applyToolProgress(card: ToolCallInfo, progress: ToolProgress): ToolCallInfo {
  const field = PROGRESS_FIELD[progress.kind];
  const value = progress.kind === "status" ? progress.status : progress.progress;
  if (value === null) {
    const { [field]: _dropped, ...rest } = card;
    return rest;
  }
  return { ...card, [field]: value };
}

/** Input tokens include cache writes and reads, so the footer shows what the request consumed. */
function toUsageSummary(usage: Usage): { input: number; output: number } {
  return {
    input: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
    output: usage.output_tokens,
  };
}

/** Map a dialog decision onto the answer the pending request expects. */
function toResponse(
  request: InteractionRequest,
  decision: PermissionDecision,
  feedback?: string,
): PermissionResponse | PlanApprovalResponse {
  if (request.kind === "plan_approval") {
    if (decision === "deny") return { decision: "reject", ...(feedback ? { feedback } : {}) };
    if (decision === "allow_clear_context") return { decision: "approve", clearContext: true, acceptEdits: true };
    if (decision === "allow_accept_edits") return { decision: "approve", acceptEdits: true };
    return { decision: "approve" };
  }
  if (decision === "allow_always" || decision === "deny") return { decision };
  return { decision: "allow_once" };
}

export function useAgentSession({
  runtime,
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
  const [questionPrompt, setQuestionPrompt] = useState<{ questions: UserQuestion[] } | null>(null);
  const [currentModel, setCurrentModel] = useState(model);
  const [activePermissionMode, setActivePermissionMode] = useState<string>(permissionMode ?? "default");
  const [todos, setTodosState] = useState<TodoItem[]>([]);
  const [tasks, setTasksState] = useState<Task[]>([]);
  const [taskMode, setTaskModeState] = useState<TaskMode>("task");
  // Ctrl+O transcript overlay: the inline conversation stays condensed (one-line
  // `⎿` summaries), and Ctrl+O opens a full-screen, scrollable, verbose
  // transcript rebuilt from the message log — so any past tool call can be
  // expanded retroactively without repainting the <Static> scrollback.
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  // `/resume` interactive picker + `/diff` colorized panel. Both are
  // live-frame overlays (not <Static>): the picker owns the keyboard while open,
  // the diff panel is dismissed with Esc like any command result.
  const [resumePicker, setResumePicker] = useState<ResumeSessionInfo[] | null>(null);
  const [resumePickerIndex, setResumePickerIndex] = useState(0);
  const [diffView, setDiffView] = useState<DiffViewData | null>(null);
  // `/memory` picker + `/permissions` manager interactive overlays.
  const [memoryPicker, setMemoryPicker] = useState<MemoryPickerItem[] | null>(null);
  const [memoryPickerIndex, setMemoryPickerIndex] = useState(0);
  const [permissionView, setPermissionView] = useState<PermissionsViewData | null>(null);
  // `/plugin` interactive manager overlay.
  const [pluginView, setPluginView] = useState<PluginViewData | null>(null);
  // Background sub-agents of this session, for the footer BackgroundAgentBar.
  const [asyncAgents, setAsyncAgents] = useState<BackgroundAgentInfo[]>([]);

  const sessionRef = useRef<AgentSession | null>(null);
  // The request behind the open permission dialog / question dialog.
  const permissionRequestRef = useRef<InteractionRequest | null>(null);
  const questionRequestRef = useRef<InteractionRequest | null>(null);
  // Submissions run one at a time; a busy session finishes its turn first.
  const submitChainRef = useRef<Promise<unknown>>(Promise.resolve());

  // Ink's safe stdout writer (clears the live frame, writes, restores it).
  // Mirrored into a ref because the session listener is created once.
  const { write: writeStdout } = useStdout();
  const writeStdoutRef = useRef(writeStdout);
  writeStdoutRef.current = writeStdout;

  // Editor launcher (provided by App, which owns the TTY), mirrored for the
  // same reason as writeStdout.
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

  const closeInteractionDialogs = useCallback(() => {
    permissionRequestRef.current = null;
    questionRequestRef.current = null;
    setPermissionPrompt(null);
    setQuestionPrompt(null);
  }, []);

  // ─── Session events → UI state ──────────────────────────────────────────
  const handleEvent = useCallback(
    (event: SessionEvent): void => {
      switch (event.type) {
        case "state_snapshot":
          setMessages(event.state.messages);
          setTodosState(event.state.todos);
          setTasksState(event.state.tasks);
          setTaskModeState(event.state.taskMode);
          setAsyncAgents(event.state.backgroundAgents);
          setActivePermissionMode(event.state.permissionMode);
          return;
        case "turn_started": {
          const isCompact = event.input.startsWith("/compact");
          cancelPendingText();
          setStreamingText("");
          setToolCalls([]);
          setSystemNotice(null);
          // A new turn (or command) dismisses any open overlay.
          setResumePicker(null);
          setDiffView(null);
          setMemoryPicker(null);
          setPermissionView(null);
          if (event.runsModel) setLastUsage(null);
          setPermissionPrompt(null);
          setIsLoading(event.runsModel || isCompact);
          setSpinnerLabel(
            isCompact
              ? "Compacting"
              : event.input.length === 0
                ? "Background sub-agent finished — replying"
                : "Thinking",
          );
          return;
        }
        case "turn_completed": {
          if (event.reason !== undefined && event.toolTurns !== undefined) {
            const notice = turnCompleteNotice(event.reason, event.toolTurns);
            if (notice) setSystemNotice(notice);
          }
          // Approving a plan with a context clear interrupts the planning
          // turn on purpose; the implementation turn follows.
          if (event.reason === "aborted" && event.continuation !== "plan_followup") {
            setSystemNotice(INTERRUPTED_NOTICE);
          }
          setIsLoading(false);
          closeInteractionDialogs();
          return;
        }
        case "turn_failed":
          setSystemNotice(
            event.error.name === "AbortError"
              ? INTERRUPTED_NOTICE
              : { tone: "error", title: "Unhandled error", body: event.error.message },
          );
          setIsLoading(false);
          closeInteractionDialogs();
          return;
        case "text_delta":
          // Coalesce rapid SSE chunks into a 30ms window.
          pendingTextRef.current += event.text;
          if (!flushTimerRef.current) {
            flushTimerRef.current = setTimeout(flushPendingText, 30);
          }
          return;
        case "thinking_started":
          // During the thinking stream we only surface a spinner; the finished
          // thinking block renders (folded) from the committed message.
          setSpinnerLabel("Thinking");
          return;
        case "thinking_delta":
        case "thinking_completed":
        case "redacted_thinking":
          return;
        case "tool_started":
          setToolCalls((prev) => [
            ...prev,
            {
              id: event.toolUseId,
              name: event.name,
              ...(event.subAgentProgress ? { subAgentProgress: event.subAgentProgress } : {}),
            },
          ]);
          return;
        case "tool_progress":
          setToolCalls((prev) =>
            prev.map((card) => (card.id === event.toolUseId ? applyToolProgress(card, event.progress) : card)),
          );
          return;
        case "tool_completed": {
          const resultText = toolResultText(event.result.content);
          const isPlanFileWrite =
            (event.name === "Write" || event.name === "Edit") && resultText.includes(getPlansRoot());
          // The model-only <sandbox_violations> tag stays in the tool result
          // the model sees; humans get clean stderr.
          const errorMessage = event.result.isError && resultText ? removeSandboxViolationTags(resultText) : undefined;
          setToolCalls((prev) =>
            markToolCallComplete(prev, event.toolUseId, {
              resultLength: resultText.length,
              isError: event.result.isError,
              displayName: isPlanFileWrite ? "Updated plan" : undefined,
              displayHint: isPlanFileWrite ? "/plan to preview" : undefined,
              inputPreview: formatToolInputPreview(event.input),
              input: event.input,
              errorMessage,
            }),
          );
          return;
        }
        case "assistant_message":
          // The full text is committed to `messages`; drop any unflushed chunk
          // so it can't overwrite the cleared streaming line.
          cancelPendingText();
          setStreamingText("");
          return;
        case "tool_results":
          setSpinnerLabel("Thinking");
          setPermissionPrompt(null);
          // Committed results render inline in the conversation from here on;
          // dropping the live cards keeps the final text below its tool calls.
          setToolCalls([]);
          return;
        case "messages_changed":
          setMessages(event.messages);
          return;
        case "usage_changed": {
          const { usage } = event;
          const context = usage.context;
          const contextFields = context ? { contextTokens: context.tokens, contextPercent: context.percent } : {};
          if (usage.turn) setLastUsage({ ...toUsageSummary(usage.turn), ...contextFields });
          setTotalUsage({ ...toUsageSummary(usage.total), ...contextFields });
          return;
        }
        case "command_progress":
          // Long-running local commands (plugin operations) report progress
          // before their first await; a busy state gives Ink an animation
          // source and guarantees the final result repaints.
          setIsLoading(true);
          setSpinnerLabel(event.spinnerLabel);
          setSystemNotice({ tone: "info", title: event.title, body: event.message });
          return;
        case "command_output":
          // Slash-command output is a blocking panel: it pins above the input,
          // suppresses typing, and waits for Esc.
          setIsLoading(false);
          setSystemNotice({ ...buildCommandNotice(event.message, event.kind), dismissable: true });
          return;
        case "notice":
          // Transient feedback that never hides the input.
          setSystemNotice({ tone: event.tone, title: event.title, body: event.body });
          return;
        case "command_view":
          switch (event.view.type) {
            case "resume_picker":
              setResumePicker(event.view.sessions);
              setResumePickerIndex(0);
              return;
            case "diff":
              setDiffView(event.view.data);
              return;
            case "memory_picker":
              setMemoryPicker(event.view.items);
              setMemoryPickerIndex(0);
              return;
            case "permissions":
              setPermissionView(event.view.data);
              return;
            case "plugins":
              setIsLoading(false);
              setSystemNotice(null);
              setPluginView(event.view.data);
              return;
          }
          return;
        case "editor_requested": {
          const launcher = openEditorRef.current;
          if (!launcher) {
            setSystemNotice({
              tone: "error",
              title: "Cannot open editor",
              body: "No editor handler is available in this session.",
            });
            return;
          }
          void launcher(event.filePath).then((result) => {
            setSystemNotice(
              result.ok
                ? { tone: "info", title: "Memory file saved", body: `Edited ${event.label}\n${event.filePath}` }
                : {
                    tone: "error",
                    title: "Editor did not complete",
                    body: result.error ?? "Unknown error opening the editor.",
                  },
            );
          });
          return;
        }
        case "compacted":
          setSystemNotice(compactionNotice(event.trigger));
          return;
        case "model_changed":
          setCurrentModel(event.model);
          return;
        case "mode_changed":
          setActivePermissionMode(event.mode);
          setSystemNotice(modeChangeNotice(event.mode));
          return;
        case "task_mode_changed":
          setTaskModeState(event.mode);
          return;
        case "todos_changed":
          setTodosState(event.todos);
          return;
        case "tasks_changed":
          setTasksState(event.tasks);
          return;
        case "background_agents_changed":
          setAsyncAgents(event.agents);
          return;
        case "session_cleared":
          cancelPendingText();
          setMessages([]);
          setStreamingText("");
          setToolCalls([]);
          setLastUsage(null);
          clearUiNotices();
          // Wipe the terminal so the previous conversation is gone from the
          // screen and scrollback; the live frame Ink restores afterwards is
          // the empty post-clear UI.
          writeStdoutRef.current?.(CLEAR_TERMINAL);
          return;
        case "session_replaced": {
          // `/resume <id>` moved the conversation to another session: use the
          // new handle from now on (this listener keeps receiving events).
          sessionRef.current = runtime.getSession(event.sessionId) ?? sessionRef.current;
          cancelPendingText();
          setStreamingText("");
          setToolCalls([]);
          clearUiNotices();
          setResumePicker(null);
          setDiffView(null);
          setMemoryPicker(null);
          setPermissionView(null);
          // Repaint the restored conversation cleanly. Ink's <Static> only
          // resets its print cursor when the item count DROPS, so we blank the
          // list first (commit 1 → Static resets), wipe the terminal, then
          // restore the messages on a later tick (commit 2 → Static reprints
          // from a clean slate).
          setMessages([]);
          setTotalUsage({ input: event.totalUsage.input_tokens, output: event.totalUsage.output_tokens });
          setLastUsage(null);
          writeStdoutRef.current?.(CLEAR_TERMINAL);
          const restoredMessages = event.messages;
          setTimeout(() => setMessages(restoredMessages), 0);
          return;
        }
        case "request_opened": {
          const { request } = event;
          if (request.kind === "question") {
            questionRequestRef.current = request;
            setSpinnerLabel("Waiting for your answer");
            setQuestionPrompt({ questions: request.questions });
            return;
          }
          permissionRequestRef.current = request;
          const isPlanExit = request.kind === "plan_approval";
          setSpinnerLabel(isPlanExit ? "Waiting for plan approval" : "Waiting for permission");
          setPermissionPrompt({
            toolName: request.toolName,
            summary: request.summary,
            risk: request.risk,
            ruleHint: request.ruleHint,
            input: request.input,
            isPlanExit,
            planContent: isPlanExit ? (request.planContent ?? undefined) : undefined,
            planFilePath: isPlanExit ? request.planFilePath : undefined,
          });
          return;
        }
        case "request_resolved":
          if (permissionRequestRef.current?.id === event.requestId) {
            permissionRequestRef.current = null;
            setPermissionPrompt(null);
          }
          if (questionRequestRef.current?.id === event.requestId) {
            questionRequestRef.current = null;
            setQuestionPrompt(null);
          }
          return;
        case "token_warning": {
          const notice = tokenWarningNotice(event.warning);
          if (notice) setSystemNotice(notice);
          return;
        }
        case "api_retry":
          // Backing off before a retry: show the countdown so the user knows
          // we're retrying, not hung.
          setSpinnerLabel("Retrying");
          setSystemNotice(apiRetryNotice(event));
          return;
        case "stream_restart":
          // The turn re-runs (max_tokens escalation or reactive compact); drop
          // partially streamed text so the re-run renders cleanly.
          cancelPendingText();
          setStreamingText("");
          if (event.reason === "reactive_compact") {
            setSystemNotice({
              tone: "info",
              title: "Context compacted",
              body: "The prompt exceeded the context window — history was summarized and the request retried.",
            });
          }
          return;
        case "error":
          setSystemNotice({ tone: "error", title: "Agent error", body: event.message });
          return;
      }
    },
    [runtime, cancelPendingText, flushPendingText, closeInteractionDialogs],
  );

  // A malformed settings.json degrades to "ignored" rather than crashing the
  // CLI — surface a single non-fatal notice so the user knows their config
  // isn't being applied and where to fix it.
  useEffect(() => {
    void loadSettingsDiagnostics(runtime.cwd)
      .then((errors) => {
        if (errors.length === 0) return;
        setSystemNotice({
          tone: "error",
          title: "Some settings were ignored",
          body: [...errors, "", "Fix the file(s) above; the rest of your config still applies."].join("\n"),
        });
      })
      .catch(() => {});
  }, [runtime]);

  // ─── Open (or resume) the session ───────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    let opened: AgentSession | null = null;
    const options = {
      model,
      defaultMaxTurns: INTERACTIVE_DEFAULT_MAX_TURNS,
      ...(permissionMode ? { permissionMode } : {}),
    };

    void (async () => {
      try {
        const session = shouldResume
          ? await runtime.resumeSession(resumeSessionId ?? undefined, options)
          : await runtime.createSession(options);
        if (cancelled) {
          void session.close();
          return;
        }
        opened = session;
        sessionRef.current = session;
        unsubscribe = session.subscribe(handleEvent);
        if (shouldResume) {
          const state = session.getState();
          setTotalUsage({ input: state.usage.total.input_tokens, output: state.usage.total.output_tokens });
          setSystemNotice({
            tone: "info",
            title: "Session restored",
            body: `Resumed session ${session.id} with ${state.messages.length} messages.`,
          });
        }
        setCurrentModel(model);
      } catch (error: unknown) {
        if (cancelled) return;
        setSystemNotice({
          tone: "error",
          title: isAgentSdkError(error, "permission_settings") ? "Permission settings error" : "Session restore error",
          body: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
      // `/resume` may have replaced the handle; close whichever is current.
      const current = sessionRef.current;
      if (current && opened) void current.close();
      sessionRef.current = null;
    };
  }, [runtime, model, permissionMode, resumeSessionId, shouldResume, handleEvent]);

  // ─── Actions ────────────────────────────────────────────────────────────

  const interrupt = useCallback(() => {
    const outcome = sessionRef.current?.interrupt() ?? "idle";
    switch (outcome) {
      case "permission_denied":
        permissionRequestRef.current = null;
        setPermissionPrompt(null);
        setSystemNotice({ tone: "info", title: "Permission request cancelled", body: EXIT_HINT });
        break;
      case "question_cancelled":
        // The tool receives a "declined to answer" result.
        questionRequestRef.current = null;
        setQuestionPrompt(null);
        setSystemNotice({ tone: "info", title: "Question cancelled", body: EXIT_HINT });
        break;
      case "idle":
        setSystemNotice({ tone: "info", title: "Nothing to interrupt", body: EXIT_HINT });
        break;
      case "turn_aborted":
        setIsLoading(false);
        cancelPendingText();
        setStreamingText("");
        setSystemNotice(INTERRUPTED_NOTICE);
        break;
    }
    return true;
  }, [cancelPendingText]);

  const resolvePermission = useCallback((decision: PermissionDecision, feedback?: string) => {
    const request = permissionRequestRef.current;
    const session = sessionRef.current;
    if (!request || !session) return false;
    if (session.respond(request.id, toResponse(request, decision, feedback)) === "stale") return false;

    permissionRequestRef.current = null;
    setPermissionPrompt(null);

    if (decision === "deny" && feedback) {
      setSystemNotice({ tone: "info", title: "Plan rejected with feedback", body: `Feedback: ${feedback}` });
    } else if (decision === "deny") {
      setSystemNotice({ tone: "error", title: "Permission denied", body: "Permission denied." });
    } else if (decision === "allow_clear_context") {
      setSystemNotice({
        tone: "info",
        title: "Plan approved",
        body: "Plan approved. Edits auto-accepted. Context will be cleared for implementation.",
      });
    } else if (decision === "allow_accept_edits") {
      setSystemNotice({
        tone: "info",
        title: "Plan approved",
        body: "Plan approved. Edits auto-accepted. Continuing with current context.",
      });
    }
    return true;
  }, []);

  // Resolve the open AskUserQuestion with the user's selections (or null to cancel).
  const resolveQuestion = useCallback((response: UserQuestionResponse | null): boolean => {
    const request = questionRequestRef.current;
    const session = sessionRef.current;
    if (!request || !session) return false;
    if (session.respond(request.id, response ? { answers: response.answers } : { cancelled: true }) === "stale") {
      return false;
    }
    questionRequestRef.current = null;
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

  /** Run a shell command typed as `!cmd`; output lands in a notice. */
  const runShell = useCallback(async (session: AgentSession, command: string) => {
    setSystemNotice({ tone: "info", title: `! ${command}`, body: "running…" });
    try {
      const result = await session.runShell(command);
      const raw = extractBashOutput(result.output) || "(no output)";
      const lines = raw.split("\n");
      const body =
        lines.length > SHELL_OUTPUT_LINES
          ? [...lines.slice(0, SHELL_OUTPUT_LINES), `… +${lines.length - SHELL_OUTPUT_LINES} more lines`].join("\n")
          : raw;
      setSystemNotice({ tone: result.isError ? "error" : "info", title: `! ${command}`, body });
    } catch (error) {
      setSystemNotice({
        tone: "error",
        title: `! ${command}`,
        body: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const submit = useCallback(
    async (text: string): Promise<SubmitResult> => {
      const trimmed = text.trim();
      if (!trimmed) {
        const session = sessionRef.current;
        if (!session || session.getState().busy) return { handled: false };
        const result = await session.send("").catch(() => ({ handled: true }));
        return { handled: result.handled };
      }

      if (trimmed === "/exit" || trimmed === "/quit" || trimmed === "/bye") {
        onExit();
        return { handled: true };
      }

      const session = sessionRef.current;
      if (!session) {
        setSystemNotice({
          tone: "error",
          title: "QueryEngine is not ready",
          body: "Please wait for initialization to finish.",
        });
        return { handled: true };
      }

      // Bash mode (`!cmd`): run a shell command directly, bypassing the LLM —
      // a quick local escape hatch that still honors the sandbox settings.
      if (trimmed.startsWith("!")) {
        const command = trimmed.slice(1).trim();
        if (command) await runShell(session, command);
        return { handled: true };
      }

      // One submission at a time. A turn the session started on its own (a
      // background wake-up) finishes before this input runs.
      const run = submitChainRef.current.then(async () => {
        for (;;) {
          const current = sessionRef.current;
          if (!current) return;
          await current.waitForIdle();
          try {
            await current.send(trimmed);
            return;
          } catch (error) {
            // Lost a race with a wake-up turn: wait for it and retry. Turn
            // failures are already reported through `turn_failed`.
            if (!isAgentSdkError(error, "busy")) return;
          }
        }
      });
      submitChainRef.current = run.catch(() => {});
      await run;
      return { handled: true };
    },
    [onExit, runShell],
  );

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
      pluginView,
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
      // Thinking and effort as the next request will use them, for the selectors.
      getThinkingSettings: () => {
        const state = sessionRef.current?.getState();
        return { enabled: state ? state.thinking.type !== "disabled" : true, effort: state?.effort ?? undefined };
      },
      stopBackgroundAgent: (agentId: string) => sessionRef.current?.stopBackgroundAgent(agentId) ?? false,
      // Resume-picker controls, driven by useResumePicker.
      moveResumePicker: (nextIndex: number) => setResumePickerIndex(nextIndex),
      closeResumePicker: () => setResumePicker(null),
      // Selecting a session closes the picker and re-invokes `/resume <id>`.
      confirmResume: (sessionId: string) => {
        setResumePicker(null);
        void submit(`/resume ${sessionId}`);
      },
      // Memory-picker controls, driven by useMemoryPicker.
      moveMemoryPicker: (nextIndex: number) => setMemoryPickerIndex(nextIndex),
      closeMemoryPicker: () => setMemoryPicker(null),
      // Selecting a file closes the picker and re-invokes `/memory edit <n>`.
      confirmMemoryEdit: (pickIndex: number) => {
        setMemoryPicker(null);
        void submit(`/memory edit ${pickIndex + 1}`);
      },
      // Permission-manager controls. Mutations write + reload through the
      // session and feed back the fresh view so the overlay stays open.
      closePermissions: () => setPermissionView(null),
      closePlugins: () => setPluginView(null),
      // Plugin-manager actions; rejections propagate so the overlay can show the reason.
      pluginMutate: async (action: PluginMutation): Promise<void> => {
        const session = sessionRef.current;
        if (!session) return;
        setPluginView(await session.mutatePlugin(action));
      },
      pluginPreview: async (pluginId: string): Promise<PluginInstallPreview> => {
        const session = sessionRef.current;
        if (!session) throw new Error("Plugin manager is not ready.");
        return session.previewPlugin(pluginId);
      },
      permissionMutate: (op: "allow" | "deny" | "remove", rule: string, scope: SettingSource) => {
        const session = sessionRef.current;
        if (!session) return;
        void session
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
