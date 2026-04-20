import { useCallback, useMemo, useState } from "react";
import { useInput } from "ink";
import type { PermissionDecision, PermissionMode } from "../../permissions/permissions.js";
import type { TaskMode } from "../../state/taskModeStore.js";
import type { CommandSuggestion } from "../types.js";

export interface ModeSuggestion {
  key: string;
  mode: PermissionMode;
  description: string;
  isCurrent: boolean;
  isSelected: boolean;
}

export interface TaskModeSuggestion {
  key: string;
  mode: TaskMode;
  description: string;
  isCurrent: boolean;
  isSelected: boolean;
}

interface UsePromptInputOptions {
  isLoading: boolean;
  hasPermissionPrompt: boolean;
  isPlanExitPrompt: boolean;
  permissionMode: string;
  taskMode: TaskMode;
  /**
   * Extra `/` commands to merge into the suggestion list. Used for the
   * skill-registered commands (`/<skill-name>`) so the user sees them
   * alongside built-ins like /help, /skills, /mcp. The caller computes
   * this from the live skill registry on every render so newly-loaded
   * skills appear without restarting the suggestion machinery.
   */
  extraCommands?: CommandSuggestion[];
  onSubmit: (text: string) => Promise<unknown> | unknown;
  onExit: () => void;
  onInterrupt: () => boolean;
  onPermissionDecision: (decision: PermissionDecision) => boolean;
}

const BUILTIN_COMMANDS: CommandSuggestion[] = [
  { name: "/help", description: "Show available commands" },
  { name: "/clear", description: "Clear conversation history" },
  { name: "/cost", description: "Show session token usage" },
  { name: "/model", description: "Inspect current model or override it for this session" },
  { name: "/mode", description: "Inspect or switch permission mode (default/plan/auto)" },
  { name: "/tasks", description: "Switch task tracking system (task=persistent V2, todo=session V1)" },
  { name: "/mcp", description: "Inspect / reconnect MCP servers" },
  { name: "/skills", description: "List loaded skills (user + project scope)" },
  { name: "/history", description: "Show saved sessions for this project" },
  { name: "/compact", description: "Compact the conversation context" },
  { name: "/exit", description: "Exit the session" },
];

const MODE_OPTIONS: { mode: PermissionMode; description: string }[] = [
  { mode: "default", description: "Confirm destructive operations" },
  { mode: "plan", description: "Read-only exploration, then plan" },
  { mode: "auto", description: "Auto-approve all operations" },
];

const TASK_MODE_OPTIONS: { mode: TaskMode; description: string }[] = [
  { mode: "task", description: "Persistent task graph (Task V2) — default" },
  { mode: "todo", description: "Session-memory todo list (TodoWrite V1)" },
];

