import React from "react";
import { Box, Text, useApp } from "ink";
import type { PermissionMode } from "../permissions/permissions.js";
import { CommandSuggestions } from "./components/CommandSuggestions.js";
import { ConversationView } from "./components/ConversationView.js";
import { InputPrompt } from "./components/InputPrompt.js";
import { ModeSelector } from "./components/ModeSelector.js";
import { StatusBar } from "./components/StatusBar.js";
import { SystemPanel } from "./components/SystemPanel.js";
import { TaskList } from "./components/TaskList.js";
import { TodoList } from "./components/TodoList.js";
import { ToolCallList } from "./components/ToolCallList.js";
import { usePromptInput } from "./hooks/usePromptInput.js";
import { useAgentSession } from "./hooks/useAgentSession.js";
import { getAllUserInvocableSkills } from "../services/skills/registry.js";
import type { CommandSuggestion } from "./types.js";

interface AppProps {
  model: string;
  permissionMode?: PermissionMode;
  shouldResume?: boolean;
  resumeSessionId?: string | null;
}

export function App({ model, permissionMode, shouldResume, resumeSessionId }: AppProps): React.ReactNode {
  const { exit } = useApp();
  const { state, actions } = useAgentSession({ model, onExit: exit, permissionMode, shouldResume, resumeSessionId });
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

  const { inputValue, commandSuggestions, modeSuggestions, taskModeSuggestions } = usePromptInput({
    isLoading: state.isLoading,
    hasPermissionPrompt: Boolean(state.permissionPrompt) && !isPlanExitActive,
    isPlanExitPrompt: false,
    permissionMode: state.permissionMode,
    taskMode: state.taskMode,
    extraCommands: skillCommands,
    onSubmit: actions.submit,
    onExit: exit,
    onInterrupt: actions.interrupt,
    onPermissionDecision: actions.resolvePermission,
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">Easy Agent</Text>
        <Text dimColor> ({state.currentModel})</Text>
      </Box>
      <Text dimColor>Type a message to start. Ctrl+C to interrupt, Ctrl+D to exit.</Text>

      <ConversationView messages={state.messages} />
      {state.taskMode === "task"
        ? <TaskList tasks={state.tasks} />
        : <TodoList todos={state.todos} />}
      <ToolCallList toolCalls={state.toolCalls} />
      <SystemPanel notice={state.systemNotice} />
      <StatusBar
        isLoading={state.isLoading}
        spinnerLabel={effectiveSpinnerLabel}
        streamingText={state.streamingText}
        lastUsage={state.lastUsage}
        permissionPrompt={state.permissionPrompt}
        permissionMode={state.permissionMode}
        onPlanDecision={actions.resolvePermission}
      />
      <InputPrompt isLoading={state.isLoading || Boolean(state.permissionPrompt)} inputValue={inputValue} />
      <CommandSuggestions items={commandSuggestions} />
      <ModeSelector items={modeSuggestions} />
      <ModeSelector
        items={taskModeSuggestions}
        title={`select task system (↑↓ navigate, Enter confirm, 1-${taskModeSuggestions.length || 2} shortcut)`}
      />
    </Box>
  );
}
