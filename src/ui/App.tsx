import React from "react";
import { spawnSync } from "node:child_process";
import { Box, Static, Text, useApp, useStdin, useStdout } from "ink";
import type { PermissionMode } from "../permissions/permissions.js";
import { BackgroundAgentBar } from "./components/BackgroundAgentBar.js";
import { CommandSuggestions } from "./components/CommandSuggestions.js";
import { FileSuggestions } from "./components/FileSuggestions.js";
import { StatusLine } from "./components/StatusLine.js";
import { useStatusLine } from "./hooks/useStatusLine.js";
import { flattenConversation, type ConversationItem } from "./components/ConversationView.js";
import { InputPrompt } from "./components/InputPrompt.js";
import { ModeSelector } from "./components/ModeSelector.js";
import { QuestionPrompt } from "./components/QuestionPrompt.js";
import { StatusBar } from "./components/StatusBar.js";
import { SystemPanel } from "./components/SystemPanel.js";
import { DiffView } from "./components/DiffView.js";
import { SessionPicker } from "./components/SessionPicker.js";
import { MemoryPicker } from "./components/MemoryPicker.js";
import { PermissionManager } from "./components/PermissionManager.js";
import { TaskList } from "./components/TaskList.js";
import { TeammatePicker } from "./components/TeammatePicker.js";
import { TeammateViewer } from "./components/TeammateViewer.js";
import { TodoList } from "./components/TodoList.js";
import { ToolCallList } from "./components/ToolCallList.js";
import { StartupNotices } from "./components/StartupNotices.js";
import { TranscriptOverlay } from "./components/TranscriptOverlay.js";
import { WelcomeBanner } from "./components/WelcomeBanner.js";
import { theme, glyph } from "./theme.js";
import { buildTranscriptLines } from "./utils/transcriptLines.js";
import { usePromptInput } from "./hooks/usePromptInput.js";
import { useQuestionPrompt } from "./hooks/useQuestionPrompt.js";
import { useTranscript } from "./hooks/useTranscript.js";
import { useAgentSession } from "./hooks/useAgentSession.js";
import { useResumePicker } from "./hooks/useResumePicker.js";
import { useMemoryPicker } from "./hooks/useMemoryPicker.js";
import { useTeammateNavigation } from "./hooks/useTeammateNavigation.js";
import { useTeammateView } from "./hooks/useTeammateViewState.js";
import { getAllUserInvocableSkills } from "../services/skills/registry.js";
import { getAllUserCommands } from "../commands/userCommands/registry.js";
import type { CommandSuggestion } from "./types.js";

const VERSION = "0.1.0";

interface AppProps {
  model: string;
  permissionMode?: PermissionMode;
  shouldResume?: boolean;
  resumeSessionId?: string | null;
}

