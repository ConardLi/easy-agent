/**
 * Step 2 - React/Ink interactive REPL
 *
 * Goal:
 * - turn the one-shot streaming client from Step 1 into an interactive terminal UI
 * - keep multi-turn messages in memory
 * - render spinner, streaming text, usage, errors, and local slash commands declaratively
 * - support Ctrl+C interruption and Ctrl+D exit
 *
 * This single-file snapshot mirrors the article's UI shape without pulling in
 * later-stage features such as real tool execution, permissions, or sessions.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import { DEFAULT_MODEL, streamMessage } from "./step1.js";

const h = React.createElement;
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// -----------------------------------------------------------------------------
// 1. Small content helpers
// -----------------------------------------------------------------------------

export function textMessage(role, content) {
  return { role, content };
}

export function extractAssistantText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block?.type === "text")
    .map((block) => block.text || "")
    .join("");
}

export function appendMessage(messages, message) {
  return [...messages, message];
}

export function formatUsage(usage) {
  if (!usage) return "";
  return `tokens: ${usage.input} in / ${usage.output} out`;
}

// -----------------------------------------------------------------------------
// 2. Spinner component
// -----------------------------------------------------------------------------

export function Spinner({ label = "Thinking" }) {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  return h(Text, { dimColor: true }, `${FRAMES[frameIndex]} ${label}...`);
}

// -----------------------------------------------------------------------------
// 3. Streaming turn
// -----------------------------------------------------------------------------

export async function runStreamingTurn({
  messages,
  model = DEFAULT_MODEL,
  system,
  signal,
  stream = streamMessage,
  onText = () => {},
  onToolUse = () => {},
  onError = () => {},
}) {
  const generator = stream({ messages: [...messages], model, system, signal });
  let accumulatedText = "";

  while (true) {
    const { value, done } = await generator.next();
    if (done) return value ?? null;

    if (value.type === "text") {
      accumulatedText += value.text;
      onText(accumulatedText);
    }

    if (value.type === "tool_use_start") {
      onToolUse({ id: value.id, name: value.name });
    }

    if (value.type === "error") {
      onError(value.error);
      return null;
    }
  }
}

// -----------------------------------------------------------------------------
// 4. Local slash commands
// -----------------------------------------------------------------------------

export function handleLocalCommand(text, api) {
  const trimmed = text.trim();

  if (trimmed === "/exit" || trimmed === "/quit") {
    api.exit();
    return true;
  }

  if (trimmed === "/clear") {
    api.setMessages([]);
    api.setInfoMessage("Conversation cleared.");
    return true;
  }

  if (trimmed === "/history") {
    api.setInfoMessage(`${api.getMessages().length} messages in conversation.`);
    return true;
  }

  return false;
}

// -----------------------------------------------------------------------------
// 5. Main Ink app
// -----------------------------------------------------------------------------

export function App({ model = DEFAULT_MODEL, system, stream = streamMessage }) {
  const { exit } = useApp();
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [spinnerLabel, setSpinnerLabel] = useState("Thinking");
  const [streamingText, setStreamingText] = useState("");
  const [toolCalls, setToolCalls] = useState([]);
  const [lastUsage, setLastUsage] = useState(null);
  const [infoMessage, setInfoMessage] = useState(null);
  const [errorText, setErrorText] = useState(null);

  const abortRef = useRef(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const submitMessage = useCallback(
    async (rawText) => {
      const text = rawText.trim();
      if (!text) return;

      const handled = handleLocalCommand(text, {
        exit,
        setMessages(next) {
          messagesRef.current = next;
          setMessages(next);
        },
        setInfoMessage,
        getMessages() {
          return messagesRef.current;
        },
      });
      if (handled) return;

      setStreamingText("");
      setToolCalls([]);
      setErrorText(null);
      setInfoMessage(null);
      setLastUsage(null);
      setIsLoading(true);
      setSpinnerLabel("Thinking");

      const abort = new AbortController();
      abortRef.current = abort;

      const userMessage = textMessage("user", text);
      const nextMessages = appendMessage(messagesRef.current, userMessage);
      messagesRef.current = nextMessages;
      setMessages(nextMessages);

      try {
        const result = await runStreamingTurn({
          messages: nextMessages,
          model,
          system,
          stream,
          signal: abort.signal,
          onText: setStreamingText,
          onToolUse(toolCall) {
            setToolCalls((prev) => [...prev, toolCall]);
            setSpinnerLabel(`Using ${toolCall.name}`);
          },
          onError(error) {
            setErrorText(error?.message || String(error));
          },
        });

        if (!result || abort.signal.aborted) return;

        const finalMessages = appendMessage(nextMessages, result.assistantMessage);
        messagesRef.current = finalMessages;
        setMessages(finalMessages);
        setLastUsage({
          input: result.usage?.input_tokens || 0,
          output: result.usage?.output_tokens || 0,
        });
        setStreamingText("");
      } catch (error) {
        if (error?.name === "AbortError") {
          setInfoMessage("Interrupted.");
        } else {
          setErrorText(error instanceof Error ? error.message : String(error));
        }
      } finally {
        abortRef.current = null;
        setIsLoading(false);
      }
    },
    [exit, model, stream, system],
  );

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
        setIsLoading(false);
        setStreamingText("");
        setInfoMessage("Interrupted.");
      }
      return;
    }

    if (key.ctrl && input === "d") {
      exit();
      return;
    }

    if (isLoading) return;

    if (key.return) {
      const submitted = inputValue;
      setInputValue("");
      void submitMessage(submitted);
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

  return h(
    Box,
    { flexDirection: "column", paddingX: 1 },
    h(
      Box,
      { marginBottom: 1 },
      h(Text, { bold: true, color: "cyan" }, "Easy Agent"),
      h(Text, { dimColor: true }, ` (${model})`),
    ),
    h(Text, { dimColor: true }, "Type a message to start. Ctrl+C to interrupt, Ctrl+D to exit."),
    ...messages.map((message, index) => renderMessage(message, index)),
    ...toolCalls.map((toolCall, index) =>
      h(Box, { key: `tool-${index}`, marginLeft: 2 }, h(Text, { color: "yellow" }, `Using tool: ${toolCall.name}`)),
    ),
    isLoading && !streamingText ? h(Spinner, { label: spinnerLabel }) : null,
    isLoading && streamingText
      ? h(Box, null, h(Text, { color: "magenta" }, "▎ "), h(Text, null, streamingText))
      : null,
    errorText ? h(Text, { color: "red" }, `x ${errorText}`) : null,
    infoMessage ? h(Text, { dimColor: true }, `  ${infoMessage}`) : null,
    lastUsage && !isLoading ? h(Text, { dimColor: true }, `  ${formatUsage(lastUsage)}`) : null,
    !isLoading
      ? h(Box, { marginTop: 1 }, h(Text, { color: "green", bold: true }, "> "), h(Text, null, inputValue), h(Text, { dimColor: true }, "▋"))
      : null,
  );
}

function renderMessage(message, index) {
  if (message.role === "user" && typeof message.content === "string") {
    return h(
      Box,
      { key: `user-${index}`, marginTop: 1 },
      h(Text, { color: "green", bold: true }, "> "),
      h(Text, null, message.content),
    );
  }

  if (message.role === "assistant") {
    const text = extractAssistantText(message);
    if (!text) return null;
    return h(Box, { key: `assistant-${index}` }, h(Text, { color: "magenta" }, "▎ "), h(Text, null, text));
  }

  return null;
}

// -----------------------------------------------------------------------------
// 6. CLI bootstrap
// -----------------------------------------------------------------------------

export function runRepl({ model = DEFAULT_MODEL, system, stream = streamMessage } = {}) {
  const instance = render(h(App, { model, system, stream }));
  return instance.waitUntilExit();
}

export function parseCliArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { mode: "help" };
  if (argv.includes("--version") || argv.includes("-v")) return { mode: "version" };

  const modelIndex = argv.indexOf("--model");
  return {
    mode: "repl",
    model: modelIndex === -1 ? DEFAULT_MODEL : argv[modelIndex + 1] || DEFAULT_MODEL,
  };
}

// -----------------------------------------------------------------------------
// 7. Non-interactive demo for this step file
// -----------------------------------------------------------------------------

export async function demoStep2() {
  async function* fakeStream() {
    yield { type: "text", text: "Hello" };
    yield { type: "text", text: ", terminal" };
    return {
      assistantMessage: { role: "assistant", content: [{ type: "text", text: "Hello, terminal" }] },
      usage: { input_tokens: 12, output_tokens: 4 },
      stopReason: "end_turn",
    };
  }

  let streaming = "";
  const messages = [textMessage("user", "hi")];
  const result = await runStreamingTurn({
    messages,
    stream: fakeStream,
    onText(text) {
      streaming = text;
    },
  });

  const finalMessages = appendMessage(messages, result.assistantMessage);
  const commandState = { messages: finalMessages, info: "" };
  handleLocalCommand("/history", {
    exit() {},
    setMessages(next) {
      commandState.messages = next;
    },
    setInfoMessage(text) {
      commandState.info = text;
    },
    getMessages() {
      return commandState.messages;
    },
  });

  return {
    streaming,
    assistant: extractAssistantText(result.assistantMessage),
    usage: formatUsage({ input: result.usage.input_tokens, output: result.usage.output_tokens }),
    historyInfo: commandState.info,
    parsedModel: parseCliArgs(["--model", "claude"]).model,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  demoStep2().then((result) => console.log(JSON.stringify(result, null, 2)));
}
