import { useCallback, useMemo, useState } from "react";
import { useInput } from "ink";
import type { PermissionDecision, PermissionMode } from "../../permissions/permissions.js";
import type { CommandSuggestion } from "../types.js";

export interface ModeSuggestion {
  key: string;
  mode: PermissionMode;
  description: string;
  isCurrent: boolean;
  isSelected: boolean;
}

interface UsePromptInputOptions {
  isLoading: boolean;
  hasPermissionPrompt: boolean;
  isPlanExitPrompt: boolean;
  permissionMode: string;
  onSubmit: (text: string) => Promise<unknown> | unknown;
  onExit: () => void;
  onInterrupt: () => boolean;
  onPermissionDecision: (decision: PermissionDecision) => boolean;
}

const ALL_COMMANDS: CommandSuggestion[] = [
  { name: "/help", description: "Show available commands" },
  { name: "/clear", description: "Clear conversation history" },
  { name: "/cost", description: "Show session token usage" },
  { name: "/model", description: "Inspect current model or override it for this session" },
  { name: "/mode", description: "Inspect or switch permission mode (default/plan/auto)" },
  { name: "/history", description: "Show saved sessions for this project" },
  { name: "/compact", description: "Compact the conversation context" },
  { name: "/exit", description: "Exit the session" },
];

const MODE_OPTIONS: { mode: PermissionMode; description: string }[] = [
  { mode: "default", description: "Confirm destructive operations" },
  { mode: "plan", description: "Read-only exploration, then plan" },
  { mode: "auto", description: "Auto-approve all operations" },
];

export function usePromptInput({
  isLoading,
  hasPermissionPrompt,
  isPlanExitPrompt,
  permissionMode,
  onSubmit,
  onExit,
  onInterrupt,
  onPermissionDecision,
}: UsePromptInputOptions) {
  const [inputValue, setInputValue] = useState("");
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(-1);
  const [selectedModeIndex, setSelectedModeIndex] = useState(-1);

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

  const filteredCommands = useMemo(() => {
    if (!inputValue.startsWith("/")) {
      return [];
    }
    const keyword = inputValue.trim().toLowerCase();
    return ALL_COMMANDS.filter((item) => item.name.startsWith(keyword)).slice(0, 6);
  }, [inputValue]);

  const showCommandSuggestions = filteredCommands.length > 0 && !showModeSelector;

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

  return {
    inputValue,
    setInputValue,
    commandSuggestions,
    modeSuggestions,
  };
}
