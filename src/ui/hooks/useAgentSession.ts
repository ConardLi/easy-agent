import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { QueryEngine } from "../../core/queryEngine.js";
import {
  loadPermissionSettings,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRequest,
  type PermissionRuleSet,
  type PermissionSettings,
} from "../../permissions/permissions.js";
import type { ToolContext } from "../../tools/Tool.js";
import type {
  PermissionPromptState,
  SystemNotice,
  ToolCallInfo,
  UsageSummary,
} from "../types.js";

interface UseAgentSessionOptions {
  model: string;
  onExit: () => void;
  permissionMode?: PermissionMode;
}

interface SubmitResult {
  handled: boolean;
}

function markToolCallComplete(
  toolCalls: ToolCallInfo[],
  name: string,
  resultLength: number,
  isError?: boolean,
): ToolCallInfo[] {
  return toolCalls.map((toolCall) =>
    toolCall.name === name && toolCall.resultLength === undefined
      ? { ...toolCall, resultLength, isError }
      : toolCall,
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
        "/history  Show message count",
        "/exit | /quit | /bye  Exit session",
      ].join("\n"),
    };
  }

  if (message.startsWith("Session usage")) {
    return {
      tone: kind,
      title: "Session usage",
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

export function useAgentSession({ model, onExit, permissionMode }: UseAgentSessionOptions) {
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

  const permissionResolverRef = useRef<((decision: PermissionDecision) => void) | null>(null);
  const sessionRulesRef = useRef<PermissionRuleSet>({ allow: [], deny: [] });
  const engineRef = useRef<QueryEngine | null>(null);

  const toolContext = useMemo<ToolContext>(() => ({ cwd: process.cwd() }), []);

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
    engineRef.current = new QueryEngine({
      model,
      toolContext,
      permissionMode: permissionMode ?? permissionSettings.mode,
      permissionSettings,
      sessionPermissionRules: sessionRulesRef.current,
      onPermissionRequest: (request: PermissionRequest) => {
        setSpinnerLabel("Waiting for permission");
        setPermissionPrompt({
          toolName: request.toolName,
          summary: request.summary,
          risk: request.risk,
          ruleHint: request.ruleHint,
        });
        return new Promise<PermissionDecision>((resolve) => {
          permissionResolverRef.current = resolve;
        });
      },
    });
    setCurrentModel(model);
  }, [model, permissionMode, permissionSettings, toolContext]);

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
    setStreamingText("");
    setSystemNotice({
      tone: "info",
      title: "Interrupted",
      body: "Use /exit, /quit, /bye, or Ctrl+D to exit.",
    });
    return true;
  }, []);

  const resolvePermission = useCallback((decision: PermissionDecision) => {
    if (!permissionResolverRef.current) return false;
    permissionResolverRef.current(decision);
    permissionResolverRef.current = null;
    setPermissionPrompt(null);
    setSystemNotice({
      tone: decision === "deny" ? "error" : "info",
      title: decision === "deny" ? "Permission denied" : "Permission granted",
      body:
        decision === "allow_always"
          ? "Permission granted and remembered for this session."
          : decision === "allow_once"
            ? "Permission granted once."
            : "Permission denied.",
    });
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

    setStreamingText("");
    setToolCalls([]);
    setSystemNotice(null);
    if (!isSlashCommand) {
      setLastUsage(null);
    }
    setPermissionPrompt(null);
    setIsLoading(!isSlashCommand);
    setSpinnerLabel("Thinking");

    try {
      const run = engineRef.current.submitMessage(trimmed);

      while (true) {
        const { value, done } = await run.next();
        if (done) {
          if (value.reason === "aborted") {
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
            setStreamingText((prev) => prev + value.text);
            break;
          case "tool_use_start":
            setToolCalls((prev) => [...prev, { name: value.name }]);
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
          case "tool_use_done":
            setToolCalls((prev) =>
              markToolCallComplete(prev, value.name, value.result.content.length, value.result.isError),
            );
            break;
          case "assistant_message":
            setStreamingText("");
            break;
          case "tool_result_message":
            setSpinnerLabel("Thinking");
            setPermissionPrompt(null);
            break;
          case "messages_updated":
            setMessages(value.messages);
            break;
          case "usage_updated":
            setLastUsage({
              input: value.turnUsage.input_tokens,
              output: value.turnUsage.output_tokens,
            });
            setTotalUsage({
              input: value.totalUsage.input_tokens,
              output: value.totalUsage.output_tokens,
            });
            break;
          case "command":
            setSystemNotice(buildCommandNotice(value.message, value.kind));
            break;
          case "model_changed":
            setCurrentModel(value.model);
            break;
          case "session_cleared":
            setMessages([]);
            setStreamingText("");
            setToolCalls([]);
            setLastUsage(null);
            break;
          case "turn_complete":
            if (value.reason === "max_turns") {
              setSystemNotice({
                tone: "error",
                title: "Maximum tool turns reached",
                body: `Reached maximum tool turns (${value.turnCount}).`,
              });
            }
            break;
          case "error":
            setSystemNotice({
              tone: "error",
              title: "Agent error",
              body: value.error.message,
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

    return { handled: true };
  }, [onExit]);

  return {
    state: {
      messages,
      isLoading,
      spinnerLabel,
      streamingText,
      toolCalls,
      lastUsage,
      totalUsage,
      systemNotice,
      permissionPrompt,
      permissionMode: permissionMode ?? permissionSettings?.mode ?? "default",
      currentModel,
    },
    actions: {
      submit,
      interrupt,
      resolvePermission,
    },
  };
}
