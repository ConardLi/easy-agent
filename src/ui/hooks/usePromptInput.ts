import { useCallback, useMemo, useState } from "react";
import { useInput } from "ink";
import type { PermissionDecision } from "../../permissions/permissions.js";
import type { CommandSuggestion } from "../types.js";

interface UsePromptInputOptions {
  isLoading: boolean;
  hasPermissionPrompt: boolean;
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
  { name: "/history", description: "Show message count" },
  { name: "/exit", description: "Exit the session" },
];

export function usePromptInput({
  isLoading,
  hasPermissionPrompt,
  onSubmit,
  onExit,
  onInterrupt,
  onPermissionDecision,
}: UsePromptInputOptions) {
  const [inputValue, setInputValue] = useState("");

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
      if (normalized === "y") {
        onPermissionDecision("allow_once");
      } else if (normalized === "n") {
        onPermissionDecision("deny");
      } else if (normalized === "a") {
        onPermissionDecision("allow_always");
      }
      return;
    }

    if (isLoading) return;

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

  const commandSuggestions = useMemo(() => {
    if (!inputValue.startsWith("/")) {
      return [];
    }

    const keyword = inputValue.trim().toLowerCase();
    return ALL_COMMANDS.filter((item) => item.name.startsWith(keyword)).slice(0, 6);
  }, [inputValue]);

  return {
    inputValue,
    setInputValue,
    commandSuggestions,
  };
}