export function usePromptInput({
  isLoading,
  hasPermissionPrompt,
  isPlanExitPrompt,
  permissionMode,
  taskMode,
  extraCommands,
  onSubmit,
  onExit,
  onInterrupt,
  onPermissionDecision,
}: UsePromptInputOptions) {
  const [inputValue, setInputValue] = useState("");
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(-1);
  const [selectedModeIndex, setSelectedModeIndex] = useState(-1);
  const [selectedTaskModeIndex, setSelectedTaskModeIndex] = useState(-1);

  const handleSubmit = useCallback(() => {
    const text = inputValue;
    setInputValue("");
    void onSubmit(text);
  }, [inputValue, onSubmit]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onInterrupt();
      return;
    }
    if (key.ctrl && input === "d") {
      onExit();
      return;
    }

    if (hasPermissionPrompt) {
      const normalized = input.toLowerCase();
      if (isPlanExitPrompt) {
        if (normalized === "y") {
          onPermissionDecision("allow_clear_context");
        } else if (normalized === "k") {
          onPermissionDecision("allow_once");
        } else if (normalized === "n") {
          onPermissionDecision("deny");
        }
      } else {
        if (normalized === "y") {
          onPermissionDecision("allow_once");
        } else if (normalized === "n") {
          onPermissionDecision("deny");
        } else if (normalized === "a") {
          onPermissionDecision("allow_always");
        }
      }
      return;
    }

    if (isLoading) return;

    // Command suggestions: arrow keys + Enter/Tab to select
    if (showCommandSuggestions) {
      if (key.upArrow) {
        setSelectedCommandIndex((prev) => (prev <= 0 ? filteredCommands.length - 1 : prev - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedCommandIndex((prev) => (prev >= filteredCommands.length - 1 ? 0 : prev + 1));
        return;
      }
      if ((key.return || key.tab) && selectedCommandIndex >= 0) {
        const selected = filteredCommands[selectedCommandIndex];
        if (selected) {
          setInputValue(selected.name + " ");
          setSelectedCommandIndex(-1);
          return;
        }
      }
    }

    // Mode selector: arrow keys + Enter + number shortcuts
    if (showModeSelector) {
      if (key.upArrow) {
        setSelectedModeIndex((prev) => (prev <= 0 ? MODE_OPTIONS.length - 1 : prev - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedModeIndex((prev) => (prev >= MODE_OPTIONS.length - 1 ? 0 : prev + 1));
        return;
      }
      if (key.return && selectedModeIndex >= 0) {
        const selected = MODE_OPTIONS[selectedModeIndex];
        if (selected) {
          setInputValue("");
          setSelectedModeIndex(-1);
          void onSubmit(`/mode ${selected.mode}`);
          return;
        }
      }
      if (input === "1" || input === "2" || input === "3") {
        const idx = Number(input) - 1;
        const selected = MODE_OPTIONS[idx];
        if (selected) {
          setInputValue("");
          setSelectedModeIndex(-1);
          void onSubmit(`/mode ${selected.mode}`);
          return;
        }
      }
    }

    // Task-system selector: same UX as the permission-mode one, just two
    // options. Typing `1` or `2` submits directly so the user can flip
    // systems in two keystrokes (`/tasks` → `1`).
    if (showTaskModeSelector) {
      if (key.upArrow) {
        setSelectedTaskModeIndex((prev) => (prev <= 0 ? TASK_MODE_OPTIONS.length - 1 : prev - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedTaskModeIndex((prev) => (prev >= TASK_MODE_OPTIONS.length - 1 ? 0 : prev + 1));
        return;
      }
      if (key.return && selectedTaskModeIndex >= 0) {
        const selected = TASK_MODE_OPTIONS[selectedTaskModeIndex];
        if (selected) {
          setInputValue("");
          setSelectedTaskModeIndex(-1);
          void onSubmit(`/tasks ${selected.mode}`);
          return;
        }
      }
      if (input === "1" || input === "2") {
        const idx = Number(input) - 1;
        const selected = TASK_MODE_OPTIONS[idx];
        if (selected) {
          setInputValue("");
          setSelectedTaskModeIndex(-1);
          void onSubmit(`/tasks ${selected.mode}`);
          return;
        }
      }
    }

    if (key.return) {
      handleSubmit();
      return;
    }
    if (key.backspace || key.delete) {
      setInputValue((prev) => prev.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setInputValue((prev) => prev + input);
    }
  });

  const showModeSelector = useMemo(() => {
    const trimmed = inputValue.trim().toLowerCase();
    const show = trimmed === "/mode" || trimmed === "/mode ";
    if (!show) {
      setSelectedModeIndex(-1);
    }
    return show;
  }, [inputValue]);

  const showTaskModeSelector = useMemo(() => {
    const trimmed = inputValue.trim().toLowerCase();
    const show = trimmed === "/tasks" || trimmed === "/tasks ";
    if (!show) {
      setSelectedTaskModeIndex(-1);
    }
    return show;
  }, [inputValue]);

  const filteredCommands = useMemo(() => {
    if (!inputValue.startsWith("/")) {
      return [];
    }
    const keyword = inputValue.trim().toLowerCase();
    // Built-ins first, then dynamic skill commands. We de-dupe by name so
    // a project-level skill that shadows a built-in (unlikely but possible
    // once users start naming their own skills) doesn't appear twice.
    const seen = new Set<string>();
    const merged: CommandSuggestion[] = [];
    for (const cmd of [...BUILTIN_COMMANDS, ...(extraCommands ?? [])]) {
      if (seen.has(cmd.name)) continue;
      seen.add(cmd.name);
      merged.push(cmd);
    }
    return merged.filter((item) => item.name.startsWith(keyword)).slice(0, 8);
  }, [inputValue, extraCommands]);

  const showCommandSuggestions = filteredCommands.length > 0 && !showModeSelector && !showTaskModeSelector;

  const commandSuggestions: CommandSuggestion[] = useMemo(() => {
    if (!showCommandSuggestions) {
      setSelectedCommandIndex(-1);
      return [];
    }
    return filteredCommands.map((item, i) => ({
      ...item,
      isSelected: i === selectedCommandIndex,
    }));
  }, [showCommandSuggestions, filteredCommands, selectedCommandIndex]);

  const modeSuggestions: ModeSuggestion[] = useMemo(() => {
    if (!showModeSelector) return [];
    return MODE_OPTIONS.map((opt, i) => ({
      key: String(i + 1),
      mode: opt.mode,
      description: opt.description,
      isCurrent: opt.mode === permissionMode,
      isSelected: i === selectedModeIndex,
    }));
  }, [showModeSelector, permissionMode, selectedModeIndex]);

  const taskModeSuggestions: TaskModeSuggestion[] = useMemo(() => {
    if (!showTaskModeSelector) return [];
    return TASK_MODE_OPTIONS.map((opt, i) => ({
      key: String(i + 1),
      mode: opt.mode,
      description: opt.description,
      isCurrent: opt.mode === taskMode,
      isSelected: i === selectedTaskModeIndex,
    }));
  }, [showTaskModeSelector, taskMode, selectedTaskModeIndex]);

  return {
    inputValue,
    setInputValue,
    commandSuggestions,
    modeSuggestions,
    taskModeSuggestions,
  };
}
