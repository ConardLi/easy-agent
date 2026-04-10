import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { QueryEngine } from "../../core/queryEngine.js";
import {
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
  shouldResume?: boolean;
  resumeSessionId?: string | null;
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
        "/history  Show saved sessions for this project",
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

  const permissionResolverRef = useRef<((decision: PermissionDecision) => void) | null>(null);
  const sessionRulesRef = useRef<PermissionRuleSet>({ allow: [], deny: [] });
  const engineRef = useRef<QueryEngine | null>(null);
  const sessionIdRef = useRef<string>(createSessionId());
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

        engineRef.current = new QueryEngine({
          model,
          toolContext,
          initialMessages,
          initialUsage,
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
      await appendTranscriptEntry(toolContext.cwd, sessionIdRef.current, {
        type: "message",
        timestamp: new Date().toISOString(),
        role: "user",
        message: { role: "user", content: trimmed },
      });
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
          case "tool_use_done":
            setToolCalls((prev) =>
              markToolCallComplete(prev, value.name, value.result.content.length, value.result.isError),
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
          case "assistant_message":
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

    return { handled: true };
  }, [onExit, toolContext.cwd]);

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