export function App({ model, permissionMode, shouldResume, resumeSessionId }: AppProps): React.ReactNode {
  const { exit } = useApp();
  const { setRawMode, isRawModeSupported } = useStdin();
  const { write: writeStdout } = useStdout();

  // Stage 33: `/memory edit <n>` launches `$EDITOR` on a memory file. The App
  // owns the TTY, so it suspends Ink's raw mode, hands the terminal to the
  // editor (synchronous spawn — nothing else runs, so Ink can't repaint over
  // it), then restores raw mode and clears the screen so the live frame repaints
  // cleanly. Falls back to `vi` (POSIX) / `notepad` (Windows) when neither
  // $VISUAL nor $EDITOR is set.
  const openEditor = React.useCallback(
    async (filePath: string): Promise<{ ok: boolean; error?: string }> => {
      const editorCmd =
        process.env.VISUAL ||
        process.env.EDITOR ||
        (process.platform === "win32" ? "notepad" : "vi");
      const [cmd, ...preArgs] = editorCmd.split(/\s+/).filter(Boolean);
      if (!cmd) return { ok: false, error: "No editor configured ($EDITOR/$VISUAL)." };

      const clear = "\u001B[2J\u001B[3J\u001B[H";
      try {
        if (isRawModeSupported) setRawMode(false);
        writeStdout(clear);
        const res = spawnSync(cmd, [...preArgs, filePath], { stdio: "inherit" });
        if (isRawModeSupported) setRawMode(true);
        writeStdout(clear);
        if (res.error) return { ok: false, error: res.error.message };
        if (typeof res.status === "number" && res.status !== 0) {
          return { ok: false, error: `${editorCmd} exited with status ${res.status}.` };
        }
        return { ok: true };
      } catch (error) {
        if (isRawModeSupported) setRawMode(true);
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    [isRawModeSupported, setRawMode, writeStdout],
  );

  const { state, actions } = useAgentSession({ model, onExit: exit, permissionMode, shouldResume, resumeSessionId, openEditor });
  const isPlanExitActive = Boolean(state.permissionPrompt?.isPlanExit);

  // Surface the current in-progress item's activeForm via the global
  // StatusBar spinner. This mirrors source code behavior (Spinner.tsx:
  // `leaderVerb = currentTodo?.activeForm ?? randomVerb`) and keeps the
  // entire app at exactly ONE animation source — adding per-row spinners
  // caused severe flicker because every additional setInterval forces
  // another full terminal repaint cycle on top of streaming text.
  //
  // In task mode we read from the Task graph; in todo mode we keep the
  // V1 source. Either way, the spinner label comes from exactly one
  // place at a time.
  const inProgressTodo = state.todos.find((t) => t.status === "in_progress");
  const inProgressTask = state.tasks.find((t) => t.status === "in_progress");
  const effectiveSpinnerLabel = state.taskMode === "task"
    ? (inProgressTask?.activeForm ?? inProgressTask?.subject ?? state.spinnerLabel)
    : (inProgressTodo?.activeForm ?? state.spinnerLabel);
  // Pull skill `/<name>` commands from the live registry on every render
  // so newly activated conditional skills (e.g. test-reviewer after the
  // model reads a *.test.ts file) appear in the suggestion list without
  // the user having to restart. Computing inline is fine — the registry
  // is an in-memory Map and we only render on existing state changes.
  const skillCommands: CommandSuggestion[] = React.useMemo(
    () =>
      getAllUserInvocableSkills().map((skill) => ({
        name: `/${skill.name}`,
        tag: "skill",
        description:
          skill.description.length > 80
            ? `${skill.description.slice(0, 77)}…`
            : skill.description,
      })),
    // Re-derive whenever the message log grows — that's our cheap proxy
    // for "something happened that may have activated a skill". The list
    // is tiny so the cost is negligible.
    [state.messages.length, state.toolCalls.length],
  );

  // Stage 23: user-defined `/<name>` commands. Loaded once at startup so
  // a stable dependency array is fine here.
  const userCommands: CommandSuggestion[] = React.useMemo(
    () =>
      getAllUserCommands().map((cmd) => ({
        name: `/${cmd.name}`,
        tag: "local",
        description:
          cmd.description.length > 80
            ? `${cmd.description.slice(0, 77)}…`
            : cmd.description,
      })),
    [],
  );

  const extraCommands = React.useMemo(
    () => [...skillCommands, ...userCommands],
    [skillCommands, userCommands],
  );

  // A slash-command result panel (dismissable notice) pins above the input,
  // blocks typing, and waits for Esc. The /diff colorized panel shares the same
  // dismiss semantics, so it counts as an active command panel too.
  const commandPanelActive = Boolean(state.systemNotice?.dismissable) || Boolean(state.diffView);
  // Keyboard-owning overlays (handled by their own input hooks/components below):
  // while any is up the prompt input is hidden and keystrokes are swallowed.
  const resumePickerActive = Boolean(state.resumePicker);
  const memoryPickerActive = Boolean(state.memoryPicker);
  const permissionManagerActive = Boolean(state.permissionView);
  const overlayActive = resumePickerActive || memoryPickerActive || permissionManagerActive;

  const {
    inputValue,
    cursor,
    commandSuggestions,
    modeSuggestions,
    taskModeSuggestions,
    thinkSuggestions,
    effortSuggestions,
    fileSuggestions,
    selectedPermissionIndex,
    queued,
  } = usePromptInput({
    isLoading: state.isLoading,
    hasPermissionPrompt: Boolean(state.permissionPrompt) && !isPlanExitActive,
    hasQuestionPrompt: Boolean(state.questionPrompt),
    isPlanExitPrompt: false,
    permissionMode: state.permissionMode,
    taskMode: state.taskMode,
    extraCommands,
    hasTranscript: state.transcriptOpen,
    hasCommandPanel: commandPanelActive,
    onDismissCommandPanel: actions.dismissNotice,
    hasResumePicker: overlayActive,
    onSubmit: actions.submit,
    onExit: exit,
    onInterrupt: actions.interrupt,
    onPermissionDecision: actions.resolvePermission,
    onToggleTranscript: actions.toggleTranscript,
    onNotice: actions.showNotice,
  });

  // Status line (stage 24.5): context fed to an optional user-configured
  // `statusLine` command; falls back to the built-in segments when unset.
  const statusCwd = process.cwd();
  const { custom: statusLineCustom } = useStatusLine({
    model: state.currentModel,
    cwd: statusCwd,
    permissionMode: state.permissionMode,
    taskMode: state.taskMode,
    contextPercent: state.lastUsage?.contextPercent,
    tokens: state.lastUsage
      ? { input: state.lastUsage.input, output: state.lastUsage.output }
      : undefined,
  });

  // Ctrl+O transcript overlay (stage 24.1). Build the verbose, pre-wrapped
  // line array from the message log; useTranscript owns scrolling + close.
  const { stdout } = useStdout();
  const termCols = stdout?.columns ?? 80;
  const termRows = stdout?.rows ?? 24;
  // Overlay reserves 1 row for the header and 1 for the footer.
  const transcriptViewport = Math.max(1, termRows - 2);
  const transcriptLines = React.useMemo(
    () => (state.transcriptOpen ? buildTranscriptLines(state.messages, termCols - 2) : []),
    [state.transcriptOpen, state.messages, termCols],
  );
  const { scroll: transcriptScroll, search: transcriptSearch } = useTranscript({
    open: state.transcriptOpen,
    lines: transcriptLines,
    viewportHeight: transcriptViewport,
    onClose: actions.closeTranscript,
  });

  // AskUserQuestion dialog keyboard state machine. Active only while a
  // question is pending; resolves the awaiting tool call with the selection.
  const questionView = useQuestionPrompt({
    request: state.questionPrompt,
    onResolve: actions.resolveQuestion,
  });

  // Stage 21 — teammate-view state machine. `view.mode` ∈ {main,
  // selecting, viewing} controls whether the user is looking at the
  // main conversation, the picker overlay, or one teammate's
  // transcript. The keyboard hook below registers the Shift+↑/↓ /
  // Enter / Esc / 'k' bindings (mirrors source's
  // useBackgroundTaskNavigation).
  //
  // Disable navigation while a permission prompt is up — Esc on a
  // permission dialog must dismiss the dialog, not the teammate view.
  // Also disabled while the picker would have no targets (no running
  // teammates).
  const view = useTeammateView(state.asyncAgents);
  useTeammateNavigation({
    agents: state.asyncAgents,
    disabled: Boolean(state.permissionPrompt) || overlayActive,
  });

  // Stage 33 — `/resume` session picker keyboard handler. Owns ↑↓/Enter/Esc
  // only while the picker is open; selection re-invokes `/resume <id>`.
  useResumePicker({
    sessions: state.resumePicker,
    index: state.resumePickerIndex,
    disabled: Boolean(state.permissionPrompt) || Boolean(state.questionPrompt),
    onMove: actions.moveResumePicker,
    onSelect: (pickIndex) => {
      const picked = state.resumePicker?.[pickIndex];
      if (picked) actions.confirmResume(picked.sessionId);
    },
    onCancel: actions.closeResumePicker,
  });

  // Stage 33 — `/memory` file picker keyboard handler. Selection re-invokes
  // `/memory edit <n>` to launch $EDITOR.
  useMemoryPicker({
    items: state.memoryPicker,
    index: state.memoryPickerIndex,
    disabled: Boolean(state.permissionPrompt) || Boolean(state.questionPrompt),
    onMove: actions.moveMemoryPicker,
    onSelect: actions.confirmMemoryEdit,
    onCancel: actions.closeMemoryPicker,
  });
  const viewedAgent =
    view.mode === "viewing" && view.viewingAgentId
      ? state.asyncAgents.find((a) => a.agentId === view.viewingAgentId) ?? null
      : null;

  // Stage 24 foundation — committed conversation history, flattened into
  // append-only items so it can live in <Static> (rendered once, never
  // repainted). See flattenConversation for the append-only invariant.
  // Inline history is ALWAYS condensed (one-line `⎿` summaries). Full detail
  // lives in the Ctrl+O transcript overlay, so committed <Static> cards never
  // need to repaint.
  const conversationItems = React.useMemo<ConversationItem[]>(
    () => flattenConversation(state.messages),
    [state.messages],
  );

  // A welcome banner printed exactly once at the very top. It's the first
  // <Static> item, so Ink flushes it above the conversation. Captured from
  // the stable `model` prop on purpose — Static never repaints it.
  const staticItems = React.useMemo<ConversationItem[]>(() => {
    const banner: ConversationItem = {
      key: "welcome",
      element: (
        <WelcomeBanner model={model} version={VERSION} permissionMode={state.permissionMode} />
      ),
    };
    return [banner, ...conversationItems];
    // permissionMode is read for the startup chip only; <Static> never repaints
    // the banner, so a later mode change shows up in the footer, not here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationItems, model]);

  return (
    <Box flexDirection="column" paddingX={1}>
      {/*
        Committed history lives in <Static>: Ink flushes it ABOVE the live
        frame and never repaints it, so the conversation becomes part of the
        terminal's native scrollback instead of being re-blitted on every
        streaming tick. This is the root fix for the old "terminal refuses to
        scroll" behaviour. Everything below is the LIVE frame (todos, in-flight
        tools, streaming text, status, input) — small and cheap to repaint.

        NOTE: we deliberately do NOT remount <Static> via a key when the
        history shrinks (/clear, /compact). Remounting removes the old
        internal_static DOM node, and Ink's reconciler sets
        `rootNode.staticNode = undefined` on that removal — if the removal is
        committed after the new node is mounted, the static pointer ends up
        null and ALL subsequently appended history silently stops printing
        (this was the "output disappears after /clear" bug). Instead we rely
        on Ink's own <Static>: when `items.length` drops it resets its
        internal cursor via a layout effect, so appends after a shrink render
        correctly. The already-printed history stays in the terminal
        scrollback, which is the expected behaviour for an append-only log.
      */}
      <Static items={staticItems}>
        {(item) => (
          <Box key={item.key} flexDirection="column">
            {item.element}
          </Box>
        )}
      </Static>

      {/*
        Ctrl+O transcript overlay (stage 24.1). When open it REPLACES the whole
        live frame and fills the viewport (height = rows), so the condensed
        <Static> scrollback scrolls out of view and the user gets a dedicated,
        scrollable, verbose transcript — Claude's `app:toggleTranscript`.
      */}
      {state.transcriptOpen ? (
        <TranscriptOverlay
          lines={transcriptLines}
          scroll={transcriptScroll}
          viewportHeight={transcriptViewport}
          rows={termRows}
          search={transcriptSearch}
        />
      ) : (
        <>
          {/*
            Teammate view state machine:
              - viewing → show the teammate transcript viewer in the live frame
                (the committed history stays flushed above it).
              - main or selecting → todos/tasks + in-flight tool cards.
          */}
          {viewedAgent ? (
            <TeammateViewer agent={viewedAgent} />
          ) : (
            <>
              {state.taskMode === "task"
                ? <TaskList tasks={state.tasks} />
                : <TodoList todos={state.todos} />}
              <ToolCallList
                toolCalls={state.toolCalls}
                leadingMarginTop={state.toolCalls.length > 0 ? 1 : 0}
              />
            </>
          )}
          <SystemPanel notice={state.systemNotice} />
          <DiffView data={state.diffView} />
          {state.questionPrompt ? (
            <QuestionPrompt
              questions={state.questionPrompt.questions}
              questionIndex={questionView.questionIndex}
              highlight={questionView.highlight}
              selected={questionView.selected}
              textInput={questionView.textInput}
            />
          ) : null}
          <StatusBar
            isLoading={state.isLoading}
            spinnerLabel={effectiveSpinnerLabel}
            streamingText={state.streamingText}
            lastUsage={state.lastUsage}
            permissionPrompt={state.permissionPrompt}
            permissionOptionIndex={selectedPermissionIndex}
            onPlanDecision={actions.resolvePermission}
          />
          {view.mode === "selecting" ? (
            <TeammatePicker
              agents={state.asyncAgents}
              selectedAgentId={view.selectedAgentId}
            />
          ) : null}
          {state.resumePicker ? (
            <SessionPicker
              sessions={state.resumePicker}
              index={state.resumePickerIndex}
            />
          ) : null}
          {state.memoryPicker ? (
            <MemoryPicker
              items={state.memoryPicker}
              index={state.memoryPickerIndex}
              cwd={statusCwd}
            />
          ) : null}
          {state.permissionView ? (
            <PermissionManager
              data={state.permissionView}
              active={permissionManagerActive && !state.permissionPrompt && !state.questionPrompt}
              onMutate={actions.permissionMutate}
              onClose={actions.closePermissions}
            />
          ) : null}
          <StartupNotices />
          <BackgroundAgentBar agents={state.asyncAgents} />
          {state.asyncAgents.some((a) => a.status === "running") ? (
            <Text color={theme.muted}>  Shift+↑/↓ inspect teammates</Text>
          ) : null}
          {/* Queued messages typed mid-turn — sent FIFO as the turn(s) end. */}
          {queued.length > 0 ? (
            <Box flexDirection="column" marginTop={1} paddingX={1}>
              {queued.map((q, i) => (
                <Text key={i} color={theme.muted}>
                  {`${glyph.userCaret} `}
                  <Text color={theme.brandLight}>{q}</Text>
                  <Text color={theme.muted}>{"  (queued)"}</Text>
                </Text>
              ))}
            </Box>
          ) : null}
          {/* Input stays visible during a turn so the user can queue messages;
              a permission / question dialog or a command result panel hides it. */}
          <InputPrompt isLoading={Boolean(state.permissionPrompt) || Boolean(state.questionPrompt) || commandPanelActive || overlayActive} inputValue={inputValue} cursor={cursor} />
          <CommandSuggestions items={commandPanelActive || overlayActive ? [] : commandSuggestions} />
          <FileSuggestions items={fileSuggestions} />
          <ModeSelector items={modeSuggestions} />
          <ModeSelector
            items={taskModeSuggestions}
            title={`select task system (↑↓ navigate, Enter confirm, 1-${taskModeSuggestions.length || 2} shortcut)`}
          />
          <ModeSelector
            items={thinkSuggestions}
            title={`extended thinking (↑↓ navigate, Enter confirm, 1-${thinkSuggestions.length || 2} shortcut)`}
          />
          <ModeSelector
            items={effortSuggestions}
            title={`reasoning effort (↑↓ navigate, Enter confirm, 1-${effortSuggestions.length || 5} shortcut)`}
          />
          {/* Minimal footer by default; an extra row appears only when the user
              configures a `statusLine` command in settings.json. */}
          <StatusLine permissionMode={state.permissionMode} custom={statusLineCustom} />
        </>
      )}
    </Box>
  );
}
